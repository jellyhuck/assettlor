import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getAllClassifiers,
  getClassifier,
  getClassifierInfo,
  saveClassifierSettings,
  runClassifier,
} from '../services/classifiers/index.js';
import type { RunClassifierRequest } from '../../../shared/types.js';
import {
  InvalidClassifierScopeError,
  validateClassifierScope,
} from '../services/classifiers/scope.js';
import { getClassifierTargets } from '../services/classifiers/targets.js';
import { ClassifierSettingsError } from '../services/classifiers/settings.js';

export async function classifiersRoutes(fastify: FastifyInstance) {
  fastify.get('/api/classifiers/targets', async (_req, reply) => {
    try {
      return reply.send(getClassifierTargets());
    } catch (err: unknown) {
      return reply.status(500).send({
        error: 'Failed to retrieve classifier targets',
        details: err instanceof Error ? err.message : undefined,
      });
    }
  });

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
    } catch (err: unknown) {
      if (err instanceof ClassifierSettingsError) return reply.status(400).send({ error: err.message });
      return reply.status(500).send({ error: 'Failed to update classifier settings', details: err instanceof Error ? err.message : undefined });
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
    } catch (err: unknown) {
      if (err instanceof ClassifierSettingsError) return reply.status(400).send({ error: err.message });
      return reply.status(500).send({ error: 'Failed to update classifier settings', details: err instanceof Error ? err.message : undefined });
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
      const target = validateClassifierScope({
        targetType: body.targetType,
        targetValue: body.targetValue,
      });

      const result = await runClassifier(classifier, {
        ...target,
        settingsOverride: body.settingsOverride,
      });

      return reply.send(result);
    } catch (err: unknown) {
      if (err instanceof InvalidClassifierScopeError || err instanceof ClassifierSettingsError) {
        return reply.status(400).send({ error: err.message });
      }
      return reply.status(500).send({
        error: 'Failed to run classifier',
        details: err instanceof Error ? err.message : undefined,
      });
    }
  });
}
