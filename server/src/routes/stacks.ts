import { FastifyInstance, FastifyRequest } from 'fastify';
import { getStackById, getStackAssets } from '../db/database.js';

export async function stacksRoutes(fastify: FastifyInstance) {
  fastify.get('/api/stacks/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const stack = getStackById(req.params.id);
    if (!stack) {
      return reply.status(404).send({ error: 'Stack not found' });
    }
    return reply.send(stack);
  });

  fastify.get('/api/stacks/:id/assets', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const assets = getStackAssets(req.params.id);
    return reply.send(assets);
  });
}
