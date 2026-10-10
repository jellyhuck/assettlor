declare module 'music-tempo' {
  /** Options read by music-tempo 1.0.3 during onset detection and beat tracking. */
  export interface MusicTempoOptions {
    bufferSize?: number;
    hopSize?: number;
    timeStep?: number;
    decayRate?: number;
    peakFindingWindow?: number;
    meanWndMultiplier?: number;
    peakThreshold?: number;
    widthTreshold?: number;
    maxIOI?: number;
    minIOI?: number;
    maxTempos?: number;
    minBeatInterval?: number;
    maxBeatInterval?: number;
    initPeriod?: number;
    thresholdBI?: number;
    thresholdBT?: number;
    expiryTime?: number;
    toleranceWndInner?: number;
    toleranceWndPre?: number;
    toleranceWndPost?: number;
    correctionFactor?: number;
    maxChange?: number;
    penaltyFactor?: number;
  }

  export default class MusicTempo {
    constructor(audioData: Float32Array | number[], options?: MusicTempoOptions);

    /** A decimal string produced by toFixed(3) after successful extraction. */
    tempo: string;
    beatInterval: number;
    beats: number[];
    events: number[];
    peaks: number[];
    spectralFlux: number[];
    tempoList: number[];
  }
}
