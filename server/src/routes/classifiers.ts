import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getAllClassifiers,
  getClassifier,
  getClassifierInfo,
  saveClassifierSettings,
  runClassifier,
} from '../services/classifiers/index.js';
import { RunClassifierRequest, ClassifierTargetType } from '../../shared/types.js';

export async function classifiersRoutes(fastify: FastifyInstance) {
  // GET /api/classifiers - List all available classifiers with metadata and settings
  fastify.get('/api/classifiers', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const classifiers = getAllClassifiers();
      return reply.send(classifiers.map(getClassifierInfo));
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to retrieve classifiers', details: err?.message });
    }
  });

  // GET /api/classifiers/:id - Get details and settings for a specific classifier
  fastify.get('/api/classifiers/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const { id } = req.params;
      const classifier = getClassifier(id);
      if (!classifier) {
        return reply.status(404).send({ error: `Classifier "${id}" not found` });
      }
      return reply.send(getClassifierInfo(classifier));
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to retrieve classifier', details: err?.message });
    }
  });

  // PUT /api/classifiers/:id/settings - Update settings for a classifier
  fastify.put('/api/classifiers/:id/settings', async (
    req: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
    reply: FastifyReply
  ) => {
    try {
      const { id } = req.params;
      const classifier = getClassifier(id);
      if (!classifier) {
        return reply.status(404).send({ error: `Classifier "${id}" not found` });
      }

      if (!req.body || typeof req.body !== 'object') {
        return reply.status(400).send({ error: 'Settings payload must be a JSON object' });
      }

      const updatedSettings = saveClassifierSettings(id, req.body);
      return reply.send({
        success: true,
        classifierId: id,
        settings: updatedSettings,
      });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to update classifier settings', details: err?.message });
    }
  });

  // POST /api/classifiers/:id/settings - Also allow POST for settings updates
  fastify.post('/api/classifiers/:id/settings', async (
    req: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
    reply: FastifyReply
  ) => {
    try {
      const { id } = req.params;
      const classifier = getClassifier(id);
      if (!classifier) {
        return reply.status(404).send({ error: `Classifier "${id}" not found` });
      }

      if (!req.body || typeof req.body !== 'object') {
        return reply.status(400).send({ error: 'Settings payload must be a JSON object' });
      }

      const updatedSettings = saveClassifierSettings(id, req.body);
      return reply.send({
        success: true,
        classifierId: id,
        settings: updatedSettings,
      });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to update classifier settings', details: err?.message });
    }
  });

  // POST /api/classifiers/:id/run - Execute a classifier on specified target
  fastify.post('/api/classifiers/:id/run', async (
    req: FastifyRequest<{ Params: { id: string }; Body: RunClassifierRequest }>,
    reply: FastifyReply
  ) => {
    try {
      const { id } = req.params;
      const classifier = getClassifier(id);
      if (!classifier) {
        return reply.status(404).send({ error: `Classifier "${id}" not found` });
      }

      const body = req.body || ({} as RunClassifierRequest);
      const targetType: ClassifierTargetType = body.targetType || 'all';

      if (!['all', 'asset', 'directory', 'archive'].includes(targetType)) {
        return reply.status(400).send({
          error: `Invalid targetType: "${targetType}". Must be one of: all, asset, directory, archive`,
        });
      }

      const result = await runClassifier(classifier, {
        targetType,
        targetValue: body.targetValue,
        settingsOverride: body.settingsOverride,
      });

      return reply.send(result);
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to run classifier', details: err?.message });
    }
  });
}
