/** Import from URL (P3-13): the server fetches through the SSRF guard, caps size, never echoes the URL. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, resetDatabase, signup, TestClient, type TestServer } from './helpers';

const NOT_JSON = 'The URL does not point to valid JSON file!';
const NOT_WORKFLOW = 'The data in the file does not seem to be a workflow JSON file!';

const workflow = {
  name: 'From the web',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
  ],
  connections: {},
};

let fixture: Server;
let base: string;
const hits: string[] = [];

beforeAll(async () => {
  fixture = createServer((req, res) => {
    hits.push(req.url ?? '');
    const path = (req.url ?? '').split('?')[0];
    if (path === '/wf.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(workflow));
    } else if (path === '/plain') {
      res.setHeader('content-type', 'text/plain');
      res.end(JSON.stringify(workflow));
    } else if (path === '/html') {
      res.setHeader('content-type', 'text/html');
      res.end('<html></html>');
    } else if (path === '/array') {
      res.end(JSON.stringify([1, 2]));
    } else if (path === '/no-connections') {
      res.end(JSON.stringify({ nodes: [] }));
    } else if (path === '/big') {
      res.setHeader('content-type', 'application/json');
      res.end('{"nodes":[],"connections":{},"pad":"' + 'x'.repeat(6 * 1024 * 1024) + '"}');
    } else if (path === '/redirect') {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
      res.end();
    } else if (path === '/redirect-ok') {
      res.statusCode = 302;
      res.setHeader('location', '/wf.json');
      res.end();
    } else if (path === '/slow') {
      res.setHeader('content-type', 'application/json');
      res.write('{"nodes":');
      // never finishes
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
});
afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
});

const call = (client: TestClient, url: string) => client.post('/rest/workflows/from-url', { url });

describe('import from URL (allowed host)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await createTestServer(
      { LOGIN_RATE_LIMIT_MAX: '1000' },
      { http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }) },
    );
  });
  afterAll(async () => {
    await server.close();
  });

  it('returns the workflow JSON of a valid file', async () => {
    const { client } = await signup(server.app);
    const res = await call(client, `${base}/wf.json`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(workflow);
  });

  it('reads JSON whatever the content-type says, and follows a safe redirect', async () => {
    const { client } = await signup(server.app);
    expect((await call(client, `${base}/plain`)).json().data).toEqual(workflow);
    expect((await call(client, `${base}/redirect-ok`)).json().data).toEqual(workflow);
  });

  it('is 400 with the n8n message when the body is not JSON, the status is 404 or the host is gone', async () => {
    const { client } = await signup(server.app);
    for (const path of ['/html', '/missing']) {
      const res = await call(client, `${base}${path}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe(NOT_JSON);
    }
    const gone = await call(client, 'http://127.0.0.1:1/x');
    expect(gone.statusCode).toBe(400);
    expect(gone.json().error.message).toBe(NOT_JSON);
  });

  it('is 400 "not a workflow" without a nodes array and a connections object', async () => {
    const { client } = await signup(server.app);
    for (const path of ['/array', '/no-connections']) {
      const res = await call(client, `${base}${path}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe(NOT_WORKFLOW);
    }
  });

  it('refuses a 6 MB body with the not-JSON message', async () => {
    const { client } = await signup(server.app);
    const res = await call(client, `${base}/big`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(NOT_JSON);
  });

  it('stops a response that never ends after 10 seconds', async () => {
    const { client } = await signup(server.app);
    const started = Date.now();
    const res = await call(client, `${base}/slow`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(NOT_JSON);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('refuses a redirect to a link-local address and does not echo the URL', async () => {
    const { client } = await signup(server.app);
    const res = await call(client, `${base}/redirect?token=s3cret`);
    expect(res.statusCode).toBe(400);
    const text = res.body;
    expect(text).toContain('169.254.169.254');
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain(base);
  });

  it('checks the URL shape and the role; a viewer is 403, an anonymous caller 401', async () => {
    const owner = await signup(server.app);
    expect((await call(owner.client, 'ftp://example.com/x')).statusCode).toBe(400);
    expect((await call(owner.client, 'not a url')).statusCode).toBe(400);
    expect((await call(new TestClient(server.app), `${base}/wf.json`)).statusCode).toBe(401);
    const email = `viewer-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const invite = await owner.client.data(
      owner.client.post('/rest/members/invite', { email, role: 'viewer' }),
    );
    const viewer = new TestClient(server.app);
    await viewer.data(
      viewer.post(`/rest/invitations/${invite.token}/accept`, { name: 'v', password: 'Passw0rd!' }),
    );
    const before = hits.length;
    expect((await call(viewer, `${base}/wf.json`)).statusCode).toBe(403);
    expect(hits.length).toBe(before);
  });
});

describe('import from URL (strict guard)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await createTestServer(
      { LOGIN_RATE_LIMIT_MAX: '1000' },
      { http: new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } }) },
    );
  });
  afterAll(async () => {
    await resetDatabase(server.ctx);
    await server.close();
  });

  it('refuses a loopback host with the guard message (host and address), never reaching it', async () => {
    const { client } = await signup(server.app);
    const before = hits.length;
    const res = await call(client, `${base}/wf.json?key=abc123`);
    expect(res.statusCode).toBe(400);
    const message: string = res.json().error.message;
    expect(message).toContain('127.0.0.1');
    expect(message).toContain('blocked');
    expect(message).not.toContain('abc123');
    expect(hits.length).toBe(before);
  });
});
