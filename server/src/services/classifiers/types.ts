import type {
  Asset,
  ClassifierCategory,
  ClassifierTargetType,
  ClassifierAssetResult,
} from '../../../../shared/types.js';

export interface ClassifierStepContext<TSettings = any, TIntermediate = any> {
  asset: Asset;
  buffer: Buffer | null;
  settings: TSettings;
  intermediate: TIntermediate;
}

export interface ClassifierStep<TSettings = any, TIntermediate = any> {
  id: string;
  name: string;
  description: string;
  /**
   * Return false to skip remaining steps for this asset (e.g. if asset doesn't qualify).
   */
  execute: (context: ClassifierStepContext<TSettings, TIntermediate>) => Promise<boolean | void> | boolean | void;
}

export interface Classifier<TSettings = any, TIntermediate = any> {
  id: string;
  name: string;
  description: string;
  category: ClassifierCategory;
  defaultSettings: TSettings;
  /** Defaults to true; path-only classifiers can opt out of media reads. */
  requiresBuffer?: boolean;
  steps: ClassifierStep<TSettings, TIntermediate>[];
  createIntermediateState: (asset: Asset, settings: TSettings) => TIntermediate;
  createAssetResult: (asset: Asset, intermediate: TIntermediate, settings: TSettings) => ClassifierAssetResult;
  /** Applies a conclusive result to the original indexed asset revision. */
  finalizeAsset?: (
    asset: Asset,
    intermediate: TIntermediate,
    settings: TSettings,
    result: ClassifierAssetResult
  ) => boolean;
}

export interface RunClassifierOptions<TSettings = any> {
  targetType: ClassifierTargetType;
  targetValue?: string | string[];
  settingsOverride?: Partial<TSettings>;
  /** Checked between assets and steps; cancellation stops the run without a normal result. */
  shouldCancel?: () => boolean;
  onProgress?: (progress: {
    processedCount: number;
    totalTargeted: number;
    currentAsset?: string;
    stepIndex: number;
    totalSteps: number;
    stepName: string;
  }) => void;
}
