import decode from 'audio-decode';
import MusicTempo from 'music-tempo';
import type {
  BpmClassifierSettings,
  Asset,
  ClassifierAssetResult,
} from '../../../../shared/types.js';
import {
  Classifier,
  ClassifierStep,
} from './types.js';
import {
  finalizeClassifierAsset,
} from '../../db/database.js';

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
    } catch (err: unknown) {
      intermediate.error = `Audio decoding failed: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }

    if (!decoded || !decoded.channelData || decoded.channelData.length === 0) {
      intermediate.error = 'Decoded audio returned no channel data';
      return false;
    }

    const sampleRate = decoded.sampleRate;
    if (!sampleRate || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      intermediate.error = 'Decoded audio returned an invalid sample rate';
      return false;
    }

    const channels = decoded.channelData;
    const channelLength = Math.min(...channels.map((channel) => channel.length));
    if (channelLength === 0) {
      intermediate.error = 'Decoded audio returned empty channel data';
      return false;
    }

    let monoPcm: Float32Array;

    if (channels.length === 1) {
      monoPcm = channels[0];
    } else {
      // Use every channel; a beat can be isolated to a channel beyond left/right.
      monoPcm = new Float32Array(channelLength);
      for (const channel of channels) {
        for (let i = 0; i < channelLength; i++) {
          monoPcm[i] += channel[i] / channels.length;
        }
      }
    }

    const decodedDuration = channelLength / sampleRate;
    if (decodedDuration < settings.minDurationSeconds) {
      intermediate.skipped = true;
      intermediate.skipReason = `Audio duration (${decodedDuration.toFixed(2)}s) is shorter than minimum threshold (${settings.minDurationSeconds}s)`;
      return false;
    }

    // Limit maximum analysis window to conserve CPU for long tracks; take window from the middle of the track
    const maxSamples = Math.floor(sampleRate * (settings.maxAnalysisSeconds || 45));
    if (monoPcm.length > maxSamples) {
      const startSample = Math.floor((monoPcm.length - maxSamples) / 2);
      monoPcm = monoPcm.slice(startSample, startSample + maxSamples);
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
      // The library measures onset spacing in hopSize samples, then converts it
      // to seconds with timeStep. Both must derive from the decoded sample rate.
      const hopSize = Math.max(1, Math.round(intermediate.sampleRate / 100));
      const calc = new MusicTempo(intermediate.pcmData, {
        hopSize,
        timeStep: hopSize / intermediate.sampleRate,
        // Retain the library's 60-200 BPM detection span when settings narrow
        // the result filter, while allowing a configured wider tempo range.
        minBeatInterval: 60 / Math.max(200, settings.maxBpm),
        maxBeatInterval: 60 / Math.min(60, settings.minBpm),
      });

      const parsedTempo = Number(calc.tempo);
      if (Number.isFinite(parsedTempo) && parsedTempo >= settings.minBpm && parsedTempo <= settings.maxBpm) {
        intermediate.bpm = Math.round(parsedTempo);
        intermediate.tempoDescription = getTempoDescription(intermediate.bpm);
      } else if (Number.isFinite(parsedTempo)) {
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
  // The engine finalizes every conclusive outcome, including no tempo.
  execute: () => undefined,
};

export const bpmClassifier: Classifier<BpmClassifierSettings, BpmIntermediateState> = {
  id: 'bpm',
  name: 'BPM & Tempo Classifier',
  description: 'Calculates musical tempo (beats per minute) and rhythm category for audio tracks and loops.',
  category: 'audio',
  defaultSettings: DEFAULT_BPM_SETTINGS,
  requiresBuffer: true,
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
        outcome: 'classified',
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
      outcome: 'no-result',
      error: intermediate.error || intermediate.skipReason || 'No BPM detected',
      tagsAdded: [],
    };
  },
  finalizeAsset: (asset, intermediate, settings, result) => {
    const classified = result.outcome === 'classified' && intermediate.bpm !== null && intermediate.bpm !== undefined;
    const tags: string[] = [];
    if (classified && settings.applyBpmTag === true) tags.push(`bpm:${intermediate.bpm}`);
    if (classified && settings.applyTempoTag === true && intermediate.tempoDescription) {
      tags.push(`${settings.tempoTagPrefix !== undefined ? settings.tempoTagPrefix : ''}${intermediate.tempoDescription}`);
    }
    const applied = finalizeClassifierAsset(
      asset, 'bpm', classified ? 'classified' : 'no-result',
      classified ? { bpm: intermediate.bpm!, tempoDescription: intermediate.tempoDescription } : {}, tags
    );
    if (applied) result.tagsAdded = tags;
    return applied;
  },
};
