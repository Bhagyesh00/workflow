/**
 * P5-56 widget route: `/chat-widget/chat.js` and `chat.css` from CHAT_WIDGET_DIST with a one hour cache,
 * an ETag, CORS `*`, `cross-origin-resource-policy: cross-origin` (the sandboxed page and other sites load
 * them), nosniff and no cookie; 404 JSON when the widget is not built.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createContext, type ServerContext } from '../src/context';
import { testConfig, testPackage } from './helpers';

const SCRIPT = 'var WorkflowChat=(function(e){return e})({});';
const STYLES = ':root{--chat--color-primary:#e74266}';

interface Server {
  app: FastifyInstance;
  ctx: ServerContext;
  binaryDir: string;
}

async function startServer(dist: string): Promise<Server> {
  const config = testConfig({ CHAT_WIDGET_DIST: dist });
  const ctx = await createContext({ config, nodePackages: [nodesBasePackage, testPackage] });
  const app = await buildApp(ctx);
  return { app, ctx, binaryDir: config.binaryData.dir };
}

async function stopServer(server: Server) {
  await server.app.close();
  await server.ctx.close();
  await rm(server.binaryDir, { recursive: true, force: true });
}

let dist: string;
let built: Server;
let missing: Server;

beforeAll(async () => {
  dist = await mkdtemp(path.join(tmpdir(), 'chat-widget-dist-'));
  await writeFile(path.join(dist, 'chat.js'), SCRIPT);
  await writeFile(path.join(dist, 'chat.css'), STYLES);
  built = await startServer(dist);
  missing = await startServer(path.join(dist, 'not-built'));
});
afterAll(async () => {
  await stopServer(built);
  await stopServer(missing);
  await rm(dist, { recursive: true, force: true });
});

describe('chat widget route', () => {
  it('serves chat.js and chat.css with cache, ETag, CORS, CORP and nosniff, and no cookie', async () => {
    for (const [name, body, type] of [
      ['chat.js', SCRIPT, 'application/javascript'],
      ['chat.css', STYLES, 'text/css'],
    ] as const) {
      const res = await built.app.inject({ method: 'GET', url: `/chat-widget/${name}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(body);
      expect(res.headers['content-type']).toContain(type);
      expect(res.headers['cache-control']).toBe('public, max-age=3600');
      expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('answers 304 for a matching ETag', async () => {
    const first = await built.app.inject({ method: 'GET', url: '/chat-widget/chat.js' });
    const again = await built.app.inject({
      method: 'GET',
      url: '/chat-widget/chat.js',
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('serves the files read once: a later change on disk is not served', async () => {
    await built.app.inject({ method: 'GET', url: '/chat-widget/chat.css' });
    await writeFile(path.join(dist, 'chat.css'), 'changed');
    const res = await built.app.inject({ method: 'GET', url: '/chat-widget/chat.css' });
    expect(res.body).toBe(STYLES);
    await writeFile(path.join(dist, 'chat.css'), STYLES);
  });

  it('answers 404 JSON for any other path, never the editor', async () => {
    for (const url of [
      '/chat-widget/index.html',
      '/chat-widget/..%2Fchat.js',
      '/chat-widget/',
      '/chat-widget/x/chat.js',
    ]) {
      const res = await built.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('application/json');
    }
  });

  it('answers 404 JSON when the widget is not built', async () => {
    const res = await missing.app.inject({ method: 'GET', url: '/chat-widget/chat.js' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'The chat widget is not available' } });
    expect(res.headers['cross-origin-resource-policy']).not.toBe('cross-origin');
  });
});
