/**
 * Phase 2 contract step. C0a: instance limits, credential domain error mapping, MIME rows.
 * C0b: 'global' static data layout, runCode static hand-off, cron slots, digest retry, domain hook.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CredentialDomainError,
  ExpressionEvaluator,
  type HttpRequestOptions,
  NodeApiError,
  NodeOperationError,
  type ScheduleSlotStore,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CodeRunnerInput,
  createBaseContext,
  createExecuteContext,
  createTriggerContext,
  DEFAULT_INSTANCE_LIMITS,
  getInstanceLimits,
  guessMimeType,
  HttpClient,
  InlineBinaryDataStore,
  scheduledSlot,
  toNodeApiError,
} from '../src';
import { nodeTypes, services } from './helpers';

// spies that keep the stub behaviour unless a test sets its own
const mocks = vi.hoisted(() => ({
  digest: vi.fn(),
  redirects: vi.fn(),
  allowedDomains: vi.fn(),
  assertUrl: vi.fn(),
}));
vi.mock('../src/http/digest', () => ({ digestAuthorization: mocks.digest }));
vi.mock('../src/http/credential-redirects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/http/credential-redirects')>();
  mocks.redirects.mockImplementation(actual.fetchWithCredentialDomains);
  return { ...actual, fetchWithCredentialDomains: mocks.redirects };
});
vi.mock('@workflow/workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workflow/workflow')>()),
  getCredentialAllowedDomains: mocks.allowedDomains,
  assertCredentialUrlAllowed: mocks.assertUrl,
}));

const MB = 1024 * 1024;

function baseContext(nodeLimits?: Parameters<typeof getInstanceLimits>[0]) {
  const wfNode: WorkflowNode = {
    id: 'n',
    name: 'Node',
    type: 'test.trigger',
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  };
  const workflow = new Workflow({ name: 'w', nodes: [wfNode], connections: {} }, nodeTypes);
  return createBaseContext({
    workflow,
    node: wfNode,
    services: services({ nodeLimits }),
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  });
}

describe('instance limits', () => {
  it('has the planned defaults', () => {
    expect(DEFAULT_INSTANCE_LIMITS).toEqual({
      maxDecompressedBytes: 100 * MB,
      maxArchiveEntries: 1000,
      maxImagePixels: 50_000_000,
      maxImageInputBytes: 25 * MB,
      maxSpreadsheetCells: 1_000_000,
      maxRemoteFileBytes: 100 * MB,
      maxPassthroughBinaryBytes: 52_428_800,
    });
    expect(Object.isFrozen(DEFAULT_INSTANCE_LIMITS)).toBe(true);
  });

  it('overlays the host values on the defaults and ignores invalid ones', () => {
    expect(getInstanceLimits()).toEqual(DEFAULT_INSTANCE_LIMITS);
    const limits = getInstanceLimits({
      maxArchiveEntries: 5,
      maxImagePixels: undefined,
      maxSpreadsheetCells: Number.NaN,
      maxRemoteFileBytes: -1,
    });
    expect(limits).toEqual({ ...DEFAULT_INSTANCE_LIMITS, maxArchiveEntries: 5 });
    limits.maxArchiveEntries = 9;
    expect(getInstanceLimits().maxArchiveEntries).toBe(1000);
  });

  it('reaches nodes through helpers.getInstanceLimits (services.nodeLimits)', () => {
    expect(baseContext().helpers.getInstanceLimits()).toEqual(DEFAULT_INSTANCE_LIMITS);
    expect(baseContext({ maxDecompressedBytes: 1234 }).helpers.getInstanceLimits()).toEqual({
      ...DEFAULT_INSTANCE_LIMITS,
      maxDecompressedBytes: 1234,
    });
  });
});

describe('credential domain errors', () => {
  it('map to a NodeApiError with the message kept', () => {
    const wfNode = { id: 'n', name: 'Node', type: 'x', typeVersion: 1, position: [0, 0], parameters: {} };
    const mapped = toNodeApiError(
      wfNode as WorkflowNode,
      new CredentialDomainError('Domain not allowed: evil.example', 'evil.example'),
    );
    expect(mapped).toBeInstanceOf(NodeApiError);
    expect(mapped.message).toBe('Domain not allowed: evil.example');
    expect((mapped as NodeApiError).cause).toBeInstanceOf(CredentialDomainError);
    const op = new NodeOperationError(wfNode as WorkflowNode, 'x');
    expect(toNodeApiError(wfNode as WorkflowNode, op)).toBe(op);
  });
});

describe('MIME rows', () => {
  it.each([
    ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['a.xls', 'application/vnd.ms-excel'],
    ['a.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['a.webp', 'image/webp'],
    ['a.bmp', 'image/bmp'],
    ['a.tif', 'image/tiff'],
    ['a.TIFF', 'image/tiff'],
    ['a.gz', 'application/gzip'],
    ['a.tgz', 'application/gzip'],
    ['a.tar', 'application/x-tar'],
  ])('guesses %s', (fileName, mime) => {
    expect(guessMimeType(fileName)).toBe(mime);
  });

  it.each([
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.ms-excel', 'xls'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
    ['image/webp', 'webp'],
    ['image/bmp', 'bmp'],
    ['image/tiff', 'tiff'],
    ['application/gzip', 'gz'],
    ['application/x-tar', 'tar'],
  ])('stores %s with extension %s', async (mimeType, ext) => {
    const binary = await new InlineBinaryDataStore().store(new Uint8Array([1]), { mimeType });
    expect(binary.fileExtension).toBe(ext);
  });
});

// ---------------------------------------------------------------------------------------------
// C0b: shared logic (static data layout and hand-off, cron slots, digest retry, domain hook)

const executeCallbacks = {
  getInputConnectionData: async () => undefined,
  putExecutionToWait: () => {},
  continueOnFail: () => false,
  addExecutionHints: () => {},
};

function codeNodeWorkflow(staticData: Record<string, unknown> = {}) {
  const wfNode: WorkflowNode = {
    id: 'n',
    name: 'Code',
    type: 'test.trigger',
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  };
  const workflow = new Workflow(
    { name: 'w', nodes: [wfNode], connections: {}, staticData: staticData as never },
    nodeTypes,
  );
  return { workflow, wfNode };
}

describe('workflow static data', () => {
  it("keeps the 'global' scope under staticData.global (n8n layout)", () => {
    const { workflow, wfNode } = codeNodeWorkflow({ 'node:Other': { a: 1 } });
    const ctx = createBaseContext({
      workflow,
      node: wfNode,
      services: services(),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    });
    const global = ctx.getWorkflowStaticData('global');
    global.count = 1;
    ctx.getWorkflowStaticData('node').seen = true;
    expect(workflow.staticData).toEqual({
      'node:Other': { a: 1 },
      global: { count: 1 },
      'node:Code': { seen: true },
    });
    expect(ctx.getWorkflowStaticData('global')).toBe(global);
  });

  it('hands copies to the code runner and takes the new contents back in place', async () => {
    const { workflow, wfNode } = codeNodeWorkflow({ global: { count: 1 }, 'node:Code': { last: 'a' } });
    const globalBefore = workflow.staticData.global;
    const seen: CodeRunnerInput[] = [];
    const codeRunner = {
      async run(input: CodeRunnerInput) {
        seen.push(input);
        input.staticData!.global.count = 2;
        input.staticData!.node.last = 'b';
        // the host data is untouched until the runner reports a finished run
        expect(workflow.staticData).toEqual({ global: { count: 1 }, 'node:Code': { last: 'a' } });
        input.onStaticData!({ global: { count: 2 }, node: { last: 'b', extra: true } });
        return [];
      },
    };
    const ctx = createExecuteContext(
      {
        workflow,
        node: wfNode,
        services: services({ codeRunner }),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      executeCallbacks,
    );
    await ctx.runCode({ code: 'return []', mode: 'runOnceForAllItems' });
    expect(seen[0].staticData).toEqual({ global: { count: 2 }, node: { last: 'b' } });
    expect(workflow.staticData).toEqual({ global: { count: 2 }, 'node:Code': { last: 'b', extra: true } });
    expect(workflow.staticData.global).toBe(globalBefore);
  });

  it('adds no static data keys when the code does not change them', async () => {
    const { workflow, wfNode } = codeNodeWorkflow();
    const codeRunner = {
      async run(input: CodeRunnerInput) {
        expect(input.staticData).toEqual({ global: {}, node: {} });
        return [];
      },
    };
    const ctx = createExecuteContext(
      {
        workflow,
        node: wfNode,
        services: services({ codeRunner }),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      executeCallbacks,
    );
    await ctx.runCode({ code: 'return []', mode: 'runOnceForAllItems' });
    expect(workflow.staticData).toEqual({});
  });
});

describe('trigger cron slots', () => {
  function triggerContext(timezone?: string, scheduleSlots?: ScheduleSlotStore) {
    const wfNode: WorkflowNode = {
      id: 'n',
      name: 'Schedule',
      type: 'test.trigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    };
    const workflow = new Workflow(
      { name: 'w', nodes: [wfNode], connections: {}, settings: timezone ? { timezone } : {} },
      nodeTypes,
    );
    const errors: Error[] = [];
    const ctx = createTriggerContext(
      {
        workflow,
        node: wfNode,
        services: services(),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      { emit: () => {}, emitError: (e) => errors.push(e), activationMode: 'init', scheduleSlots },
    );
    return { ctx, errors };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the scheduled time of each tick as the slot', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:59.400Z') });
    const { ctx, errors } = triggerContext('Asia/Kolkata');
    const slots: Date[] = [];
    const stop = ctx.registerCron('0 * * * * *', (slot) => slots.push(slot));
    await vi.advanceTimersByTimeAsync(61_000);
    stop();
    expect(errors).toEqual([]);
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-01-01T00:01:00.000Z',
      '2026-01-01T00:02:00.000Z',
    ]);
  });

  it('gives a late tick the slot it was scheduled for', () => {
    expect(scheduledSlot('0 * * * * *', new Date('2026-01-01T00:01:02.300Z'), 'UTC').toISOString()).toBe(
      '2026-01-01T00:01:00.000Z',
    );
    expect(scheduledSlot('0 * * * * *', new Date('2026-01-01T00:01:00.000Z'), 'UTC').toISOString()).toBe(
      '2026-01-01T00:01:00.000Z',
    );
  });

  it('lists the slots between two times in the workflow timezone', () => {
    const { ctx } = triggerContext('Asia/Kolkata');
    const after = new Date('2026-01-01T04:00:00.000Z');
    const before = new Date('2026-01-04T04:00:00.000Z');
    // 09:30 in Kolkata is 04:00 UTC; `after` and `before` themselves are excluded
    expect(ctx.getCronSlots('30 9 * * *', after, before).map((d) => d.toISOString())).toEqual([
      '2026-01-02T04:00:00.000Z',
      '2026-01-03T04:00:00.000Z',
    ]);
    expect(ctx.getCronSlots('30 9 * * *', new Date('2026-01-01T00:00:00Z'), before, 1)).toHaveLength(1);
    expect(ctx.getCronSlots('30 9 * * *', before, after)).toEqual([]);
  });

  it('returns at most 100 slots, oldest first', () => {
    const { ctx } = triggerContext();
    const slots = ctx.getCronSlots(
      '* * * * *',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-08T00:00:00Z'),
      500,
    );
    expect(slots).toHaveLength(100);
    expect(slots[0].toISOString()).toBe('2026-01-01T00:01:00.000Z');
    expect(slots[99].toISOString()).toBe('2026-01-01T01:40:00.000Z');
  });

  it('exposes the slot store given by the host', () => {
    const store: ScheduleSlotStore = {
      last: async () => undefined,
      claim: async () => true,
      reset: async () => {},
      defaultGraceSeconds: 60,
    };
    expect(triggerContext(undefined, store).ctx.scheduleSlots).toBe(store);
    expect(triggerContext().ctx.scheduleSlots).toBeUndefined();
  });
});

describe('HttpClient digest scheme and credential domains', () => {
  const received: Array<{ method?: string; url?: string; authorization?: string; body: string }> = [];
  let server: http.Server;
  let base = '';
  const client = new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
        if (req.url?.startsWith('/basic')) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }).end('no');
        } else if (req.headers.authorization === 'Digest ok') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        } else {
          res
            .writeHead(401, { 'www-authenticate': 'Digest realm="r", nonce="n", qop="auth"' })
            .end('challenge');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    received.length = 0;
    mocks.digest.mockReset();
    mocks.redirects.mockClear();
  });

  it('sends no Basic header for the digest scheme and stops when no answer is built', async () => {
    mocks.digest.mockReturnValue(undefined);
    await expect(
      client.request({ url: `${base}/d`, auth: { username: 'u', password: 'p', scheme: 'digest' } }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(received).toHaveLength(1);
    expect(received[0].authorization).toBeUndefined();
  });

  it('answers a Digest challenge once with the same body', async () => {
    mocks.digest.mockReturnValue('Digest ok');
    const result = await client.request({
      url: `${base}/d?q=1`,
      method: 'POST',
      body: { a: 1 },
      auth: { username: 'u', password: 'p', scheme: 'digest' },
    });
    expect(result).toEqual({ ok: true });
    expect(received.map((r) => r.authorization)).toEqual([undefined, 'Digest ok']);
    expect(received.map((r) => r.body)).toEqual(['{"a":1}', '{"a":1}']);
    expect(mocks.digest).toHaveBeenCalledTimes(1);
    expect(mocks.digest).toHaveBeenCalledWith('Digest realm="r", nonce="n", qop="auth"', {
      method: 'POST',
      uri: '/d?q=1',
      username: 'u',
      password: 'p',
    });
  });

  it('never loops when the answer is refused', async () => {
    mocks.digest.mockReturnValue('Digest wrong');
    const response = (await client.request({
      url: `${base}/d`,
      auth: { username: 'u', password: 'p', scheme: 'digest' },
      ignoreHttpStatusErrors: true,
      returnFullResponse: true,
    })) as { statusCode: number };
    expect(response.statusCode).toBe(401);
    expect(received).toHaveLength(2);
  });

  it('does not retry a non-Digest challenge, and Basic stays the default', async () => {
    await expect(
      client.request({ url: `${base}/basic`, auth: { username: 'u', password: 'p', scheme: 'digest' } }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.digest).not.toHaveBeenCalled();
    await expect(
      client.request({ url: `${base}/basic`, auth: { username: 'u', password: 'p' } }),
    ).rejects.toThrow();
    expect(received.map((r) => r.authorization)).toEqual([undefined, `Basic ${btoa('u:p')}`]);
  });

  it('routes requests with allowedDomains through fetchWithCredentialDomains', async () => {
    mocks.digest.mockReturnValue('Digest ok');
    await client.request({
      url: `${base}/d`,
      auth: { username: 'u', password: 'p', scheme: 'digest' },
      allowedDomains: ['127.0.0.1'],
    });
    // the first request and the digest retry both go through the per-hop check
    expect(mocks.redirects).toHaveBeenCalledTimes(2);
    const [url, , list] = mocks.redirects.mock.calls[0];
    expect(String(url)).toBe(`${base}/d`);
    expect(list).toEqual(['127.0.0.1']);
    mocks.redirects.mockClear();
    await client.request({ url: `${base}/d`, auth: { username: 'u', password: 'p', scheme: 'digest' } });
    expect(mocks.redirects).not.toHaveBeenCalled();
  });
});

describe('credential domain hook in httpRequestWithAuthentication', () => {
  function context(credentialType: string, data: Record<string, unknown>) {
    const calls: string[] = [];
    const sent: HttpRequestOptions[] = [];
    const fakeHttp = {
      request: async (options: HttpRequestOptions) => {
        calls.push('request');
        sent.push(options);
        return { ok: true };
      },
    } as unknown as HttpClient;
    const wfNode: WorkflowNode = {
      id: 'n',
      name: 'Node',
      type: 'test.trigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
      credentials: { [credentialType]: { id: 'c1', name: 'cred' } },
    };
    const workflow = new Workflow({ name: 'w', nodes: [wfNode], connections: {} }, nodeTypes);
    const ctx = createBaseContext({
      workflow,
      node: wfNode,
      services: services({ http: fakeHttp, credentials: { get: async () => data, update: async () => {} } }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    });
    mocks.assertUrl.mockImplementation((url: string, list?: string[]) => {
      calls.push('assert');
      if (list && !list.includes(new URL(url).hostname)) throw new CredentialDomainError('blocked');
    });
    return { ctx, calls, sent };
  }

  beforeEach(() => {
    mocks.allowedDomains.mockReset();
    mocks.assertUrl.mockReset();
  });

  it('checks the URL before signing and passes the list on (generic auth)', async () => {
    mocks.allowedDomains.mockReturnValue(['api.example.com']);
    const { ctx, calls, sent } = context('apiKey', { key: 'k' });
    await ctx.helpers.httpRequestWithAuthentication('apiKey', {
      url: 'https://api.example.com/x',
      credentialScope: 'userUrl',
    });
    expect(mocks.allowedDomains).toHaveBeenCalledWith({ key: 'k' }, { userUrl: true });
    expect(calls).toEqual(['assert', 'request']);
    expect(sent[0].allowedDomains).toEqual(['api.example.com']);
    expect(sent[0].headers).toMatchObject({ 'x-api-key': 'k' });
  });

  it('never sends a blocked request (generic auth and OAuth2)', async () => {
    mocks.allowedDomains.mockReturnValue(['api.example.com']);
    const generic = context('apiKey', { key: 'k' });
    await expect(
      generic.ctx.helpers.httpRequestWithAuthentication('apiKey', { url: 'https://evil.example/x' }),
    ).rejects.toBeInstanceOf(NodeApiError);
    expect(generic.calls).toEqual(['assert']);
    expect(mocks.allowedDomains).toHaveBeenCalledWith({ key: 'k' }, { userUrl: false });

    const oauth = context('oAuth2Api', { oauthTokenData: { access_token: 't' } });
    await expect(
      oauth.ctx.helpers.httpRequestWithAuthentication('oAuth2Api', { url: 'https://evil.example/x' }),
    ).rejects.toBeInstanceOf(NodeApiError);
    expect(oauth.calls).toEqual(['assert']);
  });

  it('passes the list to OAuth2 requests and leaves unrestricted credentials alone', async () => {
    mocks.allowedDomains.mockReturnValue(['api.example.com']);
    const oauth = context('oAuth2Api', { oauthTokenData: { access_token: 't' } });
    await oauth.ctx.helpers.httpRequestWithAuthentication('oAuth2Api', { url: 'https://api.example.com/x' });
    expect(oauth.calls).toEqual(['assert', 'request']);
    expect(oauth.sent[0].allowedDomains).toEqual(['api.example.com']);
    expect(oauth.sent[0].headers).toMatchObject({ authorization: 'Bearer t' });

    mocks.allowedDomains.mockReturnValue(undefined);
    const open = context('apiKey', { key: 'k' });
    await open.ctx.helpers.httpRequestWithAuthentication('apiKey', { url: 'https://any.example/x' });
    expect('allowedDomains' in open.sent[0]).toBe(false);
  });
});
