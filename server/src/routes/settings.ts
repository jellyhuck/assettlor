import path from 'path';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { getAppSettings, updateAppSettings } from '../db/database.js';
import type { AppSettings } from '../../../shared/types.js';
import { ConfigValidationError } from '../config.js';
import { getCurrentScanStatus, purgeLibraryIndexes } from '../services/scanner.js';

interface SettingsRequestBody extends Partial<AppSettings> {
  /** Deletes the index of libraries this save removes, instead of at the next scan. */
  purgeRemovedLibraries?: boolean;
}

export async function settingsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/settings', async (_req, reply) => {
    try {
      const settings = getAppSettings();
      return reply.send(settings);
    } catch (err: unknown) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'Failed to read settings' });
    }
  });

  fastify.post('/api/settings', async (req: FastifyRequest<{ Body: SettingsRequestBody }>, reply) => {
    let body: unknown = req.body;
    let purge = false;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const { purgeRemovedLibraries, ...settings } = body as SettingsRequestBody;
      purge = purgeRemovedLibraries === true;
      body = settings;
    }
    // Checked before saving; nothing below awaits, so no scan starts in between.
    if (purge && getCurrentScanStatus().status === 'scanning') {
      return reply.status(409).send({ error: 'Cannot remove a library index while a scan is running' });
    }
    try {
      const previousPaths = getAppSettings().libraryPaths;
      const updated = updateAppSettings(body as Partial<AppSettings>);
      if (!purge) return reply.send(updated);
      const kept = new Set(updated.libraryPaths.map((libraryPath) => path.resolve(libraryPath)));
      const removed = previousPaths.filter((libraryPath) => !kept.has(path.resolve(libraryPath)));
      const purged = removed.length ? purgeLibraryIndexes(removed) : { removedCount: 0 };
      return reply.send({ ...updated, removedAssetCount: purged?.removedCount ?? 0 });
    } catch (err: unknown) {
      return reply.status(err instanceof ConfigValidationError ? 400 : 500).send({
        error: err instanceof Error ? err.message : 'Failed to save settings',
      });
    }
  });
}
