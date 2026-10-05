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

    return new Promise((resolve) => {
      req.raw.on('close', () => {
        unsubscribe();
        resolve(undefined);
      });
    });
  });

  // Current status
  fastify.get('/api/scan/status', async (_req, reply) => {
    return reply.send(getCurrentScanStatus());
  });

  // Trigger scan
  fastify.post('/api/scan/start', async (req: FastifyRequest<{ Body: { libraryPath?: string; libraryPaths?: string[] } }>, reply) => {
    const settings = getAppSettings();
    let targetPaths: string[] = [];

    if (req.body?.libraryPaths !== undefined) {
      targetPaths = Array.isArray(req.body.libraryPaths)
        ? req.body.libraryPaths.map((p) => String(p).trim()).filter(Boolean)
        : [];
      if (targetPaths.length > 0) {
        updateAppSettings({ libraryPaths: targetPaths });
      }
    } else if (req.body?.libraryPath !== undefined) {
      const single = String(req.body.libraryPath).trim();
      if (single) {
        targetPaths = [single];
        updateAppSettings({ libraryPath: single });
      } else {
        targetPaths = [];
      }
    } else if (settings.libraryPaths && settings.libraryPaths.length > 0) {
      targetPaths = settings.libraryPaths;
    } else if (settings.libraryPath) {
      targetPaths = [settings.libraryPath];
    }

    if (targetPaths.length === 0) {
      return reply.status(400).send({ error: 'Library path is required' });
    }

    // Run scan asynchronously
    scanLibrary(targetPaths).catch((err) => {
      console.error('Background scan error:', err);
    });

    return reply.send({
      message: 'Scan started',
      libraryPath: targetPaths[0],
      libraryPaths: targetPaths,
    });
  });

  // Cancel scan
  fastify.post('/api/scan/cancel', async (_req, reply) => {
    requestCancelScan();
    return reply.send({ message: 'Cancel requested' });
  });
}
