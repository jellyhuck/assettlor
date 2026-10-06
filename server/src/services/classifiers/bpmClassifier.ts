import decode from 'audio-decode';
import MusicTempo from 'music-tempo';
import {
  BpmClassifierSettings,
  Asset,
  ClassifierAssetResult,
} from '../../../shared/types.js';
import {
  Classifier,
  ClassifierStep,
} from './types.js';
import fs from 'fs';
import {
  updateAssetMetadata,
  removeAssetTagsBySource,
  addAssetTags,
  getDatabase,
} from '../../db/database.js';
import { generateAudioThumbnail } from '../audio.js';

export const DEFAULT_BPM_SETTINGS: BpmClassifierSettings = {
  enabled: true,
  minBpm: 60,
  maxBpm: 200,
  minDurationSeconds: 1.0,
  maxAnalysisSeconds: 45.0,
  applyBpmTag: false,
  applyTempoTag: false,
};

export interface BpmIntermediateState {
  skipped: boolean;
  skipReason?: string;
  pcmData?: Float32Array;
  sampleRate?: number;
  duration?: number;
  bpm?: number | null;
  tempoDescription?: string;
  tagsAdded: string[];
  error?: string;
}

export function getTempoDescription(bpm: number): string {
  if (bpm < 80) return 'slow-tempo';
  if (bpm < 120) return 'moderate-tempo';
  if (bpm < 150) return 'fast-tempo';
  return 'uptempo';
}

/**
 * Step 1: Probe Audio
 * Validates audio format, duration against minimum thresholds, and ensures buffer presence.
 */
const probeStep: ClassifierStep<BpmClassifierSettings, BpmIntermediateState> = {
  id: 'probe-audio',
  name: 'Validate Audio & Duration',
  description: 'Validates audio format, buffer integrity, and duration thresholds.',
  execute: ({ asset, buffer, settings, intermediate }) => {
    if (asset.category !== 'audio') {
      intermediate.skipped = true;
      intermediate.skipReason = `Asset category is "${asset.category}", expected "audio"`;
      return false;
    }

    if (!buffer || buffer.length === 0) {
      intermediate.skipped = true;
      intermediate.skipReason = 'Audio buffer could not be loaded or is empty';
      return false;
    }

    if (
      asset.metadata.duration !== undefined &&
      asset.metadata.duration > 0 &&
      asset.metadata.duration < settings.minDurationSeconds
    ) {
      intermediate.skipped = true;
      intermediate.skipReason = `Audio duration (${asset.metadata.duration.toFixed(2)}s) is shorter than minimum threshold (${settings.minDurationSeconds}s)`;
      return false;
    }
  },
};

/**
 * Step 2: Decode PCM
 * Decodes compressed audio into normalized Float32 PCM samples, downmixes to mono, and windows analysis length.
 */
const decodeStep: ClassifierStep<BpmClassifierSettings, BpmIntermediateState> = {
  id: 'decode-pcm',
  name: 'Decode Signal to PCM',
  description: 'Decodes audio stream into raw linear 32-bit float PCM data.',
  execute: async ({ buffer, settings, intermediate }) => {
    if (!buffer) return false;

    let decoded: { channelData?: Float32Array[]; sampleRate?: number };
    try {
      decoded = await decode(buffer);
    } catch (err: any) {
      intermediate.skipped = true;
      intermediate.skipReason = `Audio decoding failed: ${err?.message || 'unknown error'}`;
      return false;
    }

    if (!decoded || !decoded.channelData || decoded.channelData.length === 0) {
      intermediate.skipped = true;
      intermediate.skipReason = 'Decoded audio returned no channel data';
      return false;
    }

    const sampleRate = decoded.sampleRate || 44100;
    let monoPcm: Float32Array;

    if (decoded.channelData.length === 1) {
      monoPcm = decoded.channelData[0];
    } else {
      // Downmix multi-channel to mono
      const ch0 = decoded.channelData[0];
      const ch1 = decoded.channelData[1];
      const len = Math.min(ch0.length, ch1.length);
      monoPcm = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        monoPcm[i] = (ch0[i] + ch1[i]) * 0.5;
      }
    }

    // Limit maximum analysis window to conserve CPU for long tracks
    const maxSamples = Math.floor(sampleRate * (settings.maxAnalysisSeconds || 45));
    if (monoPcm.length > maxSamples) {
      monoPcm = monoPcm.slice(0, maxSamples);
    }

    intermediate.pcmData = monoPcm;
    intermediate.sampleRate = sampleRate;
    intermediate.duration = monoPcm.length / sampleRate;
  },
};

/**
 * Step 3: Analyze Tempo
 * Runs spectral onset peak detection and beat estimation.
 */
const analyzeStep: ClassifierStep<BpmClassifierSettings, BpmIntermediateState> = {
  id: 'analyze-tempo',
  name: 'Detect Tempo & Rhythm',
  description: 'Performs onset peak detection, autocorrelation, and calculates beats per minute.',
  execute: ({ settings, intermediate }) => {
    if (!intermediate.pcmData || !intermediate.sampleRate) return false;

    try {
      const calc = new MusicTempo(intermediate.pcmData, {
        sampleRate: intermediate.sampleRate,
      });

      const parsedTempo = Number(calc.tempo);
      if (!isNaN(parsedTempo) && parsedTempo >= settings.minBpm && parsedTempo <= settings.maxBpm) {
        intermediate.bpm = Math.round(parsedTempo);
        intermediate.tempoDescription = getTempoDescription(intermediate.bpm);
      } else if (!isNaN(parsedTempo)) {
        intermediate.bpm = null;
        intermediate.skipReason = `Detected tempo (${parsedTempo.toFixed(1)} BPM) falls outside configured range (${settings.minBpm}-${settings.maxBpm} BPM)`;
      } else {
        intermediate.bpm = null;
        intermediate.skipReason = 'Could not reliably determine rhythm peaks';
      }
    } catch (err: any) {
      // Audio without rhythmic beats (ambient drones, SFX clicks, noise)
      intermediate.bpm = null;
      intermediate.skipReason = `No rhythmic peaks found: ${err?.message || 'non-rhythmic'}`;
    }
  },
};

/**
 * Step 4: Apply Metadata
 * Saves BPM and tempo description into asset metadata; labels are accessible via bpm: keyword without tag assignments.
 */
const persistStep: ClassifierStep<BpmClassifierSettings, BpmIntermediateState> = {
  id: 'apply-metadata-tags',
  name: 'Persist Metadata',
  description: 'Saves calculated BPM and tempo description to index.db.',
  execute: async ({ asset, settings, intermediate }) => {
    if (intermediate.bpm === null || intermediate.bpm === undefined) {
      return;
    }

    // Persist BPM in asset metadata
    updateAssetMetadata(asset.id, {
      bpm: intermediate.bpm,
      tempoDescription: intermediate.tempoDescription,
    });

    // Remove old tags previously generated by this classifier if any
    removeAssetTagsBySource(asset.id, 'classifier:bpm');

    // Dedicated filter bpm: handles queries; do not add tags unless explicitly asked
    const tagsToAdd: { tag: string; source: string }[] = [];
    if (settings.applyBpmTag === true) {
      tagsToAdd.push({ tag: `bpm:${intermediate.bpm}`, source: 'classifier:bpm' });
    }
    if (settings.applyTempoTag === true && intermediate.tempoDescription) {
      const prefix = settings.tempoTagPrefix !== undefined ? settings.tempoTagPrefix : '';
      tagsToAdd.push({ tag: `${prefix}${intermediate.tempoDescription}`, source: 'classifier:bpm' });
    }

    if (tagsToAdd.length > 0) {
      addAssetTags(asset.id, tagsToAdd);
      intermediate.tagsAdded = tagsToAdd.map((t) => t.tag);
    } else {
      intermediate.tagsAdded = [];
    }
    // Regenerate thumbnail with updated BPM-based waveform coloring if present
    try {
      const db = getDatabase();
      const row = db.prepare('SELECT thumbnail_path FROM assets WHERE id = ?').get(asset.id) as
        | { thumbnail_path: string | null }
        | undefined;
      if (row && row.thumbnail_path && fs.existsSync(row.thumbnail_path)) {
        const newThumb = await generateAudioThumbnail(
          asset.name,
          asset.metadata.duration,
          asset.metadata.numberOfChannels,
          intermediate.bpm
        );
        await fs.promises.writeFile(row.thumbnail_path, newThumb);
      }
    } catch (thumbErr) {
      console.warn(`Failed to update thumbnail with BPM for asset ${asset.id}:`, thumbErr);
    }
  },
};

export const bpmClassifier: Classifier<BpmClassifierSettings, BpmIntermediateState> = {
  id: 'bpm',
  name: 'BPM & Tempo Classifier',
  description: 'Calculates musical tempo (beats per minute) and rhythm category for audio tracks and loops.',
  category: 'audio',
  defaultSettings: DEFAULT_BPM_SETTINGS,
  steps: [probeStep, decodeStep, analyzeStep, persistStep],
  createIntermediateState: () => ({
    skipped: false,
    tagsAdded: [],
  }),
  createAssetResult: (asset: Asset, intermediate: BpmIntermediateState): ClassifierAssetResult => {
    if (intermediate.bpm !== null && intermediate.bpm !== undefined) {
      return {
        assetId: asset.id,
        assetPath: asset.path,
        success: true,
        result: {
          bpm: intermediate.bpm,
          tempoDescription: intermediate.tempoDescription,
          duration: intermediate.duration,
        },
        tagsAdded: intermediate.tagsAdded,
      };
    }

    return {
      assetId: asset.id,
      assetPath: asset.path,
      success: false,
      error: intermediate.error || intermediate.skipReason || 'No BPM detected',
      tagsAdded: [],
    };
  },
};
