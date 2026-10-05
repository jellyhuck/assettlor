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
import { copyAssetToProject } from '../services/copier.js';
import { getZipEntryBuffer } from '../services/archive.js';
import { getAudioMimeType } from '../services/audio.js';
import {
  CopyAssetRequest,
  AssetQueryParams,
  AddAssetTagsRequest,
  RemoveAssetTagsRequest,
  SetAssetTagsRequest,
  BatchAssetTagsRequest,
} from '../../shared/types.js';

function getMimeTypeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.bmp': return 'image/bmp';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.flac': return 'audio/flac';
    default: return 'application/octet-stream';
  }
}

export async function assetsRoutes(fastify: FastifyInstance) {
  // Query assets list
  fastify.get('/api/assets', async (req: FastifyRequest<{ Querystring: AssetQueryParams }>, reply) => {
    try {
      const result = queryAssets(req.query);
      return reply.send(result);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
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
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(row.thumbnail_path));
  });

  // Stream actual asset file (with HTTP 206 Partial Content support for audio scrubbing!)
  fastify.get('/api/assets/:id/file', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const asset = getAssetById(req.params.id);
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' });
    }

    const mimeType = getMimeTypeForExtension(asset.extension);

    if (asset.isArchiveEntry && asset.archivePath && asset.archiveEntryPath) {
      // Archive virtual file
      const buffer = getZipEntryBuffer(asset.archivePath, asset.archiveEntryPath);
      if (!buffer) {
        return reply.status(404).send({ error: 'Entry not found in archive' });
      }

      const totalSize = buffer.length;
      const range = req.headers.range;

      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Type', mimeType);

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

        if (start >= totalSize || end >= totalSize) {
          reply.header('Content-Range', `bytes */${totalSize}`);
          return reply.status(416).send('Requested Range Not Satisfiable');
        }

        const chunk = buffer.subarray(start, end + 1);
        reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        reply.header('Content-Length', chunk.length);
        return reply.status(206).send(chunk);
      }

      reply.header('Content-Length', totalSize);
      return reply.send(buffer);
    }

    // Regular file on disk
    if (!fs.existsSync(asset.absolutePath)) {
      return reply.status(404).send({ error: 'File missing on disk' });
    }

    const stat = await fs.promises.stat(asset.absolutePath);
    const totalSize = stat.size;
    const range = req.headers.range;

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', mimeType);

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      if (start >= totalSize || end >= totalSize) {
        reply.header('Content-Range', `bytes */${totalSize}`);
        return reply.status(416).send('Requested Range Not Satisfiable');
      }

      reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      reply.header('Content-Length', end - start + 1);
      reply.status(206);
      return reply.send(fs.createReadStream(asset.absolutePath, { start, end }));
    }

    reply.header('Content-Length', totalSize);
    return reply.send(fs.createReadStream(asset.absolutePath));
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

  // Copy asset or stack to game project
  fastify.post('/api/assets/copy', async (req: FastifyRequest<{ Body: CopyAssetRequest }>, reply) => {
    try {
      const result = await copyAssetToProject(req.body);
      return reply.send(result);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
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

    const rawTags: string[] = [];
    if (req.body?.tag) {
      rawTags.push(req.body.tag);
    }
    if (Array.isArray(req.body?.tags)) {
      rawTags.push(...req.body.tags);
    }

    if (rawTags.length === 0) {
      return reply.status(400).send({ error: 'No tags provided' });
    }

    const updatedAsset = addAssetTags(req.params.id, rawTags, req.body?.source || 'user');
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

    const tagToRemove = decodeURIComponent(req.params.tag);
    removeAssetTag(req.params.id, tagToRemove);

    const updatedAsset = getAssetById(req.params.id);
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

    const rawTags: string[] = [];
    if (req.body?.tag) {
      rawTags.push(req.body.tag);
    }
    if (Array.isArray(req.body?.tags)) {
      rawTags.push(...req.body.tags);
    }

    if (rawTags.length === 0) {
      return reply.status(400).send({ error: 'No tags provided to remove' });
    }

    removeAssetTags(req.params.id, rawTags);

    const updatedAsset = getAssetById(req.params.id);
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

    if (!Array.isArray(req.body?.tags)) {
      return reply.status(400).send({ error: 'tags must be an array' });
    }

    const updatedAsset = setAssetTags(req.params.id, req.body.tags, req.body?.source || 'user');
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
    const { assetIds, tags, action = 'add', source = 'user' } = req.body || {};
    if (!Array.isArray(assetIds) || assetIds.length === 0) {
      return reply.status(400).send({ error: 'assetIds must be a non-empty array' });
    }
    if (!Array.isArray(tags) || tags.length === 0) {
      return reply.status(400).send({ error: 'tags must be a non-empty array' });
    }

    if (action === 'remove') {
      const updated = removeTagsFromAssets(assetIds, tags);
      return reply.send({
        success: true,
        action: 'remove',
        affectedCount: updated.length,
        assets: updated,
      });
    } else {
      const updated = addTagsToAssets(assetIds, tags, source);
      return reply.send({
        success: true,
        action: 'add',
        affectedCount: updated.length,
        assets: updated,
      });
    }
  });
}
