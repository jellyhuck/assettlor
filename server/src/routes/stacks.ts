import { FastifyInstance, FastifyRequest } from 'fastify';
import {
  getStackById,
  getStackAssets,
  addTagsToStack,
  removeTagsFromStack,
} from '../db/database.js';
import { AddAssetTagsRequest, RemoveAssetTagsRequest } from '../../shared/types.js';

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

  // Assign tag(s) to all member assets in a stack
  fastify.post('/api/stacks/:id/tags', async (req: FastifyRequest<{
    Params: { id: string };
    Body: AddAssetTagsRequest;
  }>, reply) => {
    const stack = getStackById(req.params.id);
    if (!stack) {
      return reply.status(404).send({ error: 'Stack not found' });
    }

    const rawTags: string[] = [];
    if (req.body?.tag) rawTags.push(req.body.tag);
    if (Array.isArray(req.body?.tags)) rawTags.push(...req.body.tags);

    if (rawTags.length === 0) {
      return reply.status(400).send({ error: 'No tags provided' });
    }

    const updatedStack = addTagsToStack(req.params.id, rawTags, req.body?.source || 'user');
    return reply.send({
      success: true,
      stack: updatedStack,
      tags: updatedStack ? updatedStack.tags : [],
    });
  });

  // Remove specific tag from all member assets in a stack (via URL parameter)
  fastify.delete('/api/stacks/:id/tags/:tag', async (req: FastifyRequest<{
    Params: { id: string; tag: string };
  }>, reply) => {
    const stack = getStackById(req.params.id);
    if (!stack) {
      return reply.status(404).send({ error: 'Stack not found' });
    }

    const tagToRemove = decodeURIComponent(req.params.tag);
    const updatedStack = removeTagsFromStack(req.params.id, [tagToRemove]);
    return reply.send({
      success: true,
      stack: updatedStack,
      tags: updatedStack ? updatedStack.tags : [],
    });
  });

  // Remove tag(s) from all member assets in a stack (via request body)
  fastify.delete('/api/stacks/:id/tags', async (req: FastifyRequest<{
    Params: { id: string };
    Body: RemoveAssetTagsRequest;
  }>, reply) => {
    const stack = getStackById(req.params.id);
    if (!stack) {
      return reply.status(404).send({ error: 'Stack not found' });
    }

    const rawTags: string[] = [];
    if (req.body?.tag) rawTags.push(req.body.tag);
    if (Array.isArray(req.body?.tags)) rawTags.push(...req.body.tags);

    if (rawTags.length === 0) {
      return reply.status(400).send({ error: 'No tags provided to remove' });
    }

    const updatedStack = removeTagsFromStack(req.params.id, rawTags);
    return reply.send({
      success: true,
      stack: updatedStack,
      tags: updatedStack ? updatedStack.tags : [],
    });
  });
}
