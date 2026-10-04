import { FastifyInstance, FastifyRequest } from 'fastify';
import { getAppSettings, updateAppSettings } from '../db/database.js';
import { AppSettings } from '../../shared/types.js';

export async function settingsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/settings', async (_req, reply) => {
    try {
      const settings = getAppSettings();
      return reply.send(settings);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.post('/api/settings', async (req: FastifyRequest<{ Body: Partial<AppSettings> }>, reply) => {
    try {
      const updated = updateAppSettings(req.body);
      return reply.send(updated);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });
}
