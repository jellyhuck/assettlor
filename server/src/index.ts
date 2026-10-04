import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initDatabase, getAppSettings } from './db/database.js';
import { assetsRoutes } from './routes/assets.js';
import { stacksRoutes } from './routes/stacks.js';
import { scanRoutes } from './routes/scan.js';
import { settingsRoutes } from './routes/settings.js';
import { fsRoutes } from './routes/fs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // Enable CORS for Vite dev server
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // Initialize DB with library path
  try {
    const libraryPath = config.defaultLibraryPath;
    if (!fs.existsSync(libraryPath)) {
      fs.mkdirSync(libraryPath, { recursive: true });
    }
    initDatabase(libraryPath);
  } catch (err) {
    console.warn('Initial database init note:', err);
  }

  // Register API routes
  await server.register(assetsRoutes);
  await server.register(stacksRoutes);
  await server.register(scanRoutes);
  await server.register(settingsRoutes);
  await server.register(fsRoutes);

  // Serve frontend build if dist exists
  const clientDistPath = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDistPath)) {
    await server.register(fastifyStatic, {
      root: clientDistPath,
      prefix: '/',
    });

    server.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  try {
    await server.listen({ port: config.port, host: config.host });
    console.log(`🚀 Assettlor Backend running on http://${config.host}:${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

startServer();
