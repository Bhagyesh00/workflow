/** P5-77: human review on an agent's tool, from the message through the link to the model's next turn. */
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { nodesAiPackage } from '@workflow/nodes-ai';
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  DataObject,
  NodePackage,
  NodeTypeDescription,
} from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestServer,
  createWorkflow,
  node,
  outputOf,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitForExecution,
} from './helpers';

const TOKEN = '777:bot-secret-token';
const WAIT_MESSAGE = 'The agent wants to run this tool: Refund';
const REJECTED = (id: string) =>
  `User rejected the tool call to Refund (id: ${id}). STOP what you are doing and wait for the user to tell you how to proceed. The tool is still available if needed.`;

/** the model's replies by model node name, and what it was asked */
let scripts: Record<string, AiChatResponse[]> = {};
let requests: Record<string, AiChatMessage[][]> = {};
/** arguments the gated tool ran with */
let refunds: DataObject[] = [];
let memoryAppends: AiChatMessage[][] = [];

const description = (
  name: string,
  outputs: NodeTypeDescription['outputs'],
  properties: NodeTypeDescription['properties'] = [],
): NodeTypeDescription => ({
  name,
  displayName: name,
  description: 'Pays money back',
  group: ['transform'],
  version: 1,
  defaults: { name },
  inputs: [],
  outputs,
  properties,
});

const testNodesPackage: NodePackage = {
  name: 'hitl-tests',
  credentials: [],
  nodes: [
    {
      description: description('test.hitlModel', ['ai_languageModel']),
      async supplyData(ctx) {
        const name = ctx.getNode().name;
        return {
          response: {
            kind: 'chatModel',
            provider: 'test',
            model: 'scripted',
            chat: async (request: AiChatRequest): Promise<AiChatResponse> => {
              (requests[name] ??= []).push(structuredClone(request.messages));
              const next = scripts[name]?.shift();
              if (!next) throw new Error(`The model ${name} has no reply left`);
              return next;
            },
          },
        };
      },
    },
    {
      description: description(
        'test.refund',
        ['ai_tool'],
        [{ displayName: 'Amount', name: 'amount', type: 'string', default: '' }],
      ),
      async execute(ctx) {
        const amount = ctx.getNodeParameter('amount', 0, '') as string;
        refunds.push({ amount });
        return [[{ json: { refunded: amount } }]];
      },
    },
    {
      description: description('test.hitlMemory', ['ai_memory']),
      async supplyData() {
        return {
          response: {
            kind: 'memory',
            sessionId: 'session-1',
            load: async () => [],
            append: async (_session: string, added: AiChatMessage[]) => {
              memoryAppends.push(added);
            },
            clear: async () => {},
          },
        };
      },
    },
  ],
};

const call = (amount: string, id: string): AiChatResponse => ({
  message: {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: 'Refund', arguments: { toolParameters: { amount }, hitlParameters: {} } }],
  },
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: 'tool_calls',
});
const say = (text: string): AiChatResponse => ({
  message: { role: 'assistant', content: text },
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: 'end',
});

let server: TestServer;
let telegram: Server;
let baseUrl = '';
let sent: DataObject[] = [];

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [nodesAiPackage, testNodesPackage] });
  telegram = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url?.endsWith('/sendMessage')) sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.close();
  await new Promise((resolve) => telegram.close(resolve));
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  sent = [];
  scripts = {};
  requests = {};
  refunds = [];
  memoryAppends = [];
});

let signups = 0;
const owner = () =>
  signup(server.app, { remoteAddress: `10.8.${Math.floor(++signups / 200)}.${signups % 200}` });

const link = (from: string, to: string, type: string) => ({
  [from]: { [type]: [[{ node: to, type, index: 0 }]] },
});

const get = (url: string, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'GET', url, headers });

const AGENT_NODE = (options: DataObject = {}) =>
  node('Agent', 'ai.agent', { promptType: 'define', text: 'Pay it back', options }, [200, 0]);
const REFUND = node('Refund', 'test.refund', { amount: `={{ $fromAI('amount', 'How much', 'string') }}` }, [
  200, 400,
]);

/** the shared part: Start -> Agent -> After, with the model, plus the gate and the tool */
function workflow(gate: ReturnType<typeof node>, extra: ReturnType<typeof node>[] = [], connections = {}) {
  return {
    nodes: [
      node('Start', 'core.manualTrigger'),
      AGENT_NODE(),
      setNode('After', 'after', 'yes', [400, 0]),
      node('Model', 'test.hitlModel', {}, [100, 200]),
      gate,
      REFUND,
      ...extra,
    ],
    connections: {
      Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
      Agent: { main: [[{ node: 'After', type: 'main', index: 0 }]] },
      ...link('Model', 'Agent', 'ai_languageModel'),
      ...link(gate.name, 'Agent', 'ai_tool'),
      ...link('Refund', gate.name, 'ai_tool'),
      ...connections,
    },
  };
}

async function startRun(session: Awaited<ReturnType<typeof owner>>, definition: ReturnType<typeof workflow>) {
  const { client, tenant } = session;
  const wf = await createWorkflow(client, definition);
  const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
  await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
  const read = async () => (await client.data(client.get(`/rest/executions/${executionId}`))).state;
  const status = async () => (await server.ctx.repos.executions.get(tenant.id, executionId))?.status;
  const finished = async () => {
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    return read();
  };
  return { executionId, tenantId: tenant.id, read, status, finished };
}

/** a run that waits at a Telegram review of the Refund tool */
async function telegramReview(parameters: DataObject = {}, extra: ReturnType<typeof node>[] = [], more = {}) {
  const session = await owner();
  const credential = await session.client.data(
    session.client.post('/rest/credentials', {
      name: 'Bot',
      type: 'telegramApi',
      data: { accessToken: TOKEN, baseUrl },
    }),
  );
  const gate = node('Review', 'app.telegramHitlTool', { chatId: '42', ...parameters }, [200, 200], {
    credentials: { telegramApi: { id: credential.id, name: 'Bot' } },
  });
  return startRun(session, workflow(gate, extra, more));
}

const linksOf = (message: DataObject) => {
  const keyboard = (message.reply_markup as { inline_keyboard: Array<Array<{ text: string; url: string }>> })
    .inline_keyboard[0];
  return Object.fromEntries(keyboard.map((b) => [b.text, new URL(b.url).pathname + new URL(b.url).search]));
};

const toolResults = (messages: AiChatMessage[]) =>
  messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m.content]);

describe('a gated tool on the agent', () => {
  it('the run waits at the review node, with no Agent task', async () => {
    scripts.Model = [call('10', 'c1'), say('done')];
    const run = await telegramReview();
    const state = await run.read();
    expect(state.resultData.lastNodeExecuted).toBe('Review');
    expect(state.resultData.runData.Agent).toBeUndefined();
    expect(state.resultData.runData.Review[0].executionStatus).toBe('waiting');
    expect(refunds).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: '42' });
    expect(sent[0].text).toBe(`${WAIT_MESSAGE}\n\nInput:\n{"amount":"10"}`);
  });

  it('Approve runs the tool and the model gets its result', async () => {
    scripts.Model = [call('10', 'c1'), say('refunded')];
    const run = await telegramReview();
    const page = await get(linksOf(sent[0]).Approve);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Your response has been recorded');

    const state = await run.finished();
    expect(refunds).toEqual([{ amount: '10' }]);
    expect(toolResults(requests.Model[1])).toEqual([['c1', '[{"refunded":"10"}]']]);
    expect(outputOf(state, 'Agent')).toEqual([{ output: 'refunded' }]);
    expect(outputOf(state, 'After')[0]).toMatchObject({ after: 'yes' });
    expect(state.resultData.runData.Review[0].executionStatus).toBe('success');
    expect(state.resultData.runData.Review[0].data.ai_tool[0][0].json).toEqual({ data: { approved: true } });
    expect(state.executionData.suspended).toBeUndefined();
  });

  it('Decline feeds the rejection text', async () => {
    scripts.Model = [call('10', 'c1'), say('stopped')];
    const run = await telegramReview({
      approvalOptions: { values: { approvalType: 'double', approveLabel: 'Yes', disapproveLabel: 'No' } },
    });
    expect((await get(linksOf(sent[0]).No)).statusCode).toBe(200);
    const state = await run.finished();
    expect(refunds).toEqual([]);
    expect(toolResults(requests.Model[1])).toEqual([['c1', REJECTED('c1')]]);
    expect(outputOf(state, 'Agent')).toEqual([{ output: 'stopped' }]);
  });

  it('a timeout counts as denied', async () => {
    scripts.Model = [call('10', 'c1'), say('stopped')];
    const run = await telegramReview({
      options: { limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'hours' } } },
    });
    // what the wait tracker does when the time is up
    expect(await server.ctx.executions.resume(run.tenantId, run.executionId)).toBeTruthy();
    await run.finished();
    expect(refunds).toEqual([]);
    expect(toolResults(requests.Model[1])).toEqual([['c1', REJECTED('c1')]]);
  });

  it('a link answers once', async () => {
    scripts.Model = [call('10', 'c1'), say('done')];
    const run = await telegramReview();
    const { Approve } = linksOf(sent[0]);
    expect((await get(Approve)).statusCode).toBe(200);
    await run.finished();

    const again = await get(Approve);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('not_waiting');
    const browser = await get(Approve, { accept: 'text/html,application/xhtml+xml' });
    expect(browser.statusCode).toBe(409);
    expect(browser.headers['content-type']).toContain('text/html');
    expect(browser.body).toContain('already answered');
    expect(refunds).toHaveLength(1);
  });

  it('the link of one review does not answer the next review on the same node', async () => {
    scripts.Model = [call('10', 'c1'), call('9999', 'c2'), say('done')];
    const run = await telegramReview();
    const first = linksOf(sent[0]).Approve;
    expect((await get(first)).statusCode).toBe(200);
    await waitForExecution(server.ctx, run.tenantId, run.executionId, ['waiting']);
    expect(sent).toHaveLength(2);
    expect(refunds).toEqual([{ amount: '10' }]);

    const old = await get(first);
    expect(old.statusCode).toBe(404);
    expect(await run.status()).toBe('waiting');
    expect(refunds).toEqual([{ amount: '10' }]);

    // the key is signed: an edited run index, or a key without its signature, opens nothing
    const second = linksOf(sent[1]).Approve;
    for (const edited of [first.replace('-0-', '-1-'), second.replace(/-1-[^/]+\/answer/, '-1/answer')]) {
      expect(edited).not.toBe(first);
      expect(edited).not.toBe(second);
      expect((await get(edited)).statusCode).toBe(404);
    }
    expect(await run.status()).toBe('waiting');
    expect(refunds).toEqual([{ amount: '10' }]);

    expect(second).not.toBe(first);
    expect((await get(second)).statusCode).toBe(200);
    await run.finished();
    expect(refunds).toEqual([{ amount: '10' }, { amount: '9999' }]);
  });

  it('a click while the run is still going gets a busy page and keeps the answer', async () => {
    scripts.Model = [call('10', 'c1'), say('done')];
    const run = await telegramReview();
    const { Approve } = linksOf(sent[0]);
    const { repos } = server.ctx;
    // the run stands here while the other tools of the turn finish
    expect(await repos.executions.transition(run.tenantId, run.executionId, ['waiting'], { status: 'running' })).toBe(
      true,
    );
    const busy = await get(Approve, { accept: 'text/html,application/xhtml+xml' });
    expect(busy.statusCode).toBe(409);
    expect(busy.headers['content-type']).toContain('text/html');
    expect(busy.body).toContain('still working on this request');
    expect(busy.body).not.toContain('already answered');
    expect(refunds).toEqual([]);

    expect(await repos.executions.transition(run.tenantId, run.executionId, ['running'], { status: 'waiting' })).toBe(
      true,
    );
    expect((await get(Approve)).statusCode).toBe(200);
    await run.finished();
    expect(refunds).toEqual([{ amount: '10' }]);
  });

  it('an answer checked against another wait does not land on this one', async () => {
    scripts.Model = [call('10', 'c1'), say('done')];
    const run = await telegramReview();
    const { executions } = server.ctx;
    for (const atWait of [
      { toolNode: 'Review', toolRunIndex: 1 },
      { toolNode: 'Other', toolRunIndex: 0 },
    ]) {
      expect(await executions.resume(run.tenantId, run.executionId, undefined, { atWait })).toBeUndefined();
      expect(await run.status()).toBe('waiting');
    }
    const atWait = { toolNode: 'Review', toolRunIndex: 0 };
    expect(await executions.resume(run.tenantId, run.executionId, undefined, { atWait })).toBeTruthy();
    await run.finished();
  });

  it('only a real answer on the link decides', async () => {
    scripts.Model = [call('10', 'c1'), say('done')];
    const run = await telegramReview();
    const url = linksOf(sent[0]).Approve;
    const forged = url.replace('approved=true', 'approved=maybe');
    expect((await get(forged)).statusCode).toBe(400);
    expect(await run.status()).toBe('waiting');
    const posted = await server.app.inject({
      method: 'POST',
      url: url.split('?')[0],
      payload: { approved: true },
    });
    expect(posted.statusCode).toBe(400);
    expect(await run.status()).toBe('waiting');
    expect(refunds).toEqual([]);
    // a link preview opens the link without a person
    const bot = await get(url, { 'user-agent': 'Slackbot-LinkExpanding 1.0' });
    expect(bot.statusCode).toBe(200);
    expect(await run.status()).toBe('waiting');
  });

  it('memory is written only at the end', async () => {
    scripts.Model = [call('10', 'c1'), say('done')];
    const run = await telegramReview({}, [node('Memory', 'test.hitlMemory', {}, [300, 200])], {
      ...link('Memory', 'Agent', 'ai_memory'),
    });
    expect(memoryAppends).toEqual([]);
    await get(linksOf(sent[0]).Approve);
    await run.finished();
    expect(memoryAppends).toHaveLength(1);
    expect(memoryAppends[0].map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('the page after the answer shows nothing of the tool call', async () => {
    const attack = '<script>alert(1)</script>';
    scripts.Model = [call(attack, 'c1'), say('done')];
    const run = await telegramReview();
    expect(sent[0].text).toContain(attack);
    const page = await get(linksOf(sent[0]).Approve);
    expect(page.body).not.toContain(attack);
    expect(page.body).not.toContain('alert(1)');
    expect(page.headers['content-security-policy']).toContain('sandbox');
    await run.finished();
  });
});

describe('the email of a review', () => {
  let smtp: net.Server;
  let mails: string[] = [];

  beforeAll(async () => {
    smtp = net.createServer((socket) => {
      socket.on('error', () => undefined);
      let inData = false;
      let buffer = '';
      socket.write('220 localhost ESMTP test\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end < 0) return;
            mails.push(buffer.slice(0, end));
            buffer = buffer.slice(end + 5);
            inData = false;
            socket.write('250 OK\r\n');
            continue;
          }
          const nl = buffer.indexOf('\r\n');
          if (nl < 0) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') socket.write('250 localhost\r\n');
          else if (verb === 'DATA') {
            inData = true;
            socket.write('354 go ahead\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else socket.write('250 OK\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    await new Promise((resolve) => smtp.close(resolve));
  });

  it('$tool.parameters is escaped in the html', async () => {
    mails = [];
    scripts.Model = [call('<img src=x onerror=alert(1)>', 'c1'), say('done')];
    const session = await owner();
    const credential = await session.client.data(
      session.client.post('/rest/credentials', {
        name: 'Mail',
        type: 'smtp',
        data: {
          host: '127.0.0.1',
          port: (smtp.address() as AddressInfo).port,
          secure: false,
          disableStartTls: true,
        },
      }),
    );
    const gate = node(
      'Review',
      'core.sendEmailHitlTool',
      { fromEmail: 'bot@example.com', toEmail: 'boss@example.com', subject: 'Review' },
      [200, 200],
      { credentials: { smtp: { id: credential.id, name: 'Mail' } } },
    );
    const run = await startRun(session, workflow(gate));
    expect(mails).toHaveLength(1);
    const decoded = mails[0].replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_all, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    const html = decoded.slice(decoded.indexOf('text/html'));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(`/${run.executionId}/`);
    expect(await run.status()).toBe('waiting');
  });
});

describe('a gate inside a sub-agent', () => {
  it('is refused with its text, and nothing is sent', async () => {
    scripts.Model = [
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 's1', name: 'Sub', arguments: { input: 'pay it back' } }],
        },
        stopReason: 'tool_calls',
      },
      say('could not'),
    ];
    const session = await owner();
    const credential = await session.client.data(
      session.client.post('/rest/credentials', {
        name: 'Bot',
        type: 'telegramApi',
        data: { accessToken: TOKEN, baseUrl },
      }),
    );
    const gate = node('Review', 'app.telegramHitlTool', { chatId: '42' }, [200, 200], {
      credentials: { telegramApi: { id: credential.id, name: 'Bot' } },
    });
    const { client, tenant } = session;
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        AGENT_NODE(),
        node('Model', 'test.hitlModel', {}, [100, 200]),
        node('Sub', 'ai.agentTool', { text: `={{ $fromAI('input', 'Prompt') }}` }, [300, 200]),
        node('Sub Model', 'test.hitlModel', {}, [300, 400]),
        gate,
        REFUND,
      ],
      connections: {
        Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
        ...link('Model', 'Agent', 'ai_languageModel'),
        ...link('Sub', 'Agent', 'ai_tool'),
        ...link('Sub Model', 'Sub', 'ai_languageModel'),
        ...link('Review', 'Sub', 'ai_tool'),
        ...link('Refund', 'Review', 'ai_tool'),
      },
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    expect(String(toolResults(requests.Model[1])[0][1])).toContain(
      'Human-in-the-Loop nodes cannot be used inside a sub-agent. Move "Review" to the top-level workflow.',
    );
    expect(sent).toEqual([]);
    expect(refunds).toEqual([]);
  });
});
