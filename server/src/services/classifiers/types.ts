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
  steps: ClassifierStep<TSettings, TIntermediate>[];
  createIntermediateState: (asset: Asset, settings: TSettings) => TIntermediate;
  createAssetResult: (asset: Asset, intermediate: TIntermediate, settings: TSettings) => ClassifierAssetResult;
}

export interface RunClassifierOptions<TSettings = any> {
  targetType: ClassifierTargetType;
  targetValue?: string | string[];
  settingsOverride?: Partial<TSettings>;
  onProgress?: (progress: {
    processedCount: number;
    totalTargeted: number;
    currentAsset?: string;
    stepIndex: number;
    totalSteps: number;
    stepName: string;
  }) => void;
}
