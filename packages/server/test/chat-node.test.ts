/**
 * P5-58 Respond to Chat over HTTP: a "Using Response Nodes" chat streams each message as its own frame group, a
 * run that waits ends its stream with a `wait` frame, the next message posted to that URL resumes the run and gets
 * its frames, an approval button fetched as NDJSON does the same (a browser keeps the page), and the Chat node
 * works as an agent's review gate (`ai.chatHitlTool`) and as its Send Message tool (`ai.chatTool`).
 */
import { nodesAiPackage } from '@workflow/nodes-ai';
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  DataObject,
  NodePackage,
  NodeTypeDescription,
  WorkflowNode,
} from '@workflow/workflow';
import { Workflow } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantRow } from '../src/db/schema';
import type { ExecutionOutcome, StartedExecution } from '../src/services/executions';
import type { WebhookReply } from '../src/services/webhooks';
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

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
const NDJSON = 'application/x-ndjson';
const REJECTED = (id: string) =>
  `User rejected the tool call to Refund (id: ${id}). STOP what you are doing and wait for the user to tell you how to proceed. The tool is still available if needed.`;

let scripts: Record<string, AiChatResponse[]> = {};
let requests: Record<string, AiChatMessage[][]> = {};
let refunds: DataObject[] = [];

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
  name: 'chat-node-tests',
  credentials: [],
  nodes: [
    {
      description: description('test.chatNodeModel', ['ai_languageModel']),
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
        'test.chatRefund',
        ['ai_tool'],
        [{ displayName: 'Amount', name: 'amount', type: 'string', default: '' }],
      ),
      async execute(ctx) {
        const amount = ctx.getNodeParameter('amount', 0, '') as string;
        refunds.push({ amount });
        return [[{ json: { refunded: amount } }]];
      },
    },
  ],
};

const say = (text: string): AiChatResponse => ({
  message: { role: 'assistant', content: text },
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: 'end',
});
const callTool = (name: string, args: DataObject, id: string): AiChatResponse => ({
  message: { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] },
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: 'tool_calls',
});

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [nodesAiPackage, testNodesPackage] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  scripts = {};
  requests = {};
  refunds = [];
});

let signups = 0;
const owner = () =>
  signup(server.app, { remoteAddress: `10.9.${Math.floor(++signups / 200)}.${signups % 200}` });

const trigger = () =>
  node('Chat', 'ai.chatTrigger', { public: true, options: { responseMode: 'responseNodes' } }, [0, 0], {
    webhookId: 'chat-node-hook',
  });
const say_ = (name: string, message: string) => node(name, 'ai.chat', { message }, [200, 0]);
const ask = (name: string, parameters: DataObject, webhookId: string) =>
  node(name, 'ai.chat', { operation: 'sendAndWait', ...parameters }, [400, 0], { webhookId });

const main = (...names: string[]) => {
  const connections: Record<string, DataObject> = {};
  for (let i = 0; i < names.length - 1; i++) {
    connections[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] };
  }
  return connections;
};
const link = (from: string, to: string, type: string) => ({
  [from]: { [type]: [[{ node: to, type, index: 0 }]] },
});

type Frame = DataObject & { type: string; content?: string; resumeUrl?: string; metadata?: DataObject };

const framesOf = (body: string): Frame[] =>
  body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Frame);

/** [type, content, node] per frame; a wait frame shows its URL */
const shape = (frames: Frame[]) =>
  frames.map((f) =>
    f.type === 'wait' ? ['wait', f.resumeUrl] : [f.type, f.content ?? null, f.metadata?.nodeName ?? null],
  );

async function chatWorkflow(nodes: WorkflowNode[], connections: Record<string, unknown>) {
  const session = await owner();
  const wf = await createWorkflow(session.client, { nodes, connections } as never);
  const activated = await session.client.post(`/rest/workflows/${wf.id}/activate`);
  expect(activated.statusCode, activated.body).toBe(200);
  const res = await server.app.inject({
    method: 'POST',
    url: `/webhook/${session.tenant.slug}/chat-node-hook/chat`,
    payload: { sessionId: 's1', chatInput: 'Hi' },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['content-type']).toContain(NDJSON);
  const frames = framesOf(res.body);
  const wait = frames.find((f) => f.type === 'wait');
  const path = wait ? new URL(String(wait.resumeUrl)).pathname : '';
  const executionId = path.split('/')[2] ?? '';
  const state = async () =>
    (await session.client.data(session.client.get(`/rest/executions/${executionId}`))).state;
  const status = async () => (await server.ctx.repos.executions.get(session.tenant.id, executionId))?.status;
  const finished = async () => {
    await waitForExecution(server.ctx, session.tenant.id, executionId, ['success']);
    return state();
  };
  return { frames, path, executionId, tenantId: session.tenant.id, state, status, finished };
}

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'POST', url, payload: payload as never, headers });
const get = (url: string, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'GET', url, headers: { 'user-agent': BROWSER, ...headers } });

/** the buttons of a with-buttons frame, by label, as path and query */
function buttonsOf(frames: Frame[]): Record<string, string> {
  const item = frames.find((f) => f.type === 'item' && String(f.content).startsWith('{'));
  const message = JSON.parse(String(item?.content)) as { buttons: Array<{ text: string; link: string }> };
  return Object.fromEntries(
    message.buttons.map((b) => [b.text, new URL(b.link).pathname + new URL(b.link).search]),
  );
}

describe('Respond to Chat in a "Using Response Nodes" chat', () => {
  const conversation = () =>
    chatWorkflow(
      [
        trigger(),
        say_('Greet', '=Hello {{ $json.chatInput }}'),
        ask('Ask', { responseType: 'freeText', message: 'Your name?' }, 'ask-key'),
        say_('Thanks', '=Thanks {{ $json.chatInput }}'),
        setNode('After', 'after', 'yes', [800, 0]),
      ],
      main('Chat', 'Greet', 'Ask', 'Thanks', 'After'),
    );

  it('streams two message groups, then a wait frame for the chat reply of the waiting node', async () => {
    const run = await conversation();
    expect(shape(run.frames).slice(0, 6)).toEqual([
      ['begin', null, 'Greet'],
      ['item', 'Hello Hi', 'Greet'],
      ['end', null, 'Greet'],
      ['begin', null, 'Ask'],
      ['item', 'Your name?', 'Ask'],
      ['end', null, 'Ask'],
    ]);
    expect(run.frames).toHaveLength(7);
    expect(run.frames[6].type).toBe('wait');
    expect(String(run.frames[6].resumeUrl)).toMatch(
      new RegExp(`^http://localhost:5678/webhook-waiting/${run.executionId}/[^/]+/ask-key/chat-reply$`),
    );
    expect(await run.status()).toBe('waiting');
  });

  it('the next message resumes the run, streams its frames and closes when the run ends', async () => {
    const run = await conversation();
    const res = await post(
      run.path,
      { action: 'sendMessage', sessionId: 's1', chatInput: 'Ada' },
      { origin: 'null' },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain(NDJSON);
    // the signature guards the resume URL; the sandboxed page has an opaque origin
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(shape(framesOf(res.body))).toEqual([
      ['begin', null, 'Thanks'],
      ['item', 'Thanks Ada', 'Thanks'],
      ['end', null, 'Thanks'],
    ]);
    const state = await run.finished();
    expect(outputOf(state, 'Ask')).toEqual([{ sessionId: 's1', chatInput: 'Ada' }]);
    expect(outputOf(state, 'After')[0]).toMatchObject({ after: 'yes' });
    // the reply is saved as the run's highlighted data of the waiting node
    expect(state.resultData.customData).toMatchObject({ input_ask: 'Ada' });
  });

  it('answers the preflight of the resume URL for any origin', async () => {
    const run = await conversation();
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: run.path,
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-chat-page',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toBe('content-type, x-chat-page');
  });

  it('a wrong signature, a bare chat-reply or another node key opens nothing', async () => {
    const run = await conversation();
    const [, , id, signature] = run.path.split('/');
    const forged = run.path.replace(signature, `${signature.slice(0, -2)}xx`);
    for (const url of [
      forged,
      `/webhook-waiting/${id}/${signature}/chat-reply`,
      run.path.replace('ask-key', 'other'),
    ]) {
      const res = await post(url, { sessionId: 's1', chatInput: 'Ada' });
      expect(res.statusCode, url).toBe(404);
    }
    expect(await run.status()).toBe('waiting');
  });

  it('refuses an over-long message with 413 and keeps the run waiting', async () => {
    const run = await conversation();
    const res = await post(run.path, { sessionId: 's1', chatInput: 'x'.repeat(100_001) });
    expect(res.statusCode).toBe(413);
    expect(await run.status()).toBe('waiting');
  });

  it('the time limit ends the wait', async () => {
    const run = await chatWorkflow(
      [
        trigger(),
        ask(
          'Ask',
          {
            responseType: 'freeText',
            message: 'Your name?',
            options: {
              limitWaitTime: {
                values: { limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'hours' },
              },
            },
          },
          'ask-key',
        ),
        setNode('After', 'after', 'yes', [800, 0]),
      ],
      main('Chat', 'Ask', 'After'),
    );
    const row = await server.ctx.repos.executions.get(run.tenantId, run.executionId);
    const left = (row?.waitTill?.getTime() ?? 0) - Date.now();
    expect(left).toBeGreaterThan(3_500_000);
    expect(left).toBeLessThanOrEqual(3_600_000);
    // what the wait tracker does when the time is up
    expect(await server.ctx.executions.resume(run.tenantId, run.executionId)).toBeTruthy();
    const state = await run.finished();
    expect(outputOf(state, 'After')[0]).toMatchObject({ after: 'yes' });
  });
});

describe('approval in the chat', () => {
  const approval = () =>
    chatWorkflow(
      [
        trigger(),
        ask(
          'Approve',
          {
            responseType: 'approval',
            message: 'Refund 10?',
            approvalOptions: {
              values: { approvalType: 'double', approveLabel: 'Yes', disapproveLabel: 'No' },
            },
          },
          'approve-key',
        ),
        say_('Result', '=Approved: {{ $json.data.approved }}'),
      ],
      main('Chat', 'Approve', 'Result'),
    );

  it('sends the buttons with the kit links of the node', async () => {
    const run = await approval();
    const links = buttonsOf(run.frames);
    expect(links.Yes).toMatch(
      new RegExp(`^/webhook-waiting/${run.executionId}/[^/]+/approve-key/answer\\?approved=true$`),
    );
    expect(links.No).toMatch(/\/approve-key\/answer\?approved=false$/);
    expect(run.frames.at(-1)?.type).toBe('wait');
  });

  it('a button fetched as NDJSON resumes the run and streams its frames', async () => {
    const run = await approval();
    const res = await get(buttonsOf(run.frames).Yes, { accept: NDJSON });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain(NDJSON);
    expect(shape(framesOf(res.body))).toEqual([
      ['begin', null, 'Result'],
      ['item', 'Approved: true', 'Result'],
      ['end', null, 'Result'],
    ]);
    await run.finished();
  });

  it('a browser opening the link gets the page, and the run goes on', async () => {
    const run = await approval();
    const res = await get(buttonsOf(run.frames).No, { accept: 'text/html,application/xhtml+xml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Your response has been recorded');
    const state = await run.finished();
    expect(outputOf(state, 'Approve')).toEqual([{ data: { approved: false } }]);
  });

  it('a typed reply to the approval approves nothing, whatever its body says', async () => {
    const run = await approval();
    const res = await post(run.path, {
      sessionId: 's1',
      chatInput: 'yes please',
      approved: true,
      data: { approved: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(shape(framesOf(res.body))[1]).toEqual(['item', 'Approved: false', 'Result']);
    const state = await run.finished();
    expect(outputOf(state, 'Approve')).toEqual([
      { sessionId: 's1', chatInput: 'yes please', data: { approved: false } },
    ]);
  });
});

describe('the Chat node under an agent', () => {
  const REFUND = node(
    'Refund',
    'test.chatRefund',
    { amount: `={{ $fromAI('amount', 'How much', 'string') }}` },
    [200, 400],
  );
  const agentWorkflow = (
    tool: WorkflowNode,
    extra: WorkflowNode[] = [],
    more: Record<string, unknown> = {},
  ) =>
    chatWorkflow(
      [
        trigger(),
        node('Agent', 'ai.agent', { promptType: 'define', text: 'Pay it back' }, [200, 0]),
        node('Model', 'test.chatNodeModel', {}, [100, 200]),
        tool,
        ...extra,
      ],
      {
        ...main('Chat', 'Agent'),
        ...link('Model', 'Agent', 'ai_languageModel'),
        ...link(tool.name, 'Agent', 'ai_tool'),
        ...more,
      },
    );
  const review = (parameters: DataObject = {}) =>
    agentWorkflow(
      node('Review', 'ai.chatHitlTool', parameters, [200, 200], { webhookId: 'review-key' }),
      [REFUND],
      link('Refund', 'Review', 'ai_tool'),
    );
  const refundCall = (id: string) =>
    callTool('Refund', { toolParameters: { amount: '10' }, hitlParameters: {} }, id);
  const toolResults = (messages: AiChatMessage[]) =>
    messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m.content]);

  it('a review streams its message, then waits on the signed review key of the tool', async () => {
    scripts.Model = [refundCall('c1'), say('done')];
    const run = await review();
    expect(
      shape(run.frames)
        .slice(0, 3)
        .map(([type, , name]) => [type, name]),
    ).toEqual([
      ['begin', 'Review'],
      ['item', 'Review'],
      ['end', 'Review'],
    ]);
    const message = JSON.parse(String(run.frames[1].content));
    expect(message.type).toBe('with-buttons');
    expect(message.text).toBe('The agent wants to run this tool: Refund\n\nInput:\n{"amount":"10"}');
    expect(run.frames[3].type).toBe('wait');
    expect(run.path).toMatch(/\/review-key-0-[A-Za-z0-9_-]+\/chat-reply$/);
    // the reply URL and the approval link name the same review
    const key = run.path.split('/')[4];
    expect(buttonsOf(run.frames).Approve).toContain(`/${key}/answer?approved=true`);
    expect(refunds).toEqual([]);
  });

  it('approve runs the gated tool', async () => {
    scripts.Model = [refundCall('c1'), say('refunded')];
    const run = await review();
    const res = await get(buttonsOf(run.frames).Approve, { accept: NDJSON });
    expect(res.statusCode, res.body).toBe(200);
    // only Respond to Chat nodes speak in this mode: the agent's answer is no frame of the resumed run
    expect(framesOf(res.body)).toEqual([]);
    const state = await run.finished();
    expect(refunds).toEqual([{ amount: '10' }]);
    expect(toolResults(requests.Model[1])).toEqual([['c1', '[{"refunded":"10"}]']]);
    expect(outputOf(state, 'Agent')).toEqual([{ output: 'refunded' }]);
  });

  it('decline does not run it', async () => {
    scripts.Model = [refundCall('c1'), say('stopped')];
    const run = await review({ approvalOptions: { values: { approvalType: 'double' } } });
    const res = await get(buttonsOf(run.frames).Decline, { accept: NDJSON });
    expect(res.statusCode, res.body).toBe(200);
    await run.finished();
    expect(refunds).toEqual([]);
    expect(toolResults(requests.Model[1])).toEqual([['c1', REJECTED('c1')]]);
  });

  it('a typed reply to the review is feedback, not an approval', async () => {
    scripts.Model = [refundCall('c1'), say('ok')];
    const run = await review();
    const res = await post(run.path, { sessionId: 's1', chatInput: 'only 5 please', approved: true });
    expect(res.statusCode, res.body).toBe(200);
    await run.finished();
    expect(refunds).toEqual([]);
    expect(String(toolResults(requests.Model[1])[0][1])).toContain('provided feedback: "only 5 please"');
  });

  it('a Send Message tool posts its message as its own group; the agent answer is no frame', async () => {
    scripts.Model = [callTool('Notify', {}, 'c1'), say('ok')];
    const run = await agentWorkflow(node('Notify', 'ai.chatTool', { message: 'Working on it' }, [200, 200]));
    // only Respond to Chat nodes speak in Using Response Nodes mode, as n8n: the agent streams only in Streaming
    expect(shape(run.frames)).toEqual([
      ['begin', null, 'Notify'],
      ['item', 'Working on it', 'Notify'],
      ['end', null, 'Notify'],
    ]);
    const result = JSON.parse(String(requests.Model[1].find((m) => m.role === 'tool')?.content));
    expect(result[0]).toMatchObject({
      sessionId: 's1',
      chatInput: 'Hi',
      sendMessage: 'Working on it',
      sent: true,
    });
  });
});

describe('a chat stream that closes after the run waits', () => {
  type StreamHandle = {
    streamHandle(
      tenant: TenantRow,
      workflow: Workflow,
      mode: 'responseNodes',
    ): { attach(execution: StartedExecution): WebhookReply };
    chatReplyUrl(): Promise<string | undefined>;
  };

  it('does not cancel the waiting run while the wait frame is looked up', async () => {
    const service = server.ctx.webhooks as unknown as StreamHandle;
    let lookedUp!: (url: string | undefined) => void;
    const lookup = vi
      .spyOn(service, 'chatReplyUrl')
      .mockReturnValue(new Promise((resolve) => (lookedUp = resolve)));
    const stop = vi.spyOn(server.ctx.executions, 'stop').mockResolvedValue('waiting');
    try {
      const workflow = new Workflow(
        { id: 'wf1', name: 'chat', nodes: [trigger()], connections: {} },
        server.ctx.registries.nodeTypes,
      );
      const outcome: ExecutionOutcome = { executionId: 'e1', status: 'waiting' };
      const reply = service
        .streamHandle({ id: 't1' } as TenantRow, workflow, 'responseNodes')
        .attach({ executionId: 'e1', finished: Promise.resolve(outcome) });
      // the run has reached its wait and the handler reads where the next message goes
      await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
      reply.stream!.destroy();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stop).not.toHaveBeenCalled();
      lookedUp(undefined);
    } finally {
      lookup.mockRestore();
      stop.mockRestore();
    }
  });
});
