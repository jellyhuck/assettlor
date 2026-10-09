import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { isIP } from 'net';
import { fileURLToPath } from 'url';
import { config, getEffectiveConfig, loadConfigFile, resolveDataDir } from './config.js';
import {
  closeDatabase,
  getCurrentDataDir,
  getDatabase,
  initDatabase,
  isDatabaseInitialized,
} from './db/database.js';
import { assetsRoutes } from './routes/assets.js';
import { stacksRoutes } from './routes/stacks.js';
import { scanRoutes } from './routes/scan.js';
import { settingsRoutes } from './routes/settings.js';
import { fsRoutes } from './routes/fs.js';
import { classifiersRoutes } from './routes/classifiers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let serverDatabaseUsers = 0;
let serverOwnedDatabase: ReturnType<typeof getDatabase> | null = null;

function acquireServerDatabase(inputDir: string): () => void {
  const dataDir = resolveDataDir(inputDir);
  if (isDatabaseInitialized()) {
    if (getCurrentDataDir() !== dataDir) {
      throw new Error(`Database is already open at ${getCurrentDataDir()}`);
    }
  } else {
    initDatabase(dataDir);
    serverOwnedDatabase = getDatabase();
  }
  serverDatabaseUsers++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    serverDatabaseUsers--;
    if (serverDatabaseUsers === 0 && serverOwnedDatabase) {
      if (isDatabaseInitialized() && getDatabase() === serverOwnedDatabase) closeDatabase();
      serverOwnedDatabase = null;
    }
  };
}

function parseHostHeader(value: string | undefined): URL | undefined {
  // Host is an HTTP authority, not a general URL. Reject userinfo, paths and
  // ambiguous headers before URL normalization (including IPv6 brackets).
  if (!value || /[\s,/@?#\\]/u.test(value)) return undefined;
  try {
    const parsed = new URL(`http://${value}`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function canonicalHostname(value: string): string | undefined {
  if (isIP(value) === 6) return value.toLowerCase();
  const parsed = parseHostHeader(value);
  if (!parsed || parsed.port) return undefined;
  return parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
}

function trustedHosts(bindHost: string, configuredHosts: string[]): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1', '::1']);
  const bindName = canonicalHostname(bindHost);
  if (bindName) hosts.add(bindName);

  // A wildcard bind deliberately exposes each local interface. Permit its
  // literal addresses but not arbitrary DNS aliases that resolve to them.
  if (bindHost === '0.0.0.0' || bindHost === '::') {
    for (const interfaces of Object.values(os.networkInterfaces())) {
      for (const address of interfaces || []) {
        hosts.add(address.address.split('%')[0].toLowerCase());
      }
    }
  }

  for (const host of configuredHosts) {
    const name = canonicalHostname(host);
    if (!name) throw new Error(`Invalid server.allowed_hosts entry: ${host}`);
    hosts.add(name);
  }
  return hosts;
}

function canonicalOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username || parsed.password || parsed.pathname !== '/' ||
      parsed.search || parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function isAllowedOrigin(request: FastifyRequest, origin: string, configuredOrigins: Set<string>): boolean {
  const normalized = canonicalOrigin(origin);
  if (!normalized || normalized !== origin) return false;
  const authority = parseHostHeader(request.headers.host);
  if (!authority) return false;
  const sameOrigin = `${request.protocol}://${authority.host}`;
  return normalized === sameOrigin || configuredOrigins.has(normalized);
}

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

  const serverConfig = getEffectiveConfig().server;
  const allowedHosts = trustedHosts(config.host, serverConfig?.allowed_hosts || []);
  const allowedOrigins = new Set<string>();
  for (const origin of serverConfig?.allowed_origins || []) {
    const normalized = canonicalOrigin(origin);
    if (!normalized || normalized !== origin) {
      throw new Error(`Invalid server.allowed_origins entry: ${origin}`);
    }
    allowedOrigins.add(normalized);
  }

  const server = Fastify({
    logger: options.logger !== undefined ? options.logger : {
      level: process.env.LOG_LEVEL || 'info',
    },
    routerOptions: {
      maxParamLength: 2048,
    },
  });

  // Check Host on every request to stop DNS rebinding, including requests for
  // the static app. Check Origin before any API route can read or mutate data.
  server.addHook('onRequest', async (request, reply) => {
    const authority = parseHostHeader(request.headers.host);
    const hostname = authority?.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (!hostname || !allowedHosts.has(hostname)) {
      return reply.status(403).send({ error: 'Untrusted Host' });
    }
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(request, origin, allowedOrigins)) {
      return reply.status(403).send({ error: 'Untrusted Origin' });
    }
    // Browsers can omit Origin on some requests. Fetch Metadata still marks
    // cross-site writes, while ordinary CLI clients send neither header.
    const fetchSite = request.headers['sec-fetch-site'];
    if (
      !origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      (fetchSite === 'cross-site' || fetchSite === 'same-site')
    ) {
      return reply.status(403).send({ error: 'Untrusted Origin' });
    }
  });

  await server.register(cors, {
    delegator: async (request: FastifyRequest) => {
      const origin = request.headers.origin;
      return {
        origin: origin && isAllowedOrigin(request, origin, allowedOrigins) ? origin : false,
        credentials: true,
        methods: 'GET,HEAD,POST,PUT,DELETE',
      };
    },
  });

  try {
    // Initialize DB with data directory
    if (options.initDb !== false) {
      const dataDir = options.dataDir || (options.libraryPath ? resolveDataDir(options.libraryPath) : config.dataDir);
      const releaseDatabase = acquireServerDatabase(dataDir);
      server.addHook('onClose', async () => releaseDatabase());
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
  } catch (err) {
    await server.close();
    throw err;
  }
}

export async function startServer() {
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    server = await buildServer();
    await server.listen({ port: config.port, host: config.host });
    console.log(`🚀 Assettlor Backend running on http://${config.host}:${config.port}`);
    console.log(`📁 Config file: ${config.configFilePath}`);
    console.log(`💾 Data directory: ${config.dataDir}`);
  } catch (err) {
    server?.log.error(err);
    await server?.close();
    throw err;
  }
}

const isDirectRun = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start Assettlor:', err);
    process.exitCode = 1;
  });
}
