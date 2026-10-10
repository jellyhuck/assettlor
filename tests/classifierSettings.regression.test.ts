import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { resetConfigForTesting } from '../server/src/config.js';
import { closeDatabase, getClassifierSettings, initDatabase } from '../server/src/db/database.js';
import { classifiersRoutes } from '../server/src/routes/classifiers.js';
import { createTempDir, cleanupTempDir } from './helpers.js';

describe('classifier settings validation', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = createTempDir('classifier-settings-');
    resetConfigForTesting();
    initDatabase(dataDir);
  });

  afterEach(() => {
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(dataDir);
  });

  it.each([
    ['bpm', { minBpm: 120, maxBpm: 80 }],
    ['bpm', { maxAnalysisSeconds: 0 }],
    ['bpm', { minBpm: '80' }],
    ['bpm', { applyBpmTag: 'true' }],
    ['sprite', { minConfidence: 1.1 }],
    ['sprite', { enableVisualAnalysis: null }],
    ['pack', { directoryDepth: 1.5 }],
    ['pack', { directoryStrategy: 'guess' }],
    ['pack', { caseConvention: 'sentence' }],
    ['pack', { targetArchives: ['valid.zip', ''] }],
    ['pack', { targetDirectories: [123] }],
    ['pack', []],
  ])('rejects invalid %s settings through both verbs', async (id, settings) => {
    const app = Fastify();
    await app.register(classifiersRoutes);
    const before = getClassifierSettings(id);
    try {
      for (const method of ['PUT', 'POST'] as const) {
        const response = await app.inject({ method, url: `/api/classifiers/${id}/settings`, payload: settings });
        expect(response.statusCode).toBe(400);
        expect(getClassifierSettings(id)).toEqual(before);
      }
    } finally {
      await app.close();
    }
  });

  it('rejects invalid overrides before a manual run and permits disabled manual classifiers', async () => {
    const app = Fastify();
    await app.register(classifiersRoutes);
    try {
      const invalid = await app.inject({
        method: 'POST', url: '/api/classifiers/pack/run',
        payload: { targetType: 'all', settingsOverride: { directoryDepth: 0 } },
      });
      expect(invalid.statusCode).toBe(400);

      const settings = await app.inject({
        method: 'PUT', url: '/api/classifiers/pack/settings', payload: { enabled: false },
      });
      expect(settings.statusCode).toBe(200);
      const manual = await app.inject({
        method: 'POST', url: '/api/classifiers/pack/run', payload: { targetType: 'all' },
      });
      expect(manual.statusCode).toBe(200);
      expect(manual.json().totalTargeted).toBe(0);
    } finally {
      await app.close();
    }
  });
});
