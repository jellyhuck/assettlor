import { FastifyInstance, FastifyRequest } from 'fastify';
import { getAppSettings, updateAppSettings } from '../db/database.js';
import type { AppSettings } from '../../../shared/types.js';
import { ConfigValidationError } from '../config.js';

export async function settingsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/settings', async (_req, reply) => {
    try {
      const settings = getAppSettings();
      return reply.send(settings);
    } catch (err: unknown) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'Failed to read settings' });
    }
  });

  fastify.post('/api/settings', async (req: FastifyRequest<{ Body: Partial<AppSettings> }>, reply) => {
    try {
      const updated = updateAppSettings(req.body);
      return reply.send(updated);
    } catch (err: unknown) {
      return reply.status(err instanceof ConfigValidationError ? 400 : 500).send({
        error: err instanceof Error ? err.message : 'Failed to save settings',
      });
    }
  });
}
