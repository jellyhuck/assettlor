import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';

function errorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Filesystem operation failed';
}

export async function fsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/fs/browse', async (req: FastifyRequest<{ Querystring: { path?: string } }>, reply) => {
    const rawPath: unknown = req.query.path;
    if (rawPath !== undefined && (typeof rawPath !== 'string' || !rawPath.trim())) {
      return reply.status(400).send({ error: 'path must be a non-empty string' });
    }
    const requestedPath = path.resolve(typeof rawPath === 'string' ? rawPath : process.cwd());

    try {
      const stat = await fs.promises.stat(requestedPath);
      if (!stat.isDirectory()) {
        return reply.status(400).send({ error: 'path must refer to a directory' });
      }
      const entries = await fs.promises.readdir(requestedPath, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: path.join(requestedPath, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parentPath = path.dirname(requestedPath);
      return reply.send({
        currentPath: requestedPath,
        parentPath: parentPath !== requestedPath ? parentPath : null,
        directories,
      });
    } catch (err: unknown) {
      const code = errorCode(err);
      const status = code === 'ENOENT' ? 404 : code === 'ENOTDIR' ? 400 :
        code === 'EACCES' || code === 'EPERM' ? 403 : 500;
      return reply.status(status).send({ error: errorMessage(err) });
    }
  });

  fastify.post('/api/fs/validate', async (req: FastifyRequest<{ Body: { path: string } }>, reply) => {
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body) ||
        !('path' in body) || typeof body.path !== 'string' || !body.path.trim()) {
      return reply.status(400).send({ error: 'path must be a non-empty string' });
    }
    const resolvedPath = path.resolve(body.path);

    try {
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isDirectory()) {
        return reply.status(400).send({ error: 'path must refer to a directory' });
      }
      return reply.send({ exists: true, isDirectory: true, resolvedPath });
    } catch (err: unknown) {
      const code = errorCode(err);
      if (code === 'ENOENT') {
        return reply.send({ exists: false, isDirectory: false, resolvedPath });
      }
      return reply.status(code === 'ENOTDIR' ? 400 : code === 'EACCES' || code === 'EPERM' ? 403 : 500)
        .send({ error: errorMessage(err) });
    }
  });
}
