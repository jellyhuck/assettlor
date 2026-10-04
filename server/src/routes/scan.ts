import { FastifyInstance, FastifyRequest } from 'fastify';
import {
  scanLibrary,
  getCurrentScanStatus,
  addScanListener,
  requestCancelScan,
} from '../services/scanner.js';
import { getAppSettings, updateAppSettings } from '../db/database.js';

export async function scanRoutes(fastify: FastifyInstance) {
  // SSE progress stream
  fastify.get('/api/scan/progress', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    const unsubscribe = addScanListener((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.raw.on('close', () => {
      unsubscribe();
    });

    // Keep connection open
    return new Promise(() => {});
  });

  // Current status
  fastify.get('/api/scan/status', async (_req, reply) => {
    return reply.send(getCurrentScanStatus());
  });

  // Trigger scan
  fastify.post('/api/scan/start', async (req: FastifyRequest<{ Body: { libraryPath?: string } }>, reply) => {
    const settings = getAppSettings();
    const targetPath = req.body?.libraryPath || settings.libraryPath;

    if (!targetPath) {
      return reply.status(400).send({ error: 'Library path is required' });
    }

    // Save updated library path in settings
    updateAppSettings({ libraryPath: targetPath });

    // Run scan asynchronously
    scanLibrary(targetPath).catch((err) => {
      console.error('Background scan error:', err);
    });

    return reply.send({
      message: 'Scan started',
      libraryPath: targetPath,
    });
  });

  // Cancel scan
  fastify.post('/api/scan/cancel', async (_req, reply) => {
    requestCancelScan();
    return reply.send({ message: 'Cancel requested' });
  });
}
