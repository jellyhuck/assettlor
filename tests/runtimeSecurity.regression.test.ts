import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import path from 'path';
import { buildServer } from '../server/src/index.js';
import { resetConfigForTesting } from '../server/src/config.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

const LOCAL_HOST = '127.0.0.1:3001';
const VITE_ORIGIN = 'http://localhost:5173';

describe('local API boundary', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('runtime-security-');
    resetConfigForTesting({
      server: {
        port: 3001,
        host: '127.0.0.1',
        allowed_hosts: [],
        allowed_origins: [],
      },
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    resetConfigForTesting();
    cleanupTempDir(tempDir);
  });

  async function start() {
    app = await buildServer({
      initDb: false,
      logger: false,
      clientDistPath: path.join(tempDir, 'missing-dist'),
    });
    await app.ready();
    return app;
  }

  function browseUrl() {
    return `/api/fs/browse?path=${encodeURIComponent(tempDir)}`;
  }

  it('accepts same-origin browser and no-Origin CLI requests', async () => {
    const server = await start();
    const sameOrigin = await server.inject({
      method: 'GET',
      url: browseUrl(),
      headers: { host: LOCAL_HOST, origin: `http://${LOCAL_HOST}` },
    });
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.headers['access-control-allow-origin']).toBe(`http://${LOCAL_HOST}`);

    const cli = await server.inject({
      method: 'GET',
      url: browseUrl(),
      headers: { host: LOCAL_HOST },
    });
    expect(cli.statusCode).toBe(200);
    expect(cli.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows only explicitly configured Vite origins', async () => {
    resetConfigForTesting({
      server: {
        port: 3001,
        host: '127.0.0.1',
        allowed_hosts: [],
        allowed_origins: [VITE_ORIGIN],
      },
    });
    const server = await start();
    const read = await server.inject({
      method: 'GET',
      url: browseUrl(),
      headers: { host: LOCAL_HOST, origin: VITE_ORIGIN },
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers['access-control-allow-origin']).toBe(VITE_ORIGIN);

    const unsafe = await server.inject({
      method: 'POST',
      url: '/api/fs/validate',
      headers: { host: LOCAL_HOST, origin: VITE_ORIGIN },
      payload: { path: tempDir },
    });
    expect(unsafe.statusCode).toBe(200);
    expect(unsafe.json().isDirectory).toBe(true);
  });

  it('rejects untrusted origins before both read and unsafe handlers', async () => {
    const server = await start();
    for (const origin of ['https://untrusted.invalid', 'null']) {
      const read = await server.inject({
        method: 'GET',
        url: browseUrl(),
        headers: { host: LOCAL_HOST, origin },
      });
      expect(read.statusCode).toBe(403);
      expect(read.json()).toEqual({ error: 'Untrusted Origin' });
      expect(read.headers['access-control-allow-origin']).toBeUndefined();

      const unsafe = await server.inject({
        method: 'POST',
        url: '/api/fs/validate',
        headers: { host: LOCAL_HOST, origin },
        payload: { path: tempDir },
      });
      expect(unsafe.statusCode).toBe(403);
      expect(unsafe.json()).toEqual({ error: 'Untrusted Origin' });
      expect(unsafe.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('rejects a browser cross-site write with no Origin header', async () => {
    const server = await start();
    const response = await server.inject({
      method: 'POST',
      url: '/api/fs/validate',
      headers: { host: LOCAL_HOST, 'sec-fetch-site': 'cross-site' },
      payload: { path: tempDir },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Untrusted Origin' });

    const cli = await server.inject({
      method: 'POST',
      url: '/api/fs/validate',
      headers: { host: LOCAL_HOST },
      payload: { path: tempDir },
    });
    expect(cli.statusCode).toBe(200);
  });

  it('accepts trusted preflights and rejects untrusted ones', async () => {
    resetConfigForTesting({
      server: {
        port: 3001,
        host: '127.0.0.1',
        allowed_hosts: [],
        allowed_origins: [VITE_ORIGIN],
      },
    });
    const server = await start();
    const trusted = await server.inject({
      method: 'OPTIONS',
      url: '/api/assets/example/tags',
      headers: {
        host: LOCAL_HOST,
        origin: VITE_ORIGIN,
        'access-control-request-method': 'PUT',
      },
    });
    expect(trusted.statusCode).toBe(204);
    expect(trusted.headers['access-control-allow-origin']).toBe(VITE_ORIGIN);
    expect(trusted.headers['access-control-allow-methods']).toContain('PUT');

    const untrusted = await server.inject({
      method: 'OPTIONS',
      url: '/api/assets/example/tags',
      headers: {
        host: LOCAL_HOST,
        origin: 'https://untrusted.invalid',
        'access-control-request-method': 'PUT',
      },
    });
    expect(untrusted.statusCode).toBe(403);
    expect(untrusted.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects hostname rebinding even without an Origin header', async () => {
    const server = await start();
    for (const host of ['attacker.invalid:3001', 'attacker.invalid@localhost:3001']) {
      const response = await server.inject({
        method: 'GET',
        url: '/',
        headers: { host },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Untrusted Host' });
    }
  });

  it('supports deliberate LAN hosting with an explicit DNS alias and browser origin', async () => {
    resetConfigForTesting({
      server: {
        port: 3001,
        host: '0.0.0.0',
        allowed_hosts: ['assets.lan'],
        allowed_origins: ['http://dashboard.lan:5173'],
      },
    });
    const server = await start();
    const cli = await server.inject({
      method: 'GET',
      url: browseUrl(),
      headers: { host: 'assets.lan:3001' },
    });
    expect(cli.statusCode).toBe(200);

    const browser = await server.inject({
      method: 'GET',
      url: browseUrl(),
      headers: {
        host: 'assets.lan:3001',
        origin: 'http://dashboard.lan:5173',
      },
    });
    expect(browser.statusCode).toBe(200);
    expect(browser.headers['access-control-allow-origin']).toBe('http://dashboard.lan:5173');

    const rebound = await server.inject({
      method: 'GET',
      url: browseUrl(),
      headers: {
        host: 'attacker.invalid:3001',
        origin: 'http://dashboard.lan:5173',
      },
    });
    expect(rebound.statusCode).toBe(403);
  });
});
