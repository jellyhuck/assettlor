import fs from 'fs';
import path from 'path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  startScan,
  getCurrentScanStatus,
  addScanListener,
  requestCancelScan,
} from '../services/scanner.js';
import type { ScanOptions } from '../services/scanner.js';
import { getAppSettings, updateAppSettings } from '../db/database.js';

interface ScanRequestBody {
  libraryPath?: string;
  libraryPaths?: string[];
  fullRescan?: boolean;
}

interface LibraryScanRequestBody {
  libraryPath?: string;
  reindex?: boolean;
  keepUserTags?: boolean;
}

class InvalidScanTarget extends Error {}

function resolveScanTargets(body: ScanRequestBody | undefined): {
  paths: string[];
  settingsUpdate?: { libraryPath: string } | { libraryPaths: string[] };
} {
  const settings = getAppSettings();
  let suppliedPaths: unknown;
  let updateKind: 'single' | 'multiple' | undefined;

  if (body?.libraryPaths !== undefined) {
    suppliedPaths = body.libraryPaths;
    updateKind = 'multiple';
  } else if (body?.libraryPath !== undefined) {
    suppliedPaths = [body.libraryPath];
    updateKind = 'single';
  } else {
    suppliedPaths = settings.libraryPaths.length > 0
      ? settings.libraryPaths
      : (settings.libraryPath ? [settings.libraryPath] : []);
  }

  if (!Array.isArray(suppliedPaths)) {
    throw new InvalidScanTarget('Library paths must be an array of directories');
  }
  if (suppliedPaths.length === 0) {
    throw new InvalidScanTarget('Library path is required');
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  let existingCount = 0;
  for (const [index, suppliedPath] of suppliedPaths.entries()) {
    if (typeof suppliedPath !== 'string' || !suppliedPath.trim()) {
      if (updateKind === 'single' && suppliedPath === '') {
        throw new InvalidScanTarget('Library path is required');
      }
      throw new InvalidScanTarget('Library path ' + (index + 1) + ' must be a non-empty string');
    }
    const resolved = path.resolve(suppliedPath.trim());
    let key = resolved;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        throw new InvalidScanTarget('Library path is not a directory: ' + resolved);
      }
      key = fs.realpathSync.native(resolved);
      if (!seen.has(key)) existingCount++;
    } catch (error) {
      if (error instanceof InvalidScanTarget) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new InvalidScanTarget('Cannot access library directory: ' + resolved);
      }
    }
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(resolved);
    }
  }

  // A missing root beside an available one is allowed: the scanner records
  // that partial scan and preserves the missing root's existing index.
  if (existingCount === 0) {
    throw new InvalidScanTarget('Directory does not exist: ' + paths[0]);
  }

  const settingsUpdate = updateKind === 'multiple'
    ? { libraryPaths: paths }
    : updateKind === 'single'
      ? { libraryPath: paths[0] }
      : undefined;
  return { paths, settingsUpdate };
}

export async function scanRoutes(fastify: FastifyInstance) {
  const closeStreams = new Set<() => void>();
  const activeScans = new Set<Promise<unknown>>();
  fastify.addHook('preClose', async () => {
    for (const closeStream of closeStreams) closeStream();
    if (activeScans.size > 0) {
      requestCancelScan();
      await Promise.allSettled(activeScans);
    }
  });

  // The response, rather than the request body, owns this SSE connection.
  fastify.get('/api/scan/progress', (_req, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    let closed = false;
    let backpressured = false;
    let pendingEvent: string | undefined;
    let unsubscribe: (() => void) | undefined;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      response.off('close', cleanup);
      response.off('error', cleanup);
      response.off('drain', drain);
      closeStreams.delete(closeStream);
    };
    const closeStream = () => {
      try {
        if (!response.destroyed && !response.writableEnded) response.end();
      } catch (error) {
        fastify.log.debug({ error }, 'Failed ending scan progress stream');
      } finally {
        cleanup();
      }
    };
    const writeEvent = (event: string) => {
      if (closed) return;
      if (backpressured) {
        // Scan updates supersede older unsent status snapshots.
        pendingEvent = event;
        return;
      }
      try {
        backpressured = !response.write(event);
      } catch (error) {
        fastify.log.debug({ error }, 'Closing failed scan progress stream');
        closeStream();
      }
    };
    const drain = () => {
      backpressured = false;
      if (pendingEvent) {
        const next = pendingEvent;
        pendingEvent = undefined;
        writeEvent(next);
      }
    };
    const heartbeat = setInterval(() => {
      if (!backpressured) writeEvent(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref();

    response.once('close', cleanup);
    response.once('error', cleanup);
    response.on('drain', drain);
    closeStreams.add(closeStream);
    unsubscribe = addScanListener((event) => {
      writeEvent('data: ' + JSON.stringify(event) + '\n\n');
    });
    if (closed) unsubscribe();
  });

  // Current status
  fastify.get('/api/scan/status', async (_req, reply) => {
    return reply.send(getCurrentScanStatus());
  });

  const admitScan = (
    body: ScanRequestBody | undefined,
    scanOptions: (paths: string[]) => ScanOptions,
    saveRequestedPaths: boolean,
  ): { paths: string[] } | { error: string; statusCode: number } => {
    try {
      const { paths, settingsUpdate } = resolveScanTargets(body);
      const task = startScan(paths, scanOptions(paths), () => {
        if (saveRequestedPaths && settingsUpdate) updateAppSettings(settingsUpdate);
      });
      if (!task) return { error: 'A scan is already running', statusCode: 409 };

      activeScans.add(task);
      void task.catch((error: unknown) => {
        fastify.log.error({ error }, 'Background scan failed');
      }).finally(() => activeScans.delete(task));
      return { paths };
    } catch (error) {
      if (error instanceof InvalidScanTarget) {
        return { error: error.message, statusCode: 400 };
      }
      fastify.log.error({ error }, 'Could not start scan');
      return { error: 'Could not start scan', statusCode: 500 };
    }
  };

  fastify.post('/api/scan/start', async (req: FastifyRequest<{ Body: ScanRequestBody }>, reply) => {
    const fullRescan = req.body?.fullRescan === true;
    const result = admitScan(req.body, (paths) => ({
      fullRescan,
      rescanDirectories: fullRescan ? paths : undefined,
    }), true);
    if ('error' in result) return reply.status(result.statusCode).send({ error: result.error });
    return reply.send({
      message: fullRescan ? 'Full rescan started' : 'Scan started',
      libraryPath: result.paths[0],
      libraryPaths: result.paths,
      fullRescan,
    });
  });

  // Scans or reindexes one saved library without changing settings.
  fastify.post('/api/scan/library', async (req: FastifyRequest<{ Body: LibraryScanRequestBody }>, reply) => {
    const body = req.body ?? {};
    if (typeof body.libraryPath !== 'string' || !body.libraryPath.trim()) {
      return reply.status(400).send({ error: 'Library path is required' });
    }
    const requested = path.resolve(body.libraryPath.trim());
    if (!getAppSettings().libraryPaths.some((libraryPath) => path.resolve(libraryPath) === requested)) {
      return reply.status(400).send({ error: 'Not a configured library: ' + requested });
    }
    const reindex = body.reindex === true;
    const keepUserTags = body.keepUserTags !== false;
    const result = admitScan({ libraryPath: requested }, (paths) => (reindex
      ? { reindexDirectories: paths, keepUserTags }
      : {}), false);
    if ('error' in result) return reply.status(result.statusCode).send({ error: result.error });
    return reply.send({
      message: reindex ? 'Reindex started' : 'Scan started',
      libraryPath: result.paths[0],
      reindex,
      ...(reindex ? { keepUserTags } : {}),
    });
  });

  // Cancel scan
  fastify.post('/api/scan/cancel', async (_req, reply) => {
    requestCancelScan();
    return reply.send({ message: 'Cancel requested' });
  });
}
