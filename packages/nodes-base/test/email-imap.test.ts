/** P4-12 Email Trigger (IMAP), through the real imapflow on a real socket against test/imap-server.ts. */
import dns from 'node:dns';
import { createTriggerContext, type ExecutionServices, HttpClient } from '@workflow/core';
import {
  type AllowedHost,
  type CredentialTestContext,
  type DataObject,
  ExpressionEvaluator,
  type InstanceLimits,
  type Item,
  type NodeType,
  type TriggerResponse,
  Workflow,
} from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import { allOf, parseCustomRules } from '../src/utils/imap-search';
import { node, nodeTypes, testServices } from './harness';
import { ImapTestServer, type ImapServerOptions } from './imap-server';
import { localHttp } from './servers';

const nodeType = (): NodeType => nodes.find((n) => n.description.name === 'core.emailReadImap')!;

function plainMail(subject: string, options: { from?: string; to?: string; body?: string } = {}): string {
  return [
    `From: ${options.from ?? 'Ann Lee <ann@example.test>'}`,
    `To: ${options.to ?? 'Bob <bob@example.test>'}`,
    `Subject: ${subject}`,
    'Date: Tue, 03 Nov 2026 10:00:00 +0000',
    'Message-ID: <m1@example.test>',
    'X-Custom: custom value',
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.body ?? `Body of ${subject}`,
    '',
  ].join('\r\n');
}

const MIXED_MAIL = [
  'From: =?UTF-8?B?QW5uIEzDqWU=?= <ann@example.test>',
  'To: Bob <bob@example.test>',
  'Cc: Cid <cid@example.test>',
  'Subject: =?UTF-8?B?UmVwb3J0IOKCrDU=?=',
  'Date: Tue, 03 Nov 2026 10:00:00 +0000',
  'X-Custom: custom value',
  'X-Encoded: =?UTF-8?B?Y2Fmw6k=?=',
  'X-Folded: first',
  ' second',
  '__proto__: polluted',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Plain words',
  '--inner',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Html words</p>',
  '--inner--',
  '--outer',
  'Content-Type: text/csv; name="data.csv"',
  'Content-Disposition: attachment; filename="data.csv"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('a,b\n1,2\n').toString('base64'),
  '--outer',
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-ID: <logo@x>',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('fake png bytes').toString('base64'),
  '--outer--',
  '',
].join('\r\n');

interface HarnessOptions {
  mode?: 'manual' | 'activate';
  http?: HttpClient;
  staticData?: DataObject;
  limits?: Partial<InstanceLimits>;
  creds?: DataObject;
  binaryData?: ExecutionServices['binaryData'];
}

const servers: ImapTestServer[] = [];
const closers: Array<() => unknown> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function newServer(options: ImapServerOptions = {}): Promise<ImapTestServer> {
  const server = new ImapTestServer(options);
  await server.start();
  servers.push(server);
  return server;
}

const credsFor = (server: ImapTestServer, extra: DataObject = {}): DataObject => ({
  user: server.user,
  password: server.password,
  host: '127.0.0.1',
  port: server.port,
  secure: false,
  allowUnauthorizedCerts: false,
  ...extra,
});

function harness(server: ImapTestServer, parameters: DataObject, options: HarnessOptions = {}) {
  const creds = { imap: options.creds ?? credsFor(server) };
  const logs: string[] = [];
  const record = (message: unknown, meta?: unknown) =>
    void logs.push(`${String(message)} ${meta === undefined ? '' : JSON.stringify(meta)}`);
  const logger = { debug: record, info: record, warn: record, error: record };
  const wfNode = node('Email Trigger', 'core.emailReadImap', parameters, [0, 0], {
    credentials: { imap: { id: 'imap', name: 'imap' } },
  });
  const workflow = new Workflow(
    { id: 'wf1', name: 'test', nodes: [wfNode], connections: {}, staticData: options.staticData ?? {} },
    nodeTypes,
  );
  const runs: Item[][] = [];
  const errors: Error[] = [];
  const atEmit: Array<{ seen: boolean[]; cursor: unknown }> = [];
  const ctx = createTriggerContext(
    {
      workflow,
      node: wfNode,
      services: testServices(creds, {
        mode: options.mode === 'manual' ? 'manual' : 'trigger',
        http: options.http ?? localHttp(),
        logger: logger as never,
        nodeLimits: options.limits,
        ...(options.binaryData ? { binaryData: options.binaryData } : {}),
      }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    {
      activationMode: options.mode ?? 'activate',
      emit: (data) => {
        const items = data[0] ?? [];
        atEmit.push({
          seen: items.map((i) => server.isSeen((i.json.attributes as DataObject | undefined)?.uid as number)),
          cursor: ctx.getWorkflowStaticData('node').lastMessageUid,
        });
        runs.push(items);
      },
      emitError: (error) => void errors.push(error),
    },
  );
  return { ctx, runs, errors, logs, atEmit };
}

async function start(server: ImapTestServer, parameters: DataObject = {}, options: HarnessOptions = {}) {
  const h = harness(server, parameters, options);
  const response = (await nodeType().trigger!(h.ctx)) as TriggerResponse;
  closers.push(() => response.closeFunction?.());
  return { ...h, response };
}

const until = (check: () => boolean, timeout = 15_000) =>
  vi.waitFor(() => expect(check()).toBe(true), { timeout, interval: 20 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** an HTTP client whose guard answers per host name, as the real one does */
class ScriptedGuard extends HttpClient {
  checked: string[] = [];
  constructor(private answer: (host: string) => AllowedHost | Error) {
    super({ ssrf: { allow: ['127.0.0.1'] } });
  }
  override async resolveAllowedHost(host: string): Promise<AllowedHost> {
    this.checked.push(host);
    const answer = this.answer(host);
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

const pinnedLoopback = (): AllowedHost => ({
  addresses: [{ address: '127.0.0.1', family: 4 }],
  lookup(_hostname, options, callback) {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  },
});

const credentialContext = (
  http: HttpClient,
  signal = new AbortController().signal,
): CredentialTestContext => ({
  helpers: {
    resolveAllowedHost: (host) => http.resolveAllowedHost(host),
    assertHostAllowed: async () => undefined,
  },
  logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
  signal,
  getTenantId: () => 't1',
});

const credentialTest = (data: DataObject, ctx: CredentialTestContext) =>
  nodeType().methods!.credentialTest!.imapCredentialTest(ctx, { type: 'imap', data });

describe('description', () => {
  const field = (name: string) => nodeType().description.properties.find((p) => p.name === name);

  it('has the fields of n8n v2.2 with their defaults', () => {
    expect(field('mailbox')?.default).toBe('INBOX');
    expect(field('postProcessAction')?.default).toBe('read');
    expect(field('postProcessAction')?.options?.map((o) => (o as { value: string }).value)).toEqual([
      'read',
      'nothing',
    ]);
    expect(field('downloadAttachments')).toMatchObject({
      default: false,
      displayOptions: { show: { format: ['simple'] } },
    });
    expect(field('format')?.default).toBe('simple');
    expect(field('format')?.options?.map((o) => (o as { value: string }).value)).toEqual([
      'raw',
      'resolved',
      'simple',
    ]);
    const prefixes = nodeType().description.properties.filter(
      (p) => p.name === 'dataPropertyAttachmentsPrefixName',
    );
    expect(prefixes.map((p) => p.default)).toEqual(['attachment_', 'attachment_']);
    expect(prefixes.map((p) => p.displayOptions?.show)).toEqual([
      { format: ['resolved'] },
      { format: ['simple'], downloadAttachments: [true] },
    ]);
    const options = field('options')?.options as Array<{ name: string; default: unknown }>;
    expect(options.map((o) => [o.name, o.default])).toEqual([
      ['customEmailConfig', '["UNSEEN"]'],
      ['forceReconnect', 60],
      ['trackLastMessageId', true],
    ]);
  });

  it('names its credential test, and the credential has n8n fields', async () => {
    expect(nodeType().description.credentials).toEqual([
      { name: 'imap', required: true, testedBy: 'imapCredentialTest' },
    ]);
    const { imap } = await import('../src/credentials/imap.credentials');
    expect(imap.properties.map((p) => [p.name, p.default])).toEqual([
      ['user', ''],
      ['password', ''],
      ['host', ''],
      ['port', 993],
      ['secure', true],
      ['allowUnauthorizedCerts', false],
    ]);
    expect(imap.properties.find((p) => p.name === 'password')?.typeOptions?.password).toBe(true);
  });
});

describe('Simple format', () => {
  it('gives text, html, top-level headers, other headers in metadata and the uid', async () => {
    const server = await newServer();
    const mail = server.addMail(MIXED_MAIL);
    const { runs } = await start(server);
    await until(() => runs.length === 1);
    const { json, binary } = runs[0][0];
    expect(json.textPlain).toContain('Plain words');
    expect(json.textHtml).toContain('<p>Html words</p>');
    expect(json.attributes).toEqual({ uid: mail.uid });
    expect(json.subject).toBe('Report €5');
    expect(json.from).toContain('Ann Lée');
    expect(json.from).toContain('ann@example.test');
    expect(json.to).toContain('bob@example.test');
    expect(json.cc).toContain('cid@example.test');
    expect(json.date).toBe('Tue, 03 Nov 2026 10:00:00 +0000');
    const metadata = json.metadata as DataObject;
    expect(metadata['x-custom']).toBe('custom value');
    expect(metadata['x-encoded']).toBe('café');
    expect(metadata['x-folded']).toBe('first second');
    expect(metadata.subject).toBeUndefined();
    expect(Object.getOwnPropertyNames(metadata)).not.toContain('__proto__');
    expect(({} as DataObject).polluted).toBeUndefined();
    expect(binary).toBeUndefined();
  });

  it('keeps empty text fields for a part the mail does not have', async () => {
    const server = await newServer();
    server.addMail(
      [
        'From: a@example.test',
        'Subject: only html',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<b>x</b>',
        '',
      ].join('\r\n'),
    );
    const { runs } = await start(server);
    await until(() => runs.length === 1);
    expect(runs[0][0].json.textPlain).toBe('');
    expect(runs[0][0].json.textHtml).toContain('<b>x</b>');
  });

  it('downloads only real attachments when asked, under the prefix', async () => {
    const server = await newServer();
    server.addMail(MIXED_MAIL);
    const { runs } = await start(server, {
      downloadAttachments: true,
      dataPropertyAttachmentsPrefixName: 'file_',
    });
    await until(() => runs.length === 1);
    const { binary } = runs[0][0];
    expect(Object.keys(binary ?? {})).toEqual(['file_0']);
    expect(binary?.file_0.fileName).toBe('data.csv');
    expect(binary?.file_0.mimeType).toBe('text/csv');
    expect(Buffer.from(binary!.file_0.data, 'base64').toString()).toBe('a,b\n1,2\n');
  });
});

describe('Resolved format', () => {
  it('gives the parsed mail with raw header lines, a JSON-safe date and binaries for all attachments', async () => {
    const server = await newServer();
    const mail = server.addMail(MIXED_MAIL);
    const { runs } = await start(server, { format: 'resolved' });
    await until(() => runs.length === 1);
    const { json, binary } = runs[0][0];
    expect(json.attributes).toEqual({ uid: mail.uid });
    expect(json.subject).toBe('Report €5');
    expect(json.date).toBe('2026-11-03T10:00:00.000Z');
    expect((json.from as DataObject).text).toContain('Ann Lée');
    expect(((json.from as { value: DataObject[] }).value[0] as DataObject).address).toBe('ann@example.test');
    expect(json.text).toContain('Plain words');
    expect(json.html).toContain('Html words');
    expect(json.headers).toMatchObject({ 'x-custom': 'X-Custom: custom value' });
    expect(Object.getOwnPropertyNames(json.headers)).not.toContain('__proto__');
    expect(json.headerLines).toBeUndefined();
    expect(json.attachments).toBeUndefined();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(Object.keys(binary ?? {})).toEqual(['attachment_0', 'attachment_1']);
    expect(binary?.attachment_0.fileName).toBe('data.csv');
    expect(binary?.attachment_1.fileName).toBe('logo.png');
  });

  it('uses the prefix', async () => {
    const server = await newServer();
    server.addMail(MIXED_MAIL);
    const { runs } = await start(server, { format: 'resolved', dataPropertyAttachmentsPrefixName: 'doc' });
    await until(() => runs.length === 1);
    expect(Object.keys(runs[0][0].binary ?? {})).toEqual(['doc0', 'doc1']);
  });
});

describe('RAW format', () => {
  it('gives only the text of the mail body', async () => {
    const server = await newServer();
    const mail = server.addMail(plainMail('raw one', { body: 'Line one\r\nLine two' }));
    const { runs, ctx } = await start(server, { format: 'raw' });
    await until(() => runs.length === 1);
    expect(runs[0][0].json).toEqual({ raw: 'Line one\r\nLine two\r\n' });
    expect(ctx.getWorkflowStaticData('node').lastMessageUid).toBe(mail.uid);
  });
});

describe('custom rules', () => {
  it('reads unseen mail by default', async () => {
    const server = await newServer();
    server.addMail(plainMail('old'), { seen: true });
    const fresh = server.addMail(plainMail('new'));
    const { runs } = await start(server);
    await until(() => runs.length === 1);
    expect(runs[0].map((i) => (i.json.attributes as DataObject).uid)).toEqual([fresh.uid]);
  });

  it('sends the rules to the server and starts runs only for what matches', async () => {
    const server = await newServer();
    server.addMail(plainMail('wanted', { from: 'boss@example.test' }));
    server.addMail(plainMail('other', { from: 'someone@example.test' }));
    server.addMail(plainMail('wanted seen', { from: 'boss@example.test' }), { seen: true });
    const { runs } = await start(server, {
      options: { customEmailConfig: '["ALL", ["FROM", "boss@example.test"], ["!SUBJECT", "seen"]]' },
    });
    await until(() => runs.length === 1);
    expect(runs[0].map((i) => i.json.subject)).toEqual(['wanted']);
    expect(server.commandsWith('UID SEARCH')[0]).toContain('FROM');
  });

  it('holds OR, nested OR and two ORs together on the wire', async () => {
    const server = await newServer();
    server.addMail(plainMail('a1', { from: 'a@example.test' }));
    server.addMail(plainMail('b2', { from: 'b@example.test' }));
    server.addMail(plainMail('a2', { from: 'a@example.test' }));
    server.addMail(plainMail('c1', { from: 'c@example.test' }));
    const { runs } = await start(server, {
      options: {
        customEmailConfig: JSON.stringify([
          ['OR', ['FROM', 'a@example.test'], ['FROM', 'b@example.test']],
          ['OR', ['SUBJECT', '1'], ['SUBJECT', '2']],
          ['OR', ['SUBJECT', 'a'], ['SUBJECT', 'b']],
          ['NOT', ['SUBJECT', 'a2']],
        ]),
      },
    });
    await until(() => runs.length === 1);
    expect(runs[0].map((i) => i.json.subject)).toEqual(['a1', 'b2']);
  });

  it('fails the start on rules that are not JSON, with n8n text', async () => {
    const server = await newServer();
    await expect(start(server, { options: { customEmailConfig: '["UNSEEN"' } })).rejects.toThrow(
      'Custom email config is not valid JSON.',
    );
    expect(server.connections).toBe(0);
  });

  it('a server that refuses the search goes to the error path, without its text', async () => {
    const server = await newServer();
    server.refuseSearch = true;
    const { errors, response } = await start(server);
    await until(() => errors.length === 1);
    expect(errors[0].message).toContain('refused the search');
    expect(errors[0].message).not.toContain('Fake IMAP');
    await response.closeFunction?.();
  });
});

describe('parseCustomRules', () => {
  it.each<[unknown[], unknown]>([
    [['UNSEEN'], { seen: false }],
    [['seen'], { seen: true }],
    [['ALL'], { all: true }],
    [['ANSWERED'], { answered: true }],
    [['UNANSWERED'], { answered: false }],
    [['DELETED'], { deleted: true }],
    [['UNDELETED'], { deleted: false }],
    [['DRAFT'], { draft: true }],
    [['UNDRAFT'], { draft: false }],
    [['FLAGGED'], { flagged: true }],
    [['UNFLAGGED'], { flagged: false }],
    [['NEW'], { new: true }],
    [['OLD'], { old: true }],
    [['RECENT'], { recent: true }],
    [[['FROM', 'a']], { from: 'a' }],
    [[['TO', 'a']], { to: 'a' }],
    [[['CC', 'a']], { cc: 'a' }],
    [[['BCC', 'a']], { bcc: 'a' }],
    [[['SUBJECT', 'a']], { subject: 'a' }],
    [[['BODY', 'a']], { body: 'a' }],
    [[['TEXT', 'a']], { text: 'a' }],
    [[['LARGER', 10]], { larger: 10 }],
    [[['SMALLER', '10']], { smaller: 10 }],
    [[['UID', '1:5']], { uid: '1:5' }],
    [['1:5'], { seq: '1:5' }],
    [[7], { seq: '7' }],
    [[['KEYWORD', 'a']], { keyword: 'a' }],
    [[['UNKEYWORD', 'a']], { unKeyword: 'a' }],
    [[['HEADER', 'X-A', 'b']], { header: { 'X-A': 'b' } }],
    [['!SEEN'], { not: { seen: true } }],
    [[['!FROM', 'a']], { not: { from: 'a' } }],
    [[['NOT', 'SEEN']], { not: { seen: true } }],
    [[['OR', 'SEEN', ['FROM', 'a']]], { or: [{ seen: true }, { from: 'a' }] }],
    [
      [
        [
          ['FROM', 'a'],
          ['TO', 'b'],
        ],
      ],
      { from: 'a', to: 'b' },
    ],
    [[], { all: true }],
  ])('%j', (rules, expected) => {
    expect(parseCustomRules(JSON.stringify(rules))).toEqual(expected);
  });

  it.each([
    ['SINCE', 'since'],
    ['BEFORE', 'before'],
    ['ON', 'on'],
    ['SENTSINCE', 'sentSince'],
    ['SENTBEFORE', 'sentBefore'],
    ['SENTON', 'sentOn'],
  ])('%s keeps the day that was written, in any time zone', (rule, key) => {
    const fromName = parseCustomRules(JSON.stringify([[rule, 'May 20, 2018']])) as Record<string, Date>;
    const fromIso = parseCustomRules(JSON.stringify([[rule, '2018-05-20']])) as Record<string, Date>;
    expect(fromName[key].toISOString()).toBe('2018-05-20T00:00:00.000Z');
    expect(fromIso[key].toISOString()).toBe('2018-05-20T00:00:00.000Z');
  });

  it('accepts an array from an expression', () => {
    expect(parseCustomRules(['UNSEEN'])).toEqual({ seen: false });
  });

  it('a header named __proto__ stays plain data', () => {
    const parsed = parseCustomRules('[["HEADER", "__proto__", "x"]]');
    expect(Object.getOwnPropertyNames(parsed.header)).toContain('__proto__');
    expect(({} as DataObject).x).toBeUndefined();
  });

  it.each<[string, string]>([
    ['["UNSEEN"', 'Custom email config is not valid JSON.'],
    ['{"a":1}', 'must be a JSON array'],
    ['"UNSEEN"', 'must be a JSON array'],
    ['["NOPE"]', 'unknown rule'],
    ['[["FROM"]]', 'FROM needs a value'],
    ['[["FROM", "a\\r\\nb"]]', 'FROM needs a value'],
    ['[["LARGER", "many"]]', 'LARGER needs a number'],
    ['[["SINCE", "not a date"]]', 'SINCE needs a date'],
    ['[["UID", "1 2"]]', 'UID needs a set'],
    ['[["HEADER", "a"]]', 'HEADER needs a name and a value'],
    ['[["OR", "SEEN"]]', 'OR needs two rules'],
    ['[["NOT"]]', 'NOT needs one rule'],
    ['[[]]', 'not valid'],
    ['[null]', 'not valid'],
    ['[["SEEN", "x"]]', 'SEEN takes no value'],
  ])('%s is refused', (text, message) => {
    expect(() => parseCustomRules(text)).toThrow(message);
  });

  it('allOf keeps every rule when keys clash', () => {
    const merged = allOf([{ from: 'a' }, { from: 'b' }, { from: 'c' }]);
    expect(merged).toEqual({ from: 'a', or: [{ from: 'b', or: [{ from: 'c' }] }] });
    expect(allOf([{ seen: false }, {}])).toEqual({ seen: false });
  });
});

describe('Action', () => {
  it('Mark as Read sets \\Seen and the cursor before the run starts, and never fetches with a plain BODY', async () => {
    const server = await newServer();
    const mail = server.addMail(plainMail('one'));
    const { runs, atEmit } = await start(server);
    await until(() => runs.length === 1);
    expect(atEmit[0]).toEqual({ seen: [true], cursor: mail.uid });
    expect(server.commandsWith('+FLAGS').length).toBe(1);
    expect(server.commandsWith('BODY.PEEK').length).toBe(1);
    expect(server.commands.filter((c) => /BODY\[/i.test(c) && !/BODY\.PEEK/i.test(c))).toEqual([]);
  });

  it('Nothing leaves the mail unread, and the cursor stops a second run', async () => {
    const server = await newServer();
    const first = server.addMail(plainMail('one'));
    const { runs, atEmit } = await start(server, { postProcessAction: 'nothing' });
    await until(() => runs.length === 1);
    expect(atEmit[0]).toEqual({ seen: [false], cursor: first.uid });
    expect(server.isSeen(first.uid)).toBe(false);
    expect(server.commandsWith('STORE')).toEqual([]);
    const second = server.addMail(plainMail('two'));
    await until(() => runs.length === 2);
    expect(runs[1].map((i) => (i.json.attributes as DataObject).uid)).toEqual([second.uid]);
    expect(server.isSeen(first.uid)).toBe(false);
  });
});

describe('UID cursor', () => {
  it('a mail arriving on the open connection starts one run, with the UID range in the search', async () => {
    const server = await newServer();
    const { runs, ctx } = await start(server);
    await until(() => server.commandsWith('IDLE').length > 0);
    expect(runs).toEqual([]);
    const mail = server.addMail(plainMail('pushed'));
    await until(() => runs.length === 1);
    expect(runs[0][0].json.subject).toBe('pushed');
    expect(ctx.getWorkflowStaticData('node').lastMessageUid).toBe(mail.uid);
    const next = server.addMail(plainMail('pushed again'));
    await until(() => runs.length === 2);
    expect(server.commandsWith('UID SEARCH').at(-1)).toContain(`UID ${mail.uid + 1}:*`);
    expect(next.uid).toBe(mail.uid + 1);
  });

  it('a restart reads only what came in while inactive', async () => {
    const server = await newServer();
    const staticData: DataObject = {};
    const seen = server.addMail(plainMail('before'));
    const first = await start(server, { postProcessAction: 'nothing' }, { staticData });
    await until(() => first.runs.length === 1);
    await first.response.closeFunction?.();

    const missed = server.addMail(plainMail('while inactive'));
    const second = await start(server, { postProcessAction: 'nothing' }, { staticData });
    await until(() => second.runs.length === 1);
    expect(second.runs[0].map((i) => (i.json.attributes as DataObject).uid)).toEqual([missed.uid]);
    expect(seen.uid).toBeLessThan(missed.uid);
  });

  it('the highest UID the server always answers for n:* starts no run', async () => {
    const server = await newServer();
    const staticData: DataObject = {};
    const mail = server.addMail(plainMail('only'));
    const first = await start(server, { postProcessAction: 'nothing' }, { staticData });
    await until(() => first.runs.length === 1);
    await first.response.closeFunction?.();

    const second = await start(server, { postProcessAction: 'nothing' }, { staticData });
    await until(() => server.commandsWith('UID SEARCH').length >= 2);
    await sleep(200);
    expect(second.runs).toEqual([]);
    expect(second.ctx.getWorkflowStaticData('node').lastMessageUid).toBe(mail.uid);
  });

  it('with no cursor yet, the first search starts from the activation day', async () => {
    const server = await newServer();
    server.addMail(plainMail('from last week'), { date: new Date(Date.now() - 7 * 86_400_000) });
    const today = server.addMail(plainMail('today'));
    const { runs } = await start(server);
    await until(() => runs.length === 1);
    expect(server.commandsWith('UID SEARCH')[0]).toContain('SINCE');
    expect(runs[0].map((i) => (i.json.attributes as DataObject).uid)).toEqual([today.uid]);
  });

  it('Fetch Only New Emails off clears the cursor and reads everything that matches', async () => {
    const server = await newServer();
    const staticData: DataObject = {};
    const old = server.addMail(plainMail('from last week'), { date: new Date(Date.now() - 7 * 86_400_000) });
    const first = await start(
      server,
      { postProcessAction: 'nothing', options: { trackLastMessageId: false } },
      { staticData },
    );
    await until(() => first.runs.length === 1);
    expect(server.commandsWith('UID SEARCH')[0]).not.toContain('SINCE');
    await first.response.closeFunction?.();

    const second = await start(
      server,
      { postProcessAction: 'nothing', options: { trackLastMessageId: false } },
      { staticData },
    );
    await until(() => second.runs.length === 1);
    expect(second.runs[0].map((i) => (i.json.attributes as DataObject).uid)).toEqual([old.uid]);
  });

  it('Fetch Only New Emails off does not read a mail twice on one connection', async () => {
    const server = await newServer();
    server.addMail(plainMail('one'));
    const { runs } = await start(server, {
      postProcessAction: 'nothing',
      options: { trackLastMessageId: false },
    });
    await until(() => runs.length === 1);
    server.addMail(plainMail('two'));
    await until(() => runs.length === 2);
    expect(runs[1].map((i) => i.json.subject)).toEqual(['two']);
  });

  it('manual mode takes the same path and starts a run', async () => {
    const server = await newServer();
    const mail = server.addMail(plainMail('test run'));
    const { runs } = await start(server, {}, { mode: 'manual' });
    await until(() => runs.length === 1);
    expect(runs[0].map((i) => (i.json.attributes as DataObject).uid)).toEqual([mail.uid]);
    expect(server.isSeen(mail.uid)).toBe(true);
  });
});

describe('batches', () => {
  it('starts one run per 20 mails, oldest first, each marked before its run', async () => {
    const server = await newServer();
    const mails = Array.from({ length: 45 }, (_, i) => server.addMail(plainMail(`m${i}`)));
    const { runs, atEmit } = await start(server);
    await until(() => runs.length === 3);
    expect(runs.map((r) => r.length)).toEqual([20, 20, 5]);
    expect(runs.flat().map((i) => (i.json.attributes as DataObject).uid)).toEqual(mails.map((m) => m.uid));
    expect(atEmit.map((e) => e.cursor)).toEqual([mails[19].uid, mails[39].uid, mails[44].uid]);
    expect(atEmit.every((e) => e.seen.every(Boolean))).toBe(true);
    await sleep(100);
    expect(runs.length).toBe(3);
  });
});

describe('one mail is capped by the binary limit', () => {
  const limits = { maxRemoteFileBytes: 2048 };

  it('a mail over the limit is skipped unread and not downloaded, and the next one still runs', async () => {
    const server = await newServer();
    const big = server.addMail(plainMail('big', { body: 'x'.repeat(5000) }));
    const small = server.addMail(plainMail('small'));
    const { runs, logs, atEmit, errors } = await start(server, {}, { limits });
    await until(() => runs.length === 1);
    expect(runs[0].map((i) => (i.json.attributes as DataObject).uid)).toEqual([small.uid]);
    expect(atEmit[0].cursor).toBe(small.uid);
    expect(server.isSeen(big.uid)).toBe(false);
    expect(server.isSeen(small.uid)).toBe(true);
    expect(logs.join('\n')).toContain(`Skipping email UID ${big.uid}`);
    expect(server.commandsWith('BODY.PEEK').join()).not.toContain(`FETCH ${big.uid} `);
    expect(errors).toEqual([]);
  });

  it('only a too big mail moves the cursor past it and starts no run', async () => {
    const server = await newServer();
    const big = server.addMail(plainMail('big', { body: 'x'.repeat(5000) }));
    const { runs, ctx } = await start(server, {}, { limits });
    await until(() => ctx.getWorkflowStaticData('node').lastMessageUid === big.uid);
    expect(runs).toEqual([]);
  });

  it('a server that lies about the size cannot push more than the limit into memory', async () => {
    const server = await newServer();
    server.addMail(plainMail('liar', { body: 'x'.repeat(50_000) }), { claimedSize: 100 });
    const { runs, errors } = await start(server, {}, { limits });
    await until(() => errors.length === 1);
    expect(runs).toEqual([]);
    expect(errors[0].message).toContain('IMAP');
    await sleep(100);
    expect(errors.length).toBe(1);
  });
});

describe('a mail that cannot be read', () => {
  it('is skipped unread with a warning, and the next one still runs', async () => {
    const server = await newServer();
    const parts = Array.from({ length: 1100 }, () => '--b\r\nContent-Type: text/plain\r\n\r\nx').join('\r\n');
    const bad = server.addMail(
      `From: a@example.test\r\nSubject: many parts\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n${parts}\r\n--b--\r\n`,
    );
    const good = server.addMail(plainMail('good'));
    const { runs, logs, atEmit } = await start(server);
    await until(() => runs.length === 1);
    expect(runs[0].map((i) => (i.json.attributes as DataObject).uid)).toEqual([good.uid]);
    expect(atEmit[0].cursor).toBe(good.uid);
    expect(server.isSeen(bad.uid)).toBe(false);
    expect(logs.join('\n')).toContain(`Skipping email UID ${bad.uid}: message could not be parsed`);
  });

  it('a binary store that fails is no reason to lose the mail: error path, unread, cursor unmoved', async () => {
    const server = await newServer();
    const mail = server.addMail(MIXED_MAIL);
    const binaryData = Object.create(testServices().binaryData) as ExecutionServices['binaryData'];
    binaryData.store = async () => {
      throw new Error('disk full at /secret/path');
    };
    const { runs, errors, ctx } = await start(server, { format: 'resolved' }, { binaryData });
    await until(() => errors.length === 1);
    expect(errors[0].message).toBe("Couldn't read new mail from the IMAP server");
    expect(runs).toEqual([]);
    expect(server.isSeen(mail.uid)).toBe(false);
    expect(ctx.getWorkflowStaticData('node').lastMessageUid).toBeUndefined();
  });
});

describe('connection', () => {
  it('a dropped connection reports n8n text once, and the node can be closed after', async () => {
    const server = await newServer();
    const { errors, response } = await start(server);
    await until(() => server.commandsWith('UID SEARCH').length > 0);
    server.dropConnections();
    await until(() => errors.length > 0);
    await sleep(100);
    expect(errors.map((e) => e.message)).toEqual(['IMAP connection closed unexpectedly']);
    await response.closeFunction?.();
    expect(errors.length).toBe(1);
  });

  it('closing does not wait for a silent server and reports nothing', async () => {
    const server = await newServer();
    const { errors, response } = await start(server);
    await until(() => server.commandsWith('UID SEARCH').length > 0);
    server.silent = true;
    const before = Date.now();
    await response.closeFunction?.();
    expect(Date.now() - before).toBeLessThan(1000);
    await sleep(100);
    expect(errors).toEqual([]);
  });

  it('closing twice is safe, and no mail runs after the close', async () => {
    const server = await newServer();
    const { runs, response } = await start(server);
    await until(() => server.commandsWith('UID SEARCH').length > 0);
    await response.closeFunction?.();
    await response.closeFunction?.();
    server.addMail(plainMail('late'));
    await sleep(200);
    expect(runs).toEqual([]);
  });

  it('Force Reconnect swaps the connection on its timer, silently, and mail still runs once', async () => {
    const server = await newServer();
    const { runs, errors } = await start(server, { options: { forceReconnect: 0.005 } });
    await until(() => server.logins >= 3);
    expect(errors).toEqual([]);
    server.addMail(plainMail('after reconnects'));
    await until(() => runs.length === 1);
    await sleep(400);
    expect(runs.length).toBe(1);
    expect(errors).toEqual([]);
  });

  it('Force Reconnect that fails goes to the error path, and the timer stops', async () => {
    const server = await newServer();
    const { errors } = await start(server, { options: { forceReconnect: 0.005 } });
    await until(() => server.logins >= 1);
    Object.assign(server, { password: 'changed' });
    await until(() => errors.length === 1);
    expect(errors[0].message).toBe('IMAP refused the username or password');
    const logins = server.connections;
    await sleep(600);
    expect(server.connections).toBe(logins);
    expect(errors.length).toBe(1);
  });

  it('without the option there is no reconnect', async () => {
    const server = await newServer();
    await start(server);
    await until(() => server.logins === 1);
    await sleep(500);
    expect(server.logins).toBe(1);
  });

  it('opens the named mailbox', async () => {
    const server = await newServer();
    server.addMailbox('Support');
    server.addMail(plainMail('elsewhere'));
    server.addMail(plainMail('here'), { mailbox: 'Support' });
    const { runs } = await start(server, { mailbox: 'Support' });
    await until(() => runs.length === 1);
    expect(runs[0][0].json.subject).toBe('here');
    expect(server.commandsWith('SELECT')[0]).toContain('Support');
  });
});

describe('a failed start', () => {
  it('a wrong password throws our text, without the password or the server text', async () => {
    const server = await newServer({ loginRefusal: 'SERVERTEXT says no' });
    const start_ = start(server, {}, { creds: credsFor(server, { password: 'wrong-secret' }) });
    const error = await start_.then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toBe('IMAP refused the username or password');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('wrong-secret');
    expect(error?.message).not.toContain('SERVERTEXT');
  });

  it('an unknown mailbox throws our text and leaves no connection', async () => {
    const server = await newServer();
    await expect(start(server, { mailbox: 'Nope' })).rejects.toThrow('Couldn\'t open the mailbox "Nope"');
    expect(server.logins).toBe(1);
    await until(() => server.openConnections === 0);
  });

  it('a closed port throws our text', async () => {
    const server = await newServer();
    const creds = credsFor(server, { port: 1 });
    await expect(start(server, {}, { creds })).rejects.toThrow("Couldn't connect to the IMAP server");
  });

  it('an empty host is refused before anything connects', async () => {
    const server = await newServer();
    await expect(start(server, {}, { creds: credsFor(server, { host: ' ' }) })).rejects.toThrow(
      'Enter the IMAP host',
    );
    expect(server.connections).toBe(0);
  });

  it('logs hold neither the password nor the mail', async () => {
    const server = await newServer();
    server.addMail(plainMail('private subject', { body: 'private body' }));
    const { runs, logs } = await start(server);
    await until(() => runs.length === 1);
    const all = logs.join('\n');
    expect(all).not.toContain(server.password);
    expect(all).not.toContain('private');
  });
});

describe('SSRF guard', () => {
  it('the default policy refuses loopback, and nothing connects', async () => {
    const server = await newServer();
    await expect(start(server, {}, { http: new HttpClient() })).rejects.toThrow();
    expect(server.connections).toBe(0);
  });

  it('a name connects only through the checked address and never resolves again (DNS rebind)', async () => {
    const server = await newServer();
    server.addMail(plainMail('pinned'));
    const http = new ScriptedGuard(() => pinnedLoopback());
    const lookup = vi.spyOn(dns, 'lookup');
    const { runs } = await start(server, {}, { http, creds: credsFor(server, { host: 'imap.rebind.test' }) });
    await until(() => runs.length === 1);
    expect(http.checked).toEqual(['imap.rebind.test']);
    expect(lookup.mock.calls.some(([host]) => host === 'imap.rebind.test')).toBe(false);
  });

  it('a host the guard refuses gets no connection and the guard text', async () => {
    const server = await newServer();
    const http = new ScriptedGuard(() => new Error('Blocked by the guard'));
    await expect(start(server, {}, { http })).rejects.toThrow('Blocked by the guard');
    expect(server.connections).toBe(0);
  });

  it('every forced reconnect goes through the guard again', async () => {
    const server = await newServer();
    const http = new ScriptedGuard(() => pinnedLoopback());
    await start(
      server,
      { options: { forceReconnect: 0.005 } },
      { http, creds: credsFor(server, { host: 'imap.rebind.test' }) },
    );
    await until(() => server.logins >= 2);
    expect(http.checked.length).toBeGreaterThanOrEqual(2);
  });

  it('a reconnect the guard now refuses connects nowhere and goes to the error path', async () => {
    const server = await newServer();
    let allow = true;
    const http = new ScriptedGuard(() => (allow ? pinnedLoopback() : new Error('Now blocked')));
    const { errors } = await start(
      server,
      { options: { forceReconnect: 0.005 } },
      { http, creds: credsFor(server, { host: 'imap.rebind.test' }) },
    );
    await until(() => server.logins >= 1);
    allow = false;
    const connections = server.connections;
    await until(() => errors.length === 1);
    expect(errors[0].message).toBe('Now blocked');
    expect(server.connections).toBeLessThanOrEqual(connections + 1);
  });
});

describe('TLS', () => {
  const http = () => new ScriptedGuard(() => pinnedLoopback());

  it('refuses a certificate it cannot verify, by default', async () => {
    const server = await newServer({ tls: true });
    await expect(
      start(server, {}, { http: http(), creds: credsFor(server, { host: 'broker.test', secure: true }) }),
    ).rejects.toThrow("Couldn't connect to the IMAP server");
    expect(server.logins).toBe(0);
  });

  it('Allow Self-Signed turns verification off, with the host as the server name', async () => {
    const server = await newServer({ tls: true });
    server.addMail(plainMail('over tls'));
    const { runs } = await start(
      server,
      {},
      {
        http: http(),
        creds: credsFor(server, { host: 'broker.test', secure: true, allowUnauthorizedCerts: true }),
      },
    );
    await until(() => runs.length === 1);
    expect(runs[0][0].json.subject).toBe('over tls');
    expect(server.serverNames).toEqual(['broker.test']);
  });

  it('STARTTLS: the upgrade verifies too, before the password goes out', async () => {
    const server = await newServer({ startTls: true });
    await expect(
      start(server, {}, { http: http(), creds: credsFor(server, { host: 'broker.test', secure: false }) }),
    ).rejects.toThrow("Couldn't connect to the IMAP server");
    expect(server.commandsWith('LOGIN')).toEqual([]);
  });

  it('STARTTLS: with Allow Self-Signed the session goes on over TLS', async () => {
    const server = await newServer({ startTls: true });
    server.addMail(plainMail('upgraded'));
    const { runs } = await start(
      server,
      {},
      {
        http: http(),
        creds: credsFor(server, { host: 'broker.test', secure: false, allowUnauthorizedCerts: true }),
      },
    );
    await until(() => runs.length === 1);
    expect(server.commands[0].toUpperCase()).toBe('CAPABILITY');
    expect(server.commandsWith('STARTTLS').length).toBe(1);
    expect(server.serverNames).toEqual(['broker.test']);
  });
});

describe('credential test', () => {
  it('passes with n8n text after a connect and a list', async () => {
    const server = await newServer();
    const result = await credentialTest(credsFor(server), credentialContext(localHttp()));
    expect(result).toEqual({ status: 'OK', message: 'Connection successful!' });
    expect(server.commandsWith('LIST').length).toBeGreaterThan(0);
  });

  it('fails clearly on a wrong password, with no text of the server', async () => {
    const server = await newServer({ loginRefusal: 'SERVERTEXT says no' });
    const result = await credentialTest(
      credsFor(server, { password: 'wrong-secret' }),
      credentialContext(localHttp()),
    );
    expect(result).toEqual({ status: 'Error', message: 'IMAP refused the username or password' });
  });

  it('fails clearly on a port nothing listens on', async () => {
    const server = await newServer();
    const result = await credentialTest(credsFor(server, { port: 1 }), credentialContext(localHttp()));
    expect(result.status).toBe('Error');
    expect(result.message).toContain("Couldn't connect to the IMAP server");
  });

  it('the guard answers first, and nothing connects', async () => {
    const server = await newServer();
    const result = await credentialTest(credsFor(server), credentialContext(new HttpClient()));
    expect(result.status).toBe('Error');
    expect(server.connections).toBe(0);
  });

  it('resolves only through the checked address (DNS rebind)', async () => {
    const server = await newServer();
    const lookup = vi.spyOn(dns, 'lookup');
    const result = await credentialTest(
      credsFor(server, { host: 'imap.rebind.test' }),
      credentialContext(new ScriptedGuard(() => pinnedLoopback())),
    );
    expect(result.status).toBe('OK');
    expect(lookup.mock.calls.some(([host]) => host === 'imap.rebind.test')).toBe(false);
  });

  it('an abort ends the wait on a server that never greets', async () => {
    const server = await newServer();
    server.silent = true;
    const controller = new AbortController();
    const running = credentialTest(credsFor(server), credentialContext(localHttp(), controller.signal));
    await until(() => server.connections === 1);
    const before = Date.now();
    controller.abort();
    const result = await running;
    expect(result.status).toBe('Error');
    expect(Date.now() - before).toBeLessThan(2000);
  });
});
