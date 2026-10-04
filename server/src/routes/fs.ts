import { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function fsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/fs/browse', async (req: FastifyRequest<{ Querystring: { path?: string } }>, reply) => {
    try {
      const requestedPath = req.query.path ? path.resolve(req.query.path) : process.cwd();
      const currentPath = fs.existsSync(requestedPath) ? requestedPath : os.homedir();
      const parentPath = path.dirname(currentPath);

      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      const directories: { name: string; path: string }[] = [];

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          directories.push({
            name: entry.name,
            path: path.join(currentPath, entry.name),
          });
        }
      }

      directories.sort((a, b) => a.name.localeCompare(b.name));

      return reply.send({
        currentPath,
        parentPath: parentPath !== currentPath ? parentPath : null,
        directories,
      });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.post('/api/fs/validate', async (req: FastifyRequest<{ Body: { path: string } }>, reply) => {
    try {
      const checkPath = path.resolve(req.body.path);
      const exists = fs.existsSync(checkPath);
      let isDirectory = false;
      if (exists) {
        const stat = await fs.promises.stat(checkPath);
        isDirectory = stat.isDirectory();
      }
      return reply.send({ exists, isDirectory, resolvedPath: checkPath });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });
}
