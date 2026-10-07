import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config, loadConfigFile, resolveDataDir } from './config.js';
import { initDatabase } from './db/database.js';
import { assetsRoutes } from './routes/assets.js';
import { stacksRoutes } from './routes/stacks.js';
import { scanRoutes } from './routes/scan.js';
import { settingsRoutes } from './routes/settings.js';
import { fsRoutes } from './routes/fs.js';
import { classifiersRoutes } from './routes/classifiers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface BuildServerOptions {
  logger?: boolean | object;
  initDb?: boolean;
  libraryPath?: string;
  dataDir?: string;
  configPath?: string;
  clientDistPath?: string;
}

export async function buildServer(options: BuildServerOptions = {}) {
  if (options.configPath) {
    loadConfigFile(options.configPath);
  }

  const server = Fastify({
    logger: options.logger !== undefined ? options.logger : {
      level: process.env.LOG_LEVEL || 'info',
    },
    routerOptions: {
      maxParamLength: 2048,
    },
  });

  // Enable CORS for Vite dev server
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // Initialize DB with data directory
  if (options.initDb !== false) {
    try {
      const dataDir = options.dataDir || (options.libraryPath ? resolveDataDir(options.libraryPath) : config.dataDir);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      initDatabase(dataDir);
    } catch (err) {
      console.warn('Initial database init note:', err);
    }
  }

  // Register API routes
  await server.register(assetsRoutes);
  await server.register(stacksRoutes);
  await server.register(scanRoutes);
  await server.register(settingsRoutes);
  await server.register(fsRoutes);
  await server.register(classifiersRoutes);

  // Serve frontend build if dist exists
  const clientDistPath = options.clientDistPath || path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDistPath)) {
    await server.register(fastifyStatic, {
      root: clientDistPath,
      prefix: '/',
    });
  }

  server.setNotFoundHandler((req, reply) => {
    if (req.raw.url && req.raw.url.startsWith('/api')) {
      return reply.status(404).send({ error: 'Endpoint not found' });
    }
    if (fs.existsSync(clientDistPath)) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: 'Endpoint not found' });
  });

  return server;
}

export async function startServer() {
  const server = await buildServer();
  try {
    await server.listen({ port: config.port, host: config.host });
    console.log(`🚀 Assettlor Backend running on http://${config.host}:${config.port}`);
    console.log(`📁 Config file: ${config.configFilePath}`);
    console.log(`💾 Data directory: ${config.dataDir}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

const isDirectRun = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isDirectRun) {
  startServer();
}
