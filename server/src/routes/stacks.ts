import { FastifyInstance, FastifyRequest } from 'fastify';
import {
  getStackById,
  getStackAssets,
  addTagsToStack,
  removeTagsFromStack,
} from '../db/database.js';
import type { AddAssetTagsRequest, RemoveAssetTagsRequest } from '../../../shared/types.js';
import { parseTagMutation, parseTagName } from './tagValidation.js';

export async function stacksRoutes(fastify: FastifyInstance) {
  fastify.get('/api/stacks/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const stack = getStackById(req.params.id);
    if (!stack) {
      return reply.status(404).send({ error: 'Stack not found' });
    }
    return reply.send(stack);
  });

  fastify.get('/api/stacks/:id/assets', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!getStackById(req.params.id)) {
      return reply.status(404).send({ error: 'Stack not found' });
    }
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

    const mutation = parseTagMutation(req.body, 'add');
    if (!mutation.ok) return reply.status(400).send({ error: mutation.error });

    const updatedStack = addTagsToStack(req.params.id, mutation.value.tags, mutation.value.source);
    if (!updatedStack) return reply.status(409).send({ error: 'Stack has no assets' });
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

    // Fastify has already decoded the route parameter.
    const tag = parseTagName(req.params.tag);
    if (!tag.ok) return reply.status(400).send({ error: tag.error });
    const updatedStack = removeTagsFromStack(req.params.id, [tag.value]);
    if (!updatedStack) return reply.status(409).send({ error: 'Stack has no assets' });
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

    const mutation = parseTagMutation(req.body, 'remove');
    if (!mutation.ok) return reply.status(400).send({ error: mutation.error });

    const updatedStack = removeTagsFromStack(req.params.id, mutation.value.tags);
    if (!updatedStack) return reply.status(409).send({ error: 'Stack has no assets' });
    return reply.send({
      success: true,
      stack: updatedStack,
      tags: updatedStack ? updatedStack.tags : [],
    });
  });
}
