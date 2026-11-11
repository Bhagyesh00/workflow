/**
 * The commands against a fake public API on node:http (127.0.0.1): each sends the path, query and body the API
 * expects, the key goes only in X-API-KEY and never into output, and errors give their exit codes.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliIo } from '../src/index';
import { run } from '../src/index';

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: unknown;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

const KEY = 'sk-test-0123456789abcdef-SECRET';
let server: Server;
let other: Server;
let base = '';
let otherHits = 0;
let seen: Seen[] = [];
let reply: (req: Seen) => Reply = () => ({ body: { data: {} } });

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const text = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = {
        method: req.method ?? '',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      seen.push(entry);
      const answer = reply(entry);
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers });
      res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
  });
  other = createServer((_req, res) => {
    otherHits += 1;
    res.end('{}');
  });
  await Promise.all([
    new Promise<void>((r) => server.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => other.listen(0, '127.0.0.1', r)),
  ]);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => other.close(r))]);
});
beforeEach(() => {
  seen = [];
  otherHits = 0;
  reply = () => ({ body: { data: {}, nextCursor: null } });
});

function makeIo(
  options: {
    env?: Record<string, string>;
    files?: Record<string, string>;
    stdin?: string;
    isTTY?: boolean;
  } = {},
) {
  const files = new Map(Object.entries(options.files ?? {}));
  const out: string[] = [];
  const err: string[] = [];
  const writeFile = vi.fn(async (path: string, data: string, _o: { mode?: number }) => {
    files.set(path, data);
  });
  const io: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: options.env ?? {},
    home: '/home/me',
    fetch: globalThis.fetch,
    stdin: async () => options.stdin ?? '',
    isTTY: options.isTTY ?? false,
    readFile: async (p) => files.get(p),
    writeFile,
    removeFile: async (p) => {
      files.delete(p);
    },
  };
  return { io, files, writeFile, stdout: () => out.join(''), stderr: () => err.join('') };
}

/** a signed-in run: the key and URL come from the environment */
async function cli(argv: string[], options: Parameters<typeof makeIo>[0] = {}) {
  const made = makeIo({ ...options, env: { WORKFLOW_URL: base, WORKFLOW_API_KEY: KEY, ...options.env } });
  const code = await run(argv, made.io);
  return { code, ...made };
}

const last = () => seen[seen.length - 1];
const ID = '8c7d6e5f-0000-4000-8000-000000000001';
const DEST = '8c7d6e5f-0000-4000-8000-000000000002';

describe('each command sends the API path, query and body', () => {
  const cases: Array<[string, string[], string, string, Record<string, string>?, unknown?]> = [
    [
      'workflow list',
      ['workflow', 'list', '--active', '--project-id', DEST, '--name', 'a b', '--limit', '5'],
      'GET',
      '/api/v1/workflows',
      { active: 'true', projectId: DEST, name: 'a b', limit: '5' },
    ],
    [
      'workflow list active=false',
      ['workflow', 'list', '--active=false'],
      'GET',
      '/api/v1/workflows',
      { active: 'false' },
    ],
    ['workflow get', ['workflow', 'get', ID], 'GET', `/api/v1/workflows/${ID}`],
    ['workflow delete', ['workflow', 'delete', ID], 'DELETE', `/api/v1/workflows/${ID}`],
    [
      'workflow activate',
      ['workflow', 'activate', ID, '--version-id', DEST],
      'POST',
      `/api/v1/workflows/${ID}/activate`,
      undefined,
      { versionId: DEST },
    ],
    [
      'workflow deactivate',
      ['workflow', 'deactivate', ID],
      'POST',
      `/api/v1/workflows/${ID}/deactivate`,
      undefined,
      {},
    ],
    ['workflow tags (read)', ['workflow', 'tags', ID], 'GET', `/api/v1/workflows/${ID}/tags`],
    [
      'workflow tags (set)',
      ['workflow', 'tags', ID, '--set', 'a, b'],
      'PUT',
      `/api/v1/workflows/${ID}/tags`,
      undefined,
      [{ id: 'a' }, { id: 'b' }],
    ],
    [
      'workflow tags (clear)',
      ['workflow', 'tags', ID, '--set', ''],
      'PUT',
      `/api/v1/workflows/${ID}/tags`,
      undefined,
      [],
    ],
    [
      'workflow transfer',
      ['workflow', 'transfer', ID, '--destination-project-id', DEST],
      'PUT',
      `/api/v1/workflows/${ID}/transfer`,
      undefined,
      { destinationProjectId: DEST },
    ],
    [
      'execution list',
      ['execution', 'list', '--workflow-id', ID, '--status', 'error,crashed'],
      'GET',
      '/api/v1/executions',
      { workflowId: ID, status: 'error,crashed' },
    ],
    [
      'execution get',
      ['execution', 'get', ID, '--include-data'],
      'GET',
      `/api/v1/executions/${ID}`,
      { includeData: 'true' },
    ],
    [
      'execution retry',
      ['execution', 'retry', ID, '--use-current-workflow'],
      'POST',
      `/api/v1/executions/${ID}/retry`,
      undefined,
      { useCurrentWorkflow: true },
    ],
    ['execution stop', ['execution', 'stop', ID], 'POST', `/api/v1/executions/${ID}/stop`, undefined, {}],
    ['execution delete', ['execution', 'delete', ID], 'DELETE', `/api/v1/executions/${ID}`],
    ['credential list', ['credential', 'list'], 'GET', '/api/v1/credentials'],
    ['credential get', ['credential', 'get', ID], 'GET', `/api/v1/credentials/${ID}`],
    ['credential schema', ['credential', 'schema', 'slackApi'], 'GET', '/api/v1/credentials/schema/slackApi'],
    ['credential delete', ['credential', 'delete', ID], 'DELETE', `/api/v1/credentials/${ID}`],
    [
      'credential transfer',
      ['credential', 'transfer', ID, '--destination-project-id', DEST],
      'PUT',
      `/api/v1/credentials/${ID}/transfer`,
      undefined,
      { destinationProjectId: DEST },
    ],
    ['project list', ['project', 'list'], 'GET', '/api/v1/projects'],
    [
      'project create',
      ['project', 'create', '--name', 'Billing', '--description', 'Invoices'],
      'POST',
      '/api/v1/projects',
      undefined,
      { name: 'Billing', description: 'Invoices' },
    ],
    [
      'project update',
      ['project', 'update', ID, '--name', 'Finance'],
      'PUT',
      `/api/v1/projects/${ID}`,
      undefined,
      { name: 'Finance' },
    ],
    [
      'project delete',
      ['project', 'delete', ID, '--transfer-id', DEST],
      'DELETE',
      `/api/v1/projects/${ID}`,
      { transferId: DEST },
    ],
    ['project members', ['project', 'members', ID], 'GET', `/api/v1/projects/${ID}/users`],
    [
      'project add-member',
      ['project', 'add-member', ID, '--user-id', DEST, '--role', 'project:editor'],
      'POST',
      `/api/v1/projects/${ID}/users`,
      undefined,
      { relations: [{ userId: DEST, role: 'project:editor' }] },
    ],
    [
      'project remove-member',
      ['project', 'remove-member', ID, '--user-id', DEST],
      'DELETE',
      `/api/v1/projects/${ID}/users/${DEST}`,
    ],
    ['tag list', ['tag', 'list'], 'GET', '/api/v1/tags'],
    ['tag get', ['tag', 'get', ID], 'GET', `/api/v1/tags/${ID}`],
    ['tag create', ['tag', 'create', '--name', 'prod'], 'POST', '/api/v1/tags', undefined, { name: 'prod' }],
    [
      'tag update',
      ['tag', 'update', ID, '--name', 'live'],
      'PUT',
      `/api/v1/tags/${ID}`,
      undefined,
      { name: 'live' },
    ],
    ['tag delete', ['tag', 'delete', ID], 'DELETE', `/api/v1/tags/${ID}`],
    [
      'variable list',
      ['variable', 'list', '--project-id', DEST, '--empty'],
      'GET',
      '/api/v1/variables',
      { projectId: DEST, state: 'empty' },
    ],
    [
      'variable create',
      ['variable', 'create', '--key', 'API_URL', '--value', 'x'],
      'POST',
      '/api/v1/variables',
      undefined,
      { key: 'API_URL', value: 'x' },
    ],
    [
      'variable update',
      ['variable', 'update', ID, '--value', 'y'],
      'PUT',
      `/api/v1/variables/${ID}`,
      undefined,
      { value: 'y' },
    ],
    ['variable delete', ['variable', 'delete', ID], 'DELETE', `/api/v1/variables/${ID}`],
    ['data-table list', ['data-table', 'list'], 'GET', '/api/v1/data-tables'],
    ['data-table get', ['data-table', 'get', ID], 'GET', `/api/v1/data-tables/${ID}`],
    ['data-table delete', ['data-table', 'delete', ID], 'DELETE', `/api/v1/data-tables/${ID}`],
    [
      'data-table rows',
      [
        'data-table',
        'rows',
        ID,
        '--filter',
        '{"type":"and","filters":[]}',
        '--search',
        'x',
        '--sort-by',
        'name:asc',
      ],
      'GET',
      `/api/v1/data-tables/${ID}/rows`,
      { filter: '{"type":"and","filters":[]}', search: 'x', sortBy: 'name:asc' },
    ],
    [
      'data-table delete-rows',
      [
        'data-table',
        'delete-rows',
        ID,
        '--filter',
        '{"type":"and","filters":[{"columnName":"a","value":1}]}',
        '--dry-run',
      ],
      'DELETE',
      `/api/v1/data-tables/${ID}/rows/delete`,
      { filter: '{"type":"and","filters":[{"columnName":"a","value":1}]}', dryRun: 'true' },
    ],
    [
      'data-table update-rows (flags)',
      ['data-table', 'update-rows', ID, '--filter', '{"type":"and","filters":[]}', '--data', '{"a":2}'],
      'PATCH',
      `/api/v1/data-tables/${ID}/rows/update`,
      undefined,
      { filter: { type: 'and', filters: [] }, data: { a: 2 }, dryRun: false },
    ],
    [
      'data-table upsert-rows (flags)',
      [
        'data-table',
        'upsert-rows',
        ID,
        '--filter',
        '{"type":"and","filters":[]}',
        '--data',
        '{"a":2}',
        '--dry-run',
      ],
      'POST',
      `/api/v1/data-tables/${ID}/rows/upsert`,
      undefined,
      { filter: { type: 'and', filters: [] }, data: { a: 2 }, dryRun: true },
    ],
    ['user list', ['user', 'list', '--include-role'], 'GET', '/api/v1/users', { includeRole: 'true' }],
    ['user get', ['user', 'get', 'a@b.co'], 'GET', '/api/v1/users/a%40b.co'],
    [
      'source-control pull',
      ['source-control', 'pull', '--force', '--auto-publish', 'published'],
      'POST',
      '/api/v1/source-control/pull',
      undefined,
      { force: true, autoPublish: 'published' },
    ],
    [
      'audit',
      ['audit', '--days-abandoned', '30', '--categories', 'credentials,nodes'],
      'POST',
      '/api/v1/audit',
      undefined,
      { additionalOptions: { daysAbandonedWorkflow: 30, categories: ['credentials', 'nodes'] } },
    ],
    ['audit (no options)', ['audit'], 'POST', '/api/v1/audit', undefined, {}],
  ];

  it.each(cases)('%s', async (_name, argv, method, path, query, body) => {
    const result = await cli(argv);
    expect(result.stderr()).toBe('');
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(last().method).toBe(method);
    expect(last().path).toBe(path);
    if (query) expect(last().query).toMatchObject(query);
    if (body !== undefined) expect(last().body).toEqual(body);
    else if (method === 'GET' || method === 'DELETE') expect(last().body).toBeUndefined();
  });
});

describe('--file and --stdin on create and update', () => {
  const workflow = { name: 'Flow', nodes: [], connections: {} };

  it('workflow create reads --file through CliIo', async () => {
    const result = await cli(['workflow', 'create', '--file', 'wf.json'], {
      files: { 'wf.json': JSON.stringify(workflow) },
    });
    expect(result.code).toBe(0);
    expect(last()).toMatchObject({ method: 'POST', path: '/api/v1/workflows', body: workflow });
  });

  it('workflow update reads --stdin and can switch off the publish', async () => {
    const result = await cli(['workflow', 'update', ID, '--stdin', '--publish-if-active', 'false'], {
      stdin: JSON.stringify(workflow),
    });
    expect(result.code).toBe(0);
    expect(last()).toMatchObject({
      method: 'PUT',
      path: `/api/v1/workflows/${ID}`,
      query: { publishIfActive: 'false' },
      body: workflow,
    });
  });

  it('credential create and data-table create send the file as the body', async () => {
    const credential = { name: 'Slack', type: 'slackApi', data: { token: 'xoxb-secret-value' } };
    const a = await cli(['credential', 'create', '--file', 'c.json'], {
      files: { 'c.json': JSON.stringify(credential) },
    });
    expect(a.code).toBe(0);
    expect(last()).toMatchObject({ method: 'POST', path: '/api/v1/credentials', body: credential });
    const table = { name: 'Leads', columns: [{ name: 'email', type: 'string' }] };
    const b = await cli(['data-table', 'create', '--stdin'], { stdin: JSON.stringify(table) });
    expect(b.code).toBe(0);
    expect(last()).toMatchObject({ method: 'POST', path: '/api/v1/data-tables', body: table });
  });

  it('add-rows takes an array or { data }, and --return-type', async () => {
    await cli(['data-table', 'add-rows', ID, '--stdin'], { stdin: '[{"a":1},{"a":2}]' });
    expect(last()).toMatchObject({
      method: 'POST',
      path: `/api/v1/data-tables/${ID}/rows`,
      body: { data: [{ a: 1 }, { a: 2 }] },
    });
    await cli(['data-table', 'add-rows', ID, '--stdin', '--return-type', 'id'], {
      stdin: '{"data":[{"a":1}]}',
    });
    expect(last().body).toEqual({ data: [{ a: 1 }], returnType: 'id' });
  });

  it('update-rows and upsert-rows take { filter, data } from a file', async () => {
    const body = { filter: { type: 'and', filters: [] }, data: { a: 1 } };
    await cli(['data-table', 'update-rows', ID, '--file', 'b.json'], {
      files: { 'b.json': JSON.stringify(body) },
    });
    expect(last()).toMatchObject({ method: 'PATCH', body });
    await cli(['data-table', 'upsert-rows', ID, '--stdin'], { stdin: JSON.stringify(body) });
    expect(last()).toMatchObject({ method: 'POST', path: `/api/v1/data-tables/${ID}/rows/upsert`, body });
  });

  it('no input, a missing file, both, and bad JSON are usage errors that send nothing', async () => {
    const none = await cli(['workflow', 'create']);
    expect(none.code).toBe(2);
    expect(none.stderr()).toMatch(/--file <path> or --stdin/);
    const missing = await cli(['workflow', 'create', '--file', 'nope.json']);
    expect(missing.code).toBe(2);
    expect(missing.stderr()).toMatch(/File not found: nope.json/);
    const both = await cli(['workflow', 'create', '--file', 'a', '--stdin']);
    expect(both.code).toBe(2);
    const bad = await cli(['workflow', 'create', '--stdin'], { stdin: '{"name": "oops-secret-text' });
    expect(bad.code).toBe(2);
    expect(bad.stderr()).not.toContain('oops-secret-text');
    expect(seen).toHaveLength(0);
  });
});

describe('keys, URL and where they come from', () => {
  it('the key goes only in X-API-KEY, never in the URL', async () => {
    await cli(['workflow', 'list']);
    expect(last().headers['x-api-key']).toBe(KEY);
    expect(last().path).not.toContain(KEY);
    expect(JSON.stringify(last().query)).not.toContain(KEY);
  });

  it('flags beat the environment, the environment beats the file', async () => {
    const files = { '/home/me/.workflow/config.json': JSON.stringify({ url: base, apiKey: 'file-key' }) };
    await cli(['workflow', 'list'], { files, env: { WORKFLOW_API_KEY: 'env-key' } });
    expect(last().headers['x-api-key']).toBe('env-key');
    await cli(['workflow', 'list', '--api-key', 'flag-key'], { files, env: { WORKFLOW_API_KEY: 'env-key' } });
    expect(last().headers['x-api-key']).toBe('flag-key');
    const fromFile = makeIo({ files });
    expect(await run(['workflow', 'list'], fromFile.io)).toBe(0);
    expect(last().headers['x-api-key']).toBe('file-key');
  });

  it('no key is exit code 4 and sends nothing', async () => {
    const made = makeIo();
    expect(await run(['workflow', 'list'], made.io)).toBe(4);
    expect(made.stderr()).toMatch(/No server URL or API key/);
    expect(seen).toHaveLength(0);
  });

  it('refuses plain http to a host that is not this machine, and a bad URL', async () => {
    const http = makeIo({ env: { WORKFLOW_URL: 'http://workflow.example.com', WORKFLOW_API_KEY: KEY } });
    expect(await run(['workflow', 'list'], http.io)).toBe(2);
    expect(http.stderr()).toMatch(/plain http/);
    const bad = makeIo({ env: { WORKFLOW_URL: 'ftp://x', WORKFLOW_API_KEY: KEY } });
    expect(await run(['workflow', 'list'], bad.io)).toBe(2);
  });

  it('does not follow a redirect, so the key never reaches another host', async () => {
    const target = `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal`;
    reply = () => ({ status: 302, headers: { location: target }, body: {} });
    const result = await cli(['workflow', 'list']);
    expect(result.code).toBe(1);
    expect(result.stderr()).toMatch(/redirected/);
    expect(otherHits).toBe(0);
  });

  it('the key is in no stdout, no stderr and no error, even when the server echoes it', async () => {
    reply = () => ({
      status: 400,
      body: { error: { code: 'bad_request', message: `Bad key ${KEY} in request` } },
    });
    const failing = await cli(['workflow', 'list', '--api-key', KEY]);
    expect(failing.code).toBe(2);
    expect(failing.stderr()).not.toContain(KEY);
    expect(failing.stdout()).not.toContain(KEY);
    const help = await cli(['workflow', 'list', '--help']);
    expect(help.stdout() + help.stderr()).not.toContain(KEY);
    // an unusable flag next to the key
    const usage = await cli(['workflow', 'get', '--api-key', KEY]);
    expect(usage.code).toBe(2);
    expect(usage.stderr()).not.toContain(KEY);
    reply = () => ({ body: { data: { id: ID, name: 'x' }, nextCursor: null } });
    const ok = await cli(['workflow', 'get', ID, '--format', 'json']);
    expect(ok.stdout() + ok.stderr()).not.toContain(KEY);
  });
});

describe('config, login and logout', () => {
  it('config set-url and set-api-key write the file with mode 0600, and print no key', async () => {
    const made = makeIo();
    expect(await run(['config', 'set-url', `${base}/`], made.io)).toBe(0);
    expect(made.writeFile).toHaveBeenLastCalledWith('/home/me/.workflow/config.json', expect.any(String), {
      mode: 0o600,
    });
    expect(await run(['config', 'set-api-key', KEY], made.io)).toBe(0);
    expect(made.writeFile).toHaveBeenLastCalledWith('/home/me/.workflow/config.json', expect.any(String), {
      mode: 0o600,
    });
    expect(JSON.parse(made.files.get('/home/me/.workflow/config.json') ?? '{}')).toEqual({
      url: base,
      apiKey: KEY,
    });
    expect(made.stdout() + made.stderr()).not.toContain(KEY);
    const piped = makeIo({ stdin: `${KEY}\n` });
    expect(await run(['config', 'set-api-key', '--stdin'], piped.io)).toBe(0);
    expect(JSON.parse(piped.files.get('/home/me/.workflow/config.json') ?? '{}').apiKey).toBe(KEY);
  });

  it('config show masks the key and says where each value comes from', async () => {
    const result = await cli(['config', 'show', '--json']);
    expect(result.code).toBe(0);
    expect(result.stdout()).not.toContain(KEY);
    const shown = JSON.parse(result.stdout());
    expect(shown).toMatchObject({ url: base, urlSource: 'env', apiKeySource: 'env' });
    expect(shown.apiKey).toContain(`${KEY.length} characters`);
    expect(seen).toHaveLength(0);
  });

  it('login checks GET /users, then saves URL and key with mode 0600', async () => {
    const made = makeIo();
    const code = await run(['login', '--url', base, '--api-key', KEY], made.io);
    expect(code).toBe(0);
    expect(last()).toMatchObject({ method: 'GET', path: '/api/v1/users' });
    expect(last().headers['x-api-key']).toBe(KEY);
    expect(made.writeFile).toHaveBeenCalledWith('/home/me/.workflow/config.json', expect.any(String), {
      mode: 0o600,
    });
    expect(JSON.parse(made.files.get('/home/me/.workflow/config.json') ?? '{}')).toEqual({
      url: base,
      apiKey: KEY,
    });
    expect(made.stdout() + made.stderr()).not.toContain(KEY);
  });

  it('a key the server refuses is not saved, and the exit code is 4', async () => {
    reply = () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Unauthorized' } } });
    const made = makeIo();
    expect(await run(['login', '--url', base, '--api-key', KEY], made.io)).toBe(4);
    expect(made.writeFile).not.toHaveBeenCalled();
    expect(made.stderr()).not.toContain(KEY);
  });

  it('login with no key is a usage error; logout removes the file', async () => {
    const none = makeIo();
    expect(await run(['login'], none.io)).toBe(2);
    const made = makeIo({ files: { '/home/me/.workflow/config.json': '{"url":"x","apiKey":"y"}' } });
    expect(await run(['logout'], made.io)).toBe(0);
    expect(made.files.has('/home/me/.workflow/config.json')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'the real file ends up with mode 0600 (not on Windows)',
    async () => {
      const { mkdtemp, stat, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { nodeIo } = await import('../src/io');
      const dir = await mkdtemp(`${tmpdir()}/wf-cli-`);
      try {
        const io = { ...nodeIo(), home: dir, stdout: () => {}, stderr: () => {}, env: {} };
        expect(await run(['config', 'set-api-key', KEY], io)).toBe(0);
        expect((await stat(`${dir}/.workflow/config.json`)).mode & 0o777).toBe(0o600);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('output', () => {
  const list = {
    data: [{ id: 'a1', name: 'First', active: true, updatedAt: '2026-01-01' }],
    nextCursor: null,
  };

  it('piped output (not a TTY) is JSON; a terminal gets a table', async () => {
    reply = () => ({ body: list });
    const piped = await cli(['workflow', 'list']);
    expect(JSON.parse(piped.stdout())).toEqual(list.data);
    const tty = await cli(['workflow', 'list'], { isTTY: true });
    expect(tty.stdout()).toMatch(/^ID +NAME +ACTIVE +UPDATEDAT/);
    expect(tty.stdout()).toContain('First');
    const noHeader = await cli(['workflow', 'list', '--no-header'], { isTTY: true });
    expect(noHeader.stdout()).toMatch(/^a1 +First/);
  });

  it('--format id-only, --json, --pick and --quiet', async () => {
    reply = () => ({ body: list });
    expect((await cli(['workflow', 'list', '--format', 'id-only'], { isTTY: true })).stdout()).toBe('a1\n');
    expect(JSON.parse((await cli(['workflow', 'list', '--json'], { isTTY: true })).stdout())).toEqual(
      list.data,
    );
    expect((await cli(['workflow', 'list', '--pick', '[].name', '--json'])).stdout()).toBe(
      '[\n  "First"\n]\n',
    );
    const quiet = await cli(['workflow', 'delete', ID, '--quiet']);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout()).toBe('');
  });

  it('--all follows nextCursor; without it the next cursor is a hint on stderr', async () => {
    reply = (req) =>
      req.query.cursor === 'c2'
        ? { body: { data: [{ id: 'b2' }], nextCursor: null } }
        : { body: { data: [{ id: 'a1' }], nextCursor: 'c2' } };
    const all = await cli(['workflow', 'list', '--all', '--format', 'id-only']);
    expect(all.stdout()).toBe('a1\nb2\n');
    expect(seen.map((s) => s.query.cursor)).toEqual([undefined, 'c2']);
    seen = [];
    const one = await cli(['workflow', 'list', '--format', 'id-only']);
    expect(one.stdout()).toBe('a1\n');
    expect(one.stderr()).toContain('--cursor c2');
    expect(seen).toHaveLength(1);
  });

  it('project get and variable get find the row in the list', async () => {
    reply = () => ({ body: { data: [{ id: ID, name: 'Alpha', key: 'K', value: 'v' }], nextCursor: null } });
    const project = await cli(['project', 'get', ID]);
    expect(JSON.parse(project.stdout())).toMatchObject({ id: ID });
    const variable = await cli(['variable', 'get', ID]);
    expect(JSON.parse(variable.stdout())).toMatchObject({ id: ID });
    expect((await cli(['project', 'get', DEST])).code).toBe(6);
  });
});

describe('help and usage', () => {
  it('no words and --help print the usage, --version the version', async () => {
    const none = await cli([]);
    expect(none.code).toBe(0);
    expect(none.stdout()).toContain('Usage: workflow <group> <command>');
    const group = await cli(['workflow', '--help']);
    expect(group.stdout()).toContain('activate');
    const command = await cli(['workflow', 'tags', '--help']);
    expect(command.stdout()).toContain('workflow workflow tags <id>');
    expect((await cli(['--version'])).stdout()).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(seen).toHaveLength(0);
  });

  it('an unknown command, a missing id and a bad flag exit with 2 and send nothing', async () => {
    expect((await cli(['frobnicate'])).code).toBe(2);
    expect((await cli(['workflow', 'frobnicate'])).code).toBe(2);
    const noId = await cli(['workflow', 'get']);
    expect(noId.code).toBe(2);
    expect(noId.stderr()).toMatch(/Missing <id>/);
    expect((await cli(['workflow', 'list', '--format', 'xml'])).code).toBe(2);
    expect((await cli(['workflow', 'list', '--limit', 'ten'])).code).toBe(2);
    expect((await cli(['workflow', 'transfer', ID])).code).toBe(2);
    expect((await cli(['source-control', 'pull', '--auto-publish', 'x'])).code).toBe(2);
    expect((await cli(['data-table', 'delete-rows', ID, '--filter', 'not json'])).code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('a prototype name is not a command', async () => {
    expect((await cli(['constructor'])).code).toBe(2);
    expect((await cli(['workflow', '__proto__'])).code).toBe(2);
  });
});

describe('exit codes for server errors', () => {
  const failWith = (status: number, message = 'Nope') => {
    reply = () => ({ status, body: { error: { code: 'x', message } } });
  };

  it.each([
    [401, 4],
    [403, 5],
    [404, 6],
    [409, 7],
    [400, 2],
    [422, 2],
    [500, 8],
    [503, 8],
  ])('HTTP %i exits %i and prints the server message', async (status, code) => {
    failWith(status, 'User is missing a scope required to perform this action');
    const result = await cli(['workflow', 'get', ID]);
    expect(result.code).toBe(code);
    expect(result.stderr()).toContain('User is missing a scope required to perform this action');
    expect(result.stderr()).toContain(`HTTP ${status}`);
    expect(result.stdout()).toBe('');
  });

  it('a server that cannot be reached exits 8', async () => {
    const dead = makeIo({ env: { WORKFLOW_URL: 'http://127.0.0.1:1', WORKFLOW_API_KEY: KEY } });
    expect(await run(['workflow', 'list'], dead.io)).toBe(8);
    expect(dead.stderr()).toMatch(/Couldn't reach/);
    expect(dead.stderr()).not.toContain(KEY);
  });

  it('a body that is not JSON still gives the status', async () => {
    reply = () => ({ status: 502 });
    const result = await cli(['workflow', 'list']);
    expect(result.code).toBe(8);
    expect(result.stderr()).toContain('HTTP 502');
  });
});
