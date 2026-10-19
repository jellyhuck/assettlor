import type { ClassifierInfo } from '../../../../shared/types.js';
import { Classifier } from './types.js';
import { spriteClassifier } from './spriteClassifier.js';
import { bpmClassifier } from './bpmClassifier.js';
import { packClassifier } from './packClassifier.js';
import { folderClassifier } from './folderClassifier.js';
import { getClassifierSettings, updateClassifierSettings } from '../../db/database.js';
import { validateClassifierSettings } from './settings.js';

const registry = new Map<string, Classifier>();

export function registerClassifier(classifier: Classifier): void {
  registry.set(classifier.id, classifier);
}

export function getClassifier(id: string): Classifier | undefined {
  return registry.get(id);
}

export function getAllClassifiers(): Classifier[] {
  return Array.from(registry.values());
}

export function getEffectiveClassifierSettings<T = Record<string, unknown>>(classifier: Classifier): T {
  const persisted = getClassifierSettings(classifier.id);
  return {
    ...classifier.defaultSettings,
    ...(persisted || {}),
  } as T;
}

export function saveClassifierSettings<T = Record<string, unknown>>(classifierId: string, settings: Record<string, unknown>): T {
  const classifier = getClassifier(classifierId);
  if (!classifier) {
    throw new Error(`Classifier with ID "${classifierId}" not found`);
  }
  validateClassifierSettings(classifier, getEffectiveClassifierSettings(classifier), settings);
  return updateClassifierSettings(classifierId, settings) as T;
}

export function getClassifierInfo(classifier: Classifier): ClassifierInfo {
  return {
    id: classifier.id,
    name: classifier.name,
    description: classifier.description,
    category: classifier.category,
    steps: classifier.steps.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    })),
    settings: getEffectiveClassifierSettings(classifier),
  };
}

// Register built-in classifiers
registerClassifier(bpmClassifier);
registerClassifier(spriteClassifier);
registerClassifier(packClassifier);
registerClassifier(folderClassifier);
