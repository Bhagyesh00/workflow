/**
 * P6-75 (S4 L5): GET /api/v1/discover. Any valid key calls it (no key scope is checked, `anyKey`); the answer
 * lists only the routes the key's scopes allow (a key with empty scopes sees all), grouped as
 * `resources[resource][operation]`, with `include=schemas` adding the input and output schemas, and `resource`
 * and `operation` narrowing the list. No Git, no network.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_ROUTES } from '../src/routes/public-api';
import { createTestServer, resetDatabase, signup, type TestServer } from './helpers';

interface Entry {
  method: string;
  path: string;
  summary: string;
  scope: string | null;
  inputSchema?: unknown;
  outputSchema?: unknown;
}
type Resources = Record<string, Record<string, Entry>>;

let server: TestServer;
beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

let ip = 1;
let keyCount = 0;
const world = () => signup(server.app, { remoteAddress: `127.9.6.${(ip++ % 250) + 1}` });

async function keyOf(owner: Awaited<ReturnType<typeof world>>, scopes?: string[]): Promise<string> {
  keyCount += 1;
  const made = await owner.client.data(
    owner.client.post('/rest/api-keys', {
      name: `discover-${keyCount}-${randomUUID().slice(0, 6)}`,
      ...(scopes ? { scopes } : {}),
    }),
  );
  return made.key as string;
}

const discover = (key: string | null, query = '') =>
  server.app.inject({
    method: 'GET',
    url: `/api/v1/discover${query}`,
    headers: key ? { 'x-api-key': key } : {},
  });

const entriesOf = (body: { data: { resources: Resources } }): Entry[] =>
  Object.values(body.data.resources).flatMap((ops) => Object.values(ops));
const keyOfEntry = (e: Entry) => `${e.method} ${e.path}`;

describe('discover', () => {
  it('needs a valid key, and any valid key calls it whatever its scopes', async () => {
    expect((await discover(null)).statusCode).toBe(401);
    expect((await discover('wfk_00000000_nope-nope-nope-nope-nope')).statusCode).toBe(401);
    const owner = await world();
    const narrow = await keyOf(owner, ['sourceControl:pull']);
    const res = await discover(narrow);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a key with empty scopes sees every route that names a key scope', async () => {
    const owner = await world();
    const res = await discover(await keyOf(owner));
    expect(res.statusCode, res.body).toBe(200);
    const listed = new Set(entriesOf(res.json()).map(keyOfEntry));
    for (const route of PUBLIC_ROUTES) {
      if (!route.scope) continue;
      expect(listed.has(`${route.method} ${route.path}`), `${route.method} ${route.path}`).toBe(true);
    }
    expect(listed.has('GET /discover')).toBe(true);
    expect(listed.has('POST /source-control/push')).toBe(true);
  });

  it('a narrow key lists only its routes (and discover itself)', async () => {
    const owner = await world();
    const res = await discover(await keyOf(owner, ['workflow:list', 'sourceControl:pull']));
    expect(res.statusCode, res.body).toBe(200);
    const entries = entriesOf(res.json());
    const listed = new Set(entries.map(keyOfEntry));
    expect(listed).toEqual(new Set(['GET /workflows', 'POST /source-control/pull', 'GET /discover']));
    for (const e of entries.filter((x) => x.path !== '/discover')) {
      expect(['workflow:list', 'sourceControl:pull']).toContain(e.scope);
    }
    expect(listed.has('POST /source-control/push')).toBe(false);
    expect(listed.has('GET /credentials')).toBe(false);
  });

  it('answers no schemas by default and adds them with include=schemas', async () => {
    const owner = await world();
    const key = await keyOf(owner, ['sourceControl:push', 'sourceControl:read']);
    const plain = entriesOf((await discover(key, '?resource=source-control')).json());
    expect(plain.length).toBeGreaterThan(0);
    for (const e of plain) {
      expect(e.inputSchema).toBeUndefined();
      expect(e.outputSchema).toBeUndefined();
    }
    const withSchemas = await discover(key, '?resource=source-control&include=schemas');
    expect(withSchemas.statusCode, withSchemas.body).toBe(200);
    const push = entriesOf(withSchemas.json()).find((e) => keyOfEntry(e) === 'POST /source-control/push');
    expect(push?.inputSchema).toMatchObject({ type: 'object' });
    expect(JSON.stringify(push?.inputSchema)).toContain('fileNames');
    expect(push?.outputSchema).toBeTruthy();
    // the answer carries no `components`, so an output schema holds no link to one (the rows of PushResult are inlined)
    const pushOut = JSON.stringify(push?.outputSchema);
    expect(pushOut).not.toContain('$ref');
    expect(pushOut).toContain('conflict');
    expect(pushOut).toContain('files');
    for (const e of entriesOf(withSchemas.json())) {
      expect(JSON.stringify(e.outputSchema), keyOfEntry(e)).not.toContain('#/components/');
    }
    expect((await discover(key, '?include=nope')).statusCode).toBe(400);
  });

  it('narrows by resource and by operation', async () => {
    const owner = await world();
    const key = await keyOf(owner);
    const resources = (await discover(key, '?resource=workflows')).json().data.resources as Resources;
    expect(Object.keys(resources)).toEqual(['workflows']);
    expect(Object.keys(resources.workflows ?? {}).length).toBeGreaterThan(3);
    const operation = Object.keys(resources.workflows ?? {})[0] ?? '';
    const one = (await discover(key, `?resource=workflows&operation=${operation}`)).json().data
      .resources as Resources;
    expect(Object.keys(one.workflows ?? {})).toEqual([operation]);
    const none = (await discover(key, '?resource=nothing-here')).json().data.resources as Resources;
    expect(none).toEqual({});
  });
});
