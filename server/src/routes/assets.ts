import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import {
  queryAssets,
  getAssetById,
  getAllTags,
  getAllFormats,
  getAllResolutions,
  getAllBpms,
  getAppSettings,
  addAssetTags,
  removeAssetTag,
  removeAssetTags,
  setAssetTags,
  addTagsToAssets,
  removeTagsFromAssets,
} from '../db/database.js';
import { CopyError, copyAssetToProject } from '../services/copier.js';
import { getZipEntryBuffer } from '../services/archive.js';
import { getAudioMimeType } from '../services/audio.js';
import { AssetQueryValidationError, requireAssetQuery } from '../services/assetQueryValidation.js';
import { planAssetResponse } from './assetRange.js';
import { parseCopyRequest } from './copyValidation.js';
import { parseBatchTagMutation, parseTagMutation, parseTagName } from './tagValidation.js';
import type {
  CopyAssetRequest,
  AddAssetTagsRequest,
  RemoveAssetTagsRequest,
  SetAssetTagsRequest,
  BatchAssetTagsRequest,
} from '../../../shared/types.js';

function getMimeTypeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.bmp': return 'image/bmp';
    case '.tga': return 'image/x-tga';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.flac': return 'audio/flac';
    default: return 'application/octet-stream';
  }
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isFileSystemError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code);
}

export async function assetsRoutes(fastify: FastifyInstance) {
  // Query assets list
  fastify.get('/api/assets', async (req: FastifyRequest<{ Querystring: Record<string, unknown> }>, reply) => {
    try {
      const result = queryAssets(requireAssetQuery(req.query));
      return reply.send(result);
    } catch (err) {
      if (err instanceof AssetQueryValidationError) {
        return reply.status(400).send({ error: err.message, details: err.details });
      }
      const message = err instanceof Error ? err.message : 'Failed to query assets';
      return reply.status(500).send({ error: message });
    }
  });

  // Get asset by ID
  fastify.get('/api/assets/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const asset = getAssetById(req.params.id);
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' });
    }
    return reply.send(asset);
  });

  // Serve asset thumbnail
  fastify.get('/api/assets/:id/thumbnail', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const asset = getAssetById(req.params.id);
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' });
    }

    const db = (await import('../db/database.js')).getDatabase();
    const row = db.prepare('SELECT thumbnail_path FROM assets WHERE id = ?').get(req.params.id) as { thumbnail_path: string | null } | undefined;

    if (!row || !row.thumbnail_path || !fs.existsSync(row.thumbnail_path)) {
      return reply.status(404).send({ error: 'Thumbnail not available' });
    }

    reply.header('Content-Type', 'image/webp');
    reply.header('Cache-Control', 'public, max-age=60, must-revalidate');
    return reply.send(fs.createReadStream(row.thumbnail_path));
  });

  // Stream actual asset file (with HTTP 206 Partial Content support for audio scrubbing!)
  fastify.get('/api/assets/:id/file', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const asset = getAssetById(req.params.id);
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' });
    }

    const mimeType = getMimeTypeForExtension(asset.extension);

    let archiveBuffer: Buffer | undefined;
    let diskHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    let totalSize: number;
    if (asset.isArchiveEntry) {
      // An incomplete virtual entry must never fall through to the ZIP file
      // itself as though that archive were a regular media asset.
      if (!asset.archivePath || !asset.archiveEntryPath) {
        return reply.status(404).send({ error: 'Archive entry unavailable' });
      }
      try {
        archiveBuffer = (await getZipEntryBuffer(asset.archivePath, asset.archiveEntryPath)) ?? undefined;
      } catch (error) {
        if (isMissingFileError(error)) {
          return reply.status(404).send({ error: 'Archive missing on disk' });
        }
        fastify.log.warn({ err: error }, 'Unable to read archive entry');
        if (isFileSystemError(error)) {
          return reply.status(500).send({ error: 'Archive cannot be read' });
        }
        return reply.status(422).send({ error: 'Archive entry cannot be read' });
      }
      if (!archiveBuffer) {
        // The archive helper returns null both for a missing entry and when
        // existsSync cannot access the archive. Check the source to classify it.
        try {
          await fs.promises.stat(asset.archivePath);
        } catch (error) {
          if (isMissingFileError(error)) {
            return reply.status(404).send({ error: 'Archive missing on disk' });
          }
          fastify.log.warn({ err: error }, 'Unable to inspect archive');
          return reply.status(500).send({ error: 'Archive cannot be read' });
        }
        return reply.status(404).send({ error: 'Entry not found in archive' });
      }
      totalSize = archiveBuffer.length;
    } else {
      // Hold the open descriptor through streaming. A file unlinked after
      // opening still produces a complete response with the planned headers.
      try {
        diskHandle = await fs.promises.open(asset.absolutePath, 'r');
        const stat = await diskHandle.stat();
        if (!stat.isFile()) {
          await diskHandle.close();
          return reply.status(404).send({ error: 'File missing on disk' });
        }
        totalSize = stat.size;
      } catch (error) {
        await diskHandle?.close();
        if (isMissingFileError(error)) {
          return reply.status(404).send({ error: 'File missing on disk' });
        }
        fastify.log.warn({ err: error }, 'Unable to open asset file');
        return reply.status(500).send({ error: 'File cannot be read' });
      }
    }

    const plan = planAssetResponse(totalSize, req.headers.range);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', mimeType);
    if (mimeType === 'image/svg+xml') {
      // A direct SVG navigation must not inherit the app's origin or run its
      // active content. Inline styles and embedded data images keep ordinary
      // self-contained artwork visible without allowing network loads.
      reply.header('Content-Security-Policy',
        "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', 'inline');
    }
    reply.header('Content-Length', plan.contentLength);
    if (plan.contentRange) reply.header('Content-Range', plan.contentRange);
    if (plan.status === 416) {
      await diskHandle?.close();
      return reply.status(416).send(Buffer.alloc(0));
    }

    reply.status(plan.status);
    if (archiveBuffer) {
      const content = plan.status === 206
        ? archiveBuffer.subarray(plan.start, plan.end + 1)
        : archiveBuffer;
      return reply.send(content);
    }
    const stream = diskHandle!.createReadStream(plan.status === 206
      ? { start: plan.start, end: plan.end, autoClose: true }
      : { autoClose: true });
    // Fastify strips the body of a HEAD response. Destroy any stream it did
    // not consume so the open descriptor is closed after the response.
    if (req.method === 'HEAD') reply.raw.once('finish', () => stream.destroy());
    return reply.send(stream);
  });

  // Get all tags
  fastify.get('/api/tags', async (_req, reply) => {
    try {
      const tags = getAllTags();
      return reply.send(tags);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Get all formats
  fastify.get('/api/formats', async (_req, reply) => {
    try {
      const formats = getAllFormats();
      return reply.send(formats);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Get all image resolutions
  fastify.get('/api/resolutions', async (_req, reply) => {
    try {
      const resolutions = getAllResolutions();
      return reply.send(resolutions);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Get all detected BPMs
  fastify.get('/api/bpms', async (_req, reply) => {
    try {
      const bpms = getAllBpms();
      return reply.send(bpms);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Copy asset or stack to project
  fastify.post('/api/assets/copy', async (req: FastifyRequest<{ Body: CopyAssetRequest }>, reply) => {
    const copyRequest = parseCopyRequest(req.body);
    if (!copyRequest.ok) {
      return reply.status(400).send({ error: copyRequest.error, code: 'INVALID_COPY_REQUEST' });
    }

    try {
      const result = await copyAssetToProject(copyRequest.value);
      return reply.send(result);
    } catch (error) {
      if (error instanceof CopyError) {
        return reply.status(error.status).send({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      fastify.log.error({ err: error }, 'Unable to copy asset');
      return reply.status(500).send({ error: 'Copy failed', code: 'COPY_IO_ERROR' });
    }
  });

  // Assign tag(s) to asset
  fastify.post('/api/assets/:id/tags', async (req: FastifyRequest<{
    Params: { id: string };
    Body: AddAssetTagsRequest;
  }>, reply) => {
    const asset = getAssetById(req.params.id);
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' });
    }

    const mutation = parseTagMutation(req.body, 'add');
    if (!mutation.ok) return reply.status(400).send({ error: mutation.error });

    const updatedAsset = addAssetTags(asset.id, mutation.value.tags, mutation.value.source);
    if (!updatedAsset) {
      return reply.status(500).send({ error: 'Failed to update asset tags' });
    }

    return reply.send({
      success: true,
      asset: updatedAsset,
      tags: updatedAsset.tags,
    });
  });

  // Remove specific tag from asset (via URL parameter)
  fastify.delete('/api/assets/:id/tags/:tag', async (req: FastifyRequest<{
    Params: { id: string; tag: string };
  }>, reply) => {
    const asset = getAssetById(req.params.id);
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' });
    }

    // Fastify has already decoded the route parameter.
    const tag = parseTagName(req.params.tag);
    if (!tag.ok) return reply.status(400).send({ error: tag.error });
    removeAssetTag(asset.id, tag.value);

    const updatedAsset = getAssetById(asset.id);
    return reply.send({
      success: true,
      asset: updatedAsset,
      tags: updatedAsset ? updatedAsset.tags : [],
    });
  });

  // Remove tag(s) from asset (via request body)
  fastify.delete('/api/assets/:id/tags', async (req: FastifyRequest<{
    Params: { id: string };
    Body: RemoveAssetTagsRequest;
  }>, reply) => {
    const asset = getAssetById(req.params.id);
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' });
    }

    const mutation = parseTagMutation(req.body, 'remove');
    if (!mutation.ok) return reply.status(400).send({ error: mutation.error });

    removeAssetTags(asset.id, mutation.value.tags);

    const updatedAsset = getAssetById(asset.id);
    return reply.send({
      success: true,
      asset: updatedAsset,
      tags: updatedAsset ? updatedAsset.tags : [],
    });
  });

  // Set/replace all tags on asset
  fastify.put('/api/assets/:id/tags', async (req: FastifyRequest<{
    Params: { id: string };
    Body: SetAssetTagsRequest;
  }>, reply) => {
    const asset = getAssetById(req.params.id);
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' });
    }

    const mutation = parseTagMutation(req.body, 'set');
    if (!mutation.ok) return reply.status(400).send({ error: mutation.error });

    const updatedAsset = setAssetTags(asset.id, mutation.value.tags, mutation.value.source);
    return reply.send({
      success: true,
      asset: updatedAsset,
      tags: updatedAsset ? updatedAsset.tags : [],
    });
  });

  // Batch add/remove tags across multiple assets
  fastify.post('/api/assets/tags', async (req: FastifyRequest<{
    Body: BatchAssetTagsRequest;
  }>, reply) => {
    const mutation = parseBatchTagMutation(req.body);
    if (!mutation.ok) return reply.status(400).send({ error: mutation.error });

    const { assetIds, tags, action, source } = mutation.value;
    const existingIds = new Set<string>();
    const missingAssetIds: string[] = [];
    for (const id of assetIds) {
      const asset = getAssetById(id);
      if (asset) existingIds.add(asset.id);
      else if (!missingAssetIds.includes(id)) missingAssetIds.push(id);
    }
    if (existingIds.size === 0) {
      return reply.status(404).send({ error: 'Assets not found', missingAssetIds });
    }

    const canonicalIds = [...existingIds];
    if (action === 'remove') {
      const updated = removeTagsFromAssets(canonicalIds, tags);
      return reply.send({
        success: true,
        action: 'remove',
        affectedCount: updated.length,
        assets: updated,
        missingAssetIds,
      });
    }
    const updated = addTagsToAssets(canonicalIds, tags, source);
    return reply.send({
      success: true,
      action: 'add',
      affectedCount: updated.length,
      assets: updated,
      missingAssetIds,
    });
  });
}
