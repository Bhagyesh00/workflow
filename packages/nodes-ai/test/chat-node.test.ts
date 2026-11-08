/**
 * P5-58 Respond to Chat (`ai.chat`): its parameters, n8n's two errors as a main node and as a tool, the message
 * it sends, the wait it plans, the reply item of the `chatReply` POST (limits, uploads, and a typed answer to an
 * approval that approves nothing), its tool result, the memory write and the hint.
 */
import { createWebhookContext, NodeTypes, WorkflowExecute } from '@workflow/core';
import { nodes as baseNodes } from '@workflow/nodes-base';
import {
  type AiChatMessage,
  type ChatChunkMeta,
  type Connections,
  type DataObject,
  ExpressionEvaluator,
  hasSendAndWaitOperation,
  hitlApproved,
  type Item,
  type NodeProperty,
  type NodeType,
  type WebhookRequest,
  Workflow,
  type WorkflowNode,
  withToolVariants,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes as aiNodes } from '../src';
import {
  ChatNode,
  FIRST_ITEM_HINT,
  NO_CHAT_TRIGGER,
  WRONG_RESPONSE_MODE,
} from '../src/nodes/trigger/Chat.node';
import { MAX_CHAT_INPUT } from '../src/nodes/trigger/chat-setup';
import { connect, node, scriptModel, services, testNodes, toolCalls } from './harness';

const RESUME = 'http://localhost:5678/webhook-waiting/e1/sig';

let appended: Array<{ sessionId: string; messages: AiChatMessage[] }> = [];
let chunks: Array<{ chunk: unknown; meta?: ChatChunkMeta }> = [];

const memoryNode: NodeType = {
  description: {
    name: 'test.chatMemory',
    displayName: 'Chat Memory',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Memory' },
    inputs: [],
    outputs: ['ai_memory'],
    properties: [],
  },
  async supplyData() {
    return {
      response: {
        kind: 'memory',
        load: async () => [],
        loadAll: async () => [],
        append: async (sessionId: string, messages: AiChatMessage[]) => {
          appended.push({ sessionId, messages });
        },
        replace: async () => {},
        clear: async () => {},
      },
    };
  },
};

const types = new NodeTypes(withToolVariants([...aiNodes, ...baseNodes, ...testNodes, memoryNode]));

beforeEach(() => {
  appended = [];
  chunks = [];
});

const trigger = (responseMode = 'responseNodes') =>
  node('Chat', 'ai.chatTrigger', { public: true, options: { responseMode } }, { webhookId: 'chat-hook' });
const reply = (parameters: DataObject, extra: Partial<WorkflowNode> = {}) =>
  node('Reply', 'ai.chat', parameters, { webhookId: 'reply-hook', ...extra });

const CHAT_ITEM: Item = { json: { sessionId: 's1', action: 'sendMessage', chatInput: 'Hi' } };

async function run(nodes: WorkflowNode[], connections: Connections, triggerItems: Item[] = [CHAT_ITEM]) {
  const workflow = new Workflow(
    {
      id: 'wf1',
      name: 'chat',
      nodes: nodes.map((n, i) => ({ ...n, position: [i * 200, 0] as [number, number] })),
      connections,
    },
    types,
  );
  const svc = services({
    nodeTypes: types,
    resumeUrl: RESUME,
    hooks: { sendChunk: (chunk, meta) => chunks.push({ chunk, meta }) },
  });
  const result = await new WorkflowExecute(workflow, svc).run({ triggerItems, startNode: nodes[0].name });
  const runData = result.state.resultData.runData;
  const output = (name: string) =>
    ((runData[name]?.at(-1)?.data?.main?.[0] ?? []) as Item[]).map((item) => item.json);
  return {
    result,
    runData,
    output,
    error: result.state.resultData.error as { message?: string } | undefined,
  };
}

const property = (properties: NodeProperty[], name: string, show?: DataObject) =>
  properties.filter(
    (p) =>
      p.name === name &&
      (!show ||
        Object.entries(show).every(([key, value]) =>
          (p.displayOptions?.show?.[key] as unknown[] | undefined)?.includes(value),
        )),
  );

describe('Respond to Chat parameters', () => {
  it('offers Send Message and Send and Wait with the kit, the chat options and the reply hook', () => {
    const { properties, webhooks } = ChatNode.description;
    const operation = property(properties, 'operation')[0];
    expect(operation.default).toBe('send');
    expect(operation.options?.map((o) => ('value' in o ? o.value : ''))).toEqual(['send', 'sendAndWait']);

    expect(property(properties, 'message', { operation: 'send' })).toHaveLength(1);
    expect(property(properties, 'message', { operation: 'sendAndWait' })).toHaveLength(1);
    const responseType = property(properties, 'responseType', { operation: 'sendAndWait' })[0];
    expect(responseType.options?.map((o) => ('value' in o ? o.value : ''))).toEqual([
      'approval',
      'freeText',
      'customForm',
    ]);
    expect(property(properties, 'approvalOptions', { responseType: 'approval' })).toHaveLength(1);

    const sendOptions = property(properties, 'options', { operation: 'send' })[0];
    expect((sendOptions.options as NodeProperty[]).map((o) => o.name)).toEqual([
      'memoryConnection',
      'autoSaveHighlightedData',
    ]);
    for (const type of ['approval', 'freeText', 'customForm']) {
      const options = property(properties, 'options', { operation: 'sendAndWait', responseType: type })[0];
      const names = (options.options as NodeProperty[]).map((o) => o.name);
      expect(names.slice(0, 2)).toEqual(['memoryConnection', 'autoSaveHighlightedData']);
      expect(names).toContain('limitWaitTime');
    }

    expect(webhooks?.map((w) => [w.name, w.httpMethod, w.path, w.restartWebhook])).toEqual([
      ['default', 'GET', 'answer', true],
      ['default', 'POST', 'answer', true],
      ['chatReply', 'POST', 'chat-reply', true],
    ]);
  });

  it('has a tool and a human review copy; the review copy asks for approval only', () => {
    expect(hasSendAndWaitOperation(ChatNode.description)).toBe(true);
    const tool = types.get('ai.chatTool')!;
    expect(tool.description.outputs).toEqual(['ai_tool']);
    const review = types.get('ai.chatHitlTool')!;
    const hidden = review.description.properties
      .filter((p) => p.type === 'hidden')
      .map((p) => [p.name, p.default]);
    expect(hidden).toEqual([
      ['operation', 'sendAndWait'],
      ['responseType', 'approval'],
    ]);
    const messages = review.description.properties.filter((p) => p.name === 'message');
    expect(messages).toHaveLength(1);
    expect(String(messages[0].default)).toContain('$tool.name');
    expect(review.description.webhooks?.some((w) => w.name === 'chatReply')).toBe(true);
  });
});

describe('the Chat Trigger checks', () => {
  it('fails as a main node without a chat trigger, or with another response mode', async () => {
    const alone = await run(
      [node('Start', 'test.trigger'), reply({ message: 'Hello' })],
      connect(['Start', 'Reply']),
    );
    expect(alone.result.status).toBe('error');
    expect(alone.error?.message).toBe(NO_CHAT_TRIGGER);

    const lastNode = await run(
      [trigger('lastNode'), reply({ message: 'Hello' })],
      connect(['Chat', 'Reply']),
    );
    expect(lastNode.result.status).toBe('error');
    expect(lastNode.error?.message).toBe(WRONG_RESPONSE_MODE);
    expect(chunks).toEqual([]);
  });

  it('gives the same errors to the agent when it runs as a tool', async () => {
    for (const [first, text] of [
      [node('Start', 'test.trigger'), NO_CHAT_TRIGGER],
      [trigger('streaming'), WRONG_RESPONSE_MODE],
    ] as const) {
      const requests = scriptModel('Model', [toolCalls(['Reply', {}, 'c1']), 'done']);
      const tool = node('Reply', 'ai.chatTool', { message: 'Hello' });
      const { result } = await run(
        [
          first,
          node('Agent', 'ai.agent', { promptType: 'define', text: 'Say hello' }),
          node('Model', 'test.fakeChatModel'),
          tool,
        ],
        connect([first.name, 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Reply', 'Agent', 'ai_tool']),
        [{ json: { sessionId: 's1', chatInput: 'Hi' } }],
      );
      expect(result.status).toBe('success');
      const toolMessage = requests[1].messages.find((m) => m.role === 'tool');
      expect(String(toolMessage?.content)).toContain(text);
    }
    // the agent may stream its own answer; the tool sent nothing
    expect(chunks.filter((c) => c.meta?.nodeName === 'Reply')).toEqual([]);
  });
});

describe('Send Message', () => {
  it('sends the message to the chat and passes its input on', async () => {
    const { result, output, runData } = await run(
      [trigger(), reply({ message: '=Hello {{ $json.chatInput }}' })],
      connect(['Chat', 'Reply']),
    );
    expect(result.status).toBe('success');
    expect(chunks).toEqual([
      { chunk: 'Hello Hi', meta: { nodeId: 'Reply', nodeName: 'Reply', runIndex: 0, itemIndex: 0 } },
    ]);
    expect(output('Reply')).toEqual([CHAT_ITEM.json]);
    expect(runData.Reply[0].hints).toBeUndefined();
    expect(result.state.resultData.customData).toEqual({ response_reply: 'Hello Hi' });
  });

  it('keeps no highlighted data when the option is off, and refuses an empty message', async () => {
    const off = await run(
      [trigger(), reply({ message: 'Hello', options: { autoSaveHighlightedData: false } })],
      connect(['Chat', 'Reply']),
    );
    expect(off.result.state.resultData.customData ?? {}).toEqual({});
    const empty = await run([trigger(), reply({ message: '  ' })], connect(['Chat', 'Reply']));
    expect(empty.error?.message).toBe('The message is empty');
  });

  it('writes the message to the connected memory as an AI message of the session', async () => {
    const { result } = await run(
      [
        trigger(),
        reply({ message: 'Stored', options: { memoryConnection: true } }),
        node('Memory', 'test.chatMemory'),
      ],
      connect(['Chat', 'Reply'], ['Memory', 'Reply', 'ai_memory']),
    );
    expect(result.status).toBe('success');
    expect(appended).toEqual([{ sessionId: 's1', messages: [{ role: 'assistant', content: 'Stored' }] }]);
  });

  it('sends the first item only and says so in a hint', async () => {
    const { runData, output } = await run(
      [trigger(), reply({ message: '=For {{ $json.n }}' })],
      connect(['Chat', 'Reply']),
      [{ json: { n: 1 } }, { json: { n: 2 } }],
    );
    expect(chunks.map((c) => c.chunk)).toEqual(['For 1']);
    expect(runData.Reply[0].hints).toEqual([{ message: FIRST_ITEM_HINT, level: 'info' }]);
    expect(output('Reply')).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('as a tool sends with its own node and returns its input with the message and sent: true, without an empty chatInput', async () => {
    for (const [chatInput, expected] of [
      [
        'Hi',
        { sessionId: 's1', chatInput: 'Hi', toolCallId: 'c1', sendMessage: 'From the tool', sent: true },
      ],
      ['', { sessionId: 's1', toolCallId: 'c1', sendMessage: 'From the tool', sent: true }],
    ] as const) {
      chunks = [];
      const requests = scriptModel('Model', [toolCalls(['Reply', {}, 'c1']), 'done']);
      const { result } = await run(
        [
          trigger(),
          node('Agent', 'ai.agent', { promptType: 'define', text: 'Say hello' }),
          node('Model', 'test.fakeChatModel'),
          node('Reply', 'ai.chatTool', { message: 'From the tool' }),
        ],
        connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Reply', 'Agent', 'ai_tool']),
        [{ json: { sessionId: 's1', chatInput } }],
      );
      expect(result.status).toBe('success');
      // the agent streams its own answer after it; the tool's message is a chunk of its own node
      expect(chunks.filter((c) => c.meta?.nodeName === 'Reply').map((c) => c.chunk)).toEqual([
        'From the tool',
      ]);
      const toolMessage = requests[1].messages.find((m) => m.role === 'tool');
      expect(JSON.parse(String(toolMessage?.content))).toEqual([expected]);
      // the tool's run keeps the sent message on its output item, as n8n's sendMessage
      expect(JSON.stringify(result.state.resultData.runData.Reply)).toContain(
        '"sendMessage":"From the tool"',
      );
    }
  });
});

describe('Send and Wait for Response', () => {
  it('sends an approval as a buttons message with the kit links of the node and waits', async () => {
    const { result } = await run(
      [
        trigger(),
        reply({
          operation: 'sendAndWait',
          message: 'Refund 10?',
          approvalOptions: { values: { approvalType: 'double', approveLabel: 'Yes', disapproveLabel: 'No' } },
        }),
      ],
      connect(['Chat', 'Reply']),
    );
    expect(result.status).toBe('waiting');
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(String(chunks[0].chunk))).toEqual({
      type: 'with-buttons',
      text: 'Refund 10?',
      buttons: [
        { text: 'Yes', link: `${RESUME}/reply-hook/answer?approved=true`, type: 'primary' },
        { text: 'No', link: `${RESUME}/reply-hook/answer?approved=false`, type: 'secondary' },
      ],
      blockUserInput: false,
    });
    expect(result.state.resultData.customData).toEqual({ response_reply: 'Refund 10?' });
  });

  it('sends free text as the message, a form as a link to its page, and keeps the time limit', async () => {
    const free = await run(
      [
        trigger(),
        reply({
          operation: 'sendAndWait',
          responseType: 'freeText',
          message: 'Your name?',
          options: {
            limitWaitTime: {
              values: { limitType: 'afterTimeInterval', resumeAmount: 2, resumeUnit: 'hours' },
            },
          },
        }),
      ],
      connect(['Chat', 'Reply']),
    );
    expect(free.result.status).toBe('waiting');
    expect(chunks.map((c) => c.chunk)).toEqual(['Your name?']);
    const waitTill = Date.parse(String(free.result.state.waitTill));
    expect(waitTill - Date.now()).toBeGreaterThan(7_000_000);
    expect(waitTill - Date.now()).toBeLessThanOrEqual(7_200_000);

    chunks = [];
    const form = await run(
      [
        trigger(),
        reply({
          operation: 'sendAndWait',
          responseType: 'customForm',
          message: 'Fill this in',
          formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
        }),
      ],
      connect(['Chat', 'Reply']),
    );
    expect(form.result.status).toBe('waiting');
    expect(chunks.map((c) => c.chunk)).toEqual([`Fill this in\n\n[Respond](${RESUME}/reply-hook/answer)`]);
  });

  it('writes the waiting message to memory before the wait', async () => {
    const { result } = await run(
      [
        trigger(),
        reply({
          operation: 'sendAndWait',
          responseType: 'freeText',
          message: 'Why?',
          options: { memoryConnection: true },
        }),
        node('Memory', 'test.chatMemory'),
      ],
      connect(['Chat', 'Reply'], ['Memory', 'Reply', 'ai_memory']),
    );
    expect(result.status).toBe('waiting');
    expect(appended).toEqual([{ sessionId: 's1', messages: [{ role: 'assistant', content: 'Why?' }] }]);
  });
});

describe('the chat reply', () => {
  const file = (mimeType: string, fileName = 'a.txt') => ({
    fieldName: 'files',
    fileName,
    mimeType,
    data: Buffer.from('file body'),
  });

  function replyHook(
    parameters: DataObject,
    request: Partial<WebhookRequest>,
    triggerOptions: DataObject = { responseMode: 'responseNodes' },
  ) {
    const chat = node('Chat', 'ai.chatTrigger', { public: true, options: triggerOptions });
    const target = reply({ operation: 'sendAndWait', message: 'Ok?', ...parameters });
    const workflow = new Workflow(
      { id: 'wf1', name: 'chat', nodes: [chat, target], connections: connect(['Chat', 'Reply']) },
      types,
    );
    const ctx = createWebhookContext(
      {
        workflow,
        node: target,
        services: services({ nodeTypes: types, mode: 'webhook' }),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      { method: 'POST', headers: {}, query: {}, params: {}, body: {}, ...request },
      'chatReply',
    );
    return ChatNode.webhook!(ctx);
  }

  it('gives the free text reply with chatInput at the top level and the session', async () => {
    const result = await replyHook(
      { responseType: 'freeText' },
      { body: { action: 'sendMessage', sessionId: 's1', chatInput: 'Ada', extra: 'dropped' } },
    );
    expect(result.workflowData).toEqual([[{ json: { sessionId: 's1', chatInput: 'Ada' } }]]);
  });

  it("saves the reply as the run's input highlighted data of the node unless its own option is off", async () => {
    const on = await replyHook({ responseType: 'freeText' }, { body: { sessionId: 's1', chatInput: 'Ada' } });
    expect(on.customData).toEqual({ input_reply: 'Ada' });
    const off = await replyHook(
      { responseType: 'freeText', options: { autoSaveHighlightedData: false } },
      { body: { sessionId: 's1', chatInput: 'Ada' } },
    );
    expect(off.customData).toBeUndefined();
    expect(off.workflowData).toEqual(on.workflowData);
  });

  it('a typed answer to an approval approves nothing, whatever the body says', async () => {
    const result = await replyHook(
      { responseType: 'approval' },
      { body: { chatInput: 'x', approved: true, data: { approved: true } } },
    );
    const item = result.workflowData![0][0];
    expect(item.json).toEqual({ chatInput: 'x', data: { approved: false } });
    expect((item.json.data as DataObject).approved).toBe(false);
    expect(hitlApproved(result.workflowData!)).toBe(false);
  });

  it('keeps the trigger limits: an over-long chatInput is 413, a bad session id 400, no text 400', async () => {
    const long = await replyHook(
      {},
      { body: { sessionId: 's1', chatInput: 'x'.repeat(MAX_CHAT_INPUT + 1) } },
    );
    expect(long.webhookResponse?.statusCode).toBe(413);
    expect(long.workflowData).toBeUndefined();
    const session = await replyHook({}, { body: { sessionId: 's'.repeat(201), chatInput: 'x' } });
    expect(session.webhookResponse?.statusCode).toBe(400);
    const empty = await replyHook({}, { body: { sessionId: 's1', chatInput: ' ' } });
    expect(empty.webhookResponse?.statusCode).toBe(400);
    const text = await replyHook({}, { body: 'plain' });
    expect(text.webhookResponse?.statusCode).toBe(400);
  });

  it('takes files by the trigger upload rules: a refused type is 415, no uploads 400, an allowed one is binary', async () => {
    const refused = await replyHook(
      {},
      { body: { sessionId: 's1', chatInput: 'x' }, files: [file('application/zip', 'a.zip')] },
      { responseMode: 'responseNodes', allowFileUploads: true, allowedFilesMimeTypes: 'image/*' },
    );
    expect(refused.webhookResponse?.statusCode).toBe(415);
    const off = await replyHook(
      {},
      { body: { sessionId: 's1', chatInput: 'x' }, files: [file('text/plain')] },
    );
    expect(off.webhookResponse?.statusCode).toBe(400);
    const accepted = await replyHook(
      { responseType: 'freeText' },
      { body: { sessionId: 's1', chatInput: 'see file' }, files: [file('image/png', 'a.png')] },
      { responseMode: 'responseNodes', allowFileUploads: true, allowedFilesMimeTypes: 'image/*' },
    );
    const item = accepted.workflowData![0][0];
    expect(item.json).toEqual({ sessionId: 's1', chatInput: 'see file' });
    expect(item.binary?.data0).toMatchObject({ fileName: 'a.png', mimeType: 'image/png' });
  });

  it('answers 404 when the node does not wait, and leaves the answer link to the kit', async () => {
    const notWaiting = await replyHook({ operation: 'send' }, { body: { chatInput: 'x' } });
    expect(notWaiting.webhookResponse?.statusCode).toBe(404);

    const chat = node('Chat', 'ai.chatTrigger', { options: { responseMode: 'responseNodes' } });
    const target = reply({ operation: 'sendAndWait', message: 'Ok?' });
    const ctx = createWebhookContext(
      {
        workflow: new Workflow({ id: 'wf1', name: 'chat', nodes: [chat, target], connections: {} }, types),
        node: target,
        services: services({ nodeTypes: types, mode: 'webhook' }),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      {
        method: 'GET',
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' },
        query: { approved: 'true' },
        params: {},
        body: {},
      },
      'default',
    );
    const answer = await ChatNode.webhook!(ctx);
    expect(answer.workflowData).toEqual([[{ json: { data: { approved: true } } }]]);
  });
});
