/**
 * P6-59 (S5 L2): the 14 AI events. Each family's node reports its event through `ctx.logAiEvent`, which the engine
 * hands to `hooks.aiEvent`. Fixed fake secrets only; the assertions read what the hook captured.
 */
import { createBaseContext, NodeTypes } from '@workflow/core';
import {
  type AiChatModel,
  type AiChatResponse,
  type AiEmbeddings,
  type AiEventName,
  type DataObject,
  type ExecuteContext,
  ExpressionEvaluator,
  type HttpRequestOptions,
  type NodeType,
  type SupplyDataContext,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import { eventErrorText, logAiEvent, stripCredentialValues } from '../src/shared/ai-events';
import { getRetriever } from '../src/shared/ai-inputs';
import { type ChatAdapter, HttpChatModel } from '../src/shared/chat-model';
import { HttpEmbeddings } from '../src/shared/http-embeddings';
import { createTool } from '../src/shared/tools';
import {
  connect,
  FakeHttpClient,
  node,
  run,
  scriptModel,
  services,
  testNodes,
  toolCalls,
  toolNodeTypes,
  vectorStoreMemoryData,
} from './harness';

interface Captured {
  name: AiEventName;
  nodeName: string;
  nodeType: string;
  msg: string;
}

/** services whose `hooks.aiEvent` records every event */
function capture() {
  const events: Captured[] = [];
  const svc = (extra: Parameters<typeof services>[0] = {}) =>
    services({
      ...extra,
      hooks: {
        aiEvent: (event) => {
          events.push({ ...event });
        },
      },
    });
  const names = () => events.map((e) => e.name);
  const of = (name: AiEventName) => events.filter((e) => e.name === name);
  return { events, svc, names, of };
}

const FAKE_KEY = 'sk-test-0123456789abcdefghijklmnop';

/** a supply context that records events */
function fakeSupply(extra: Record<string, unknown> = {}) {
  const sent: Array<{ name: AiEventName; msg: string }> = [];
  const ctx = {
    getNode: () => ({ name: 'Sub', type: 'ai.fake' }),
    signal: new AbortController().signal,
    logSubNodeRun: () => {},
    logAiEvent: (name: AiEventName, msg?: string) => {
      sent.push({ name, msg: msg ?? '' });
    },
    helpers: { httpRequestWithAuthentication: async () => ({}) },
    ...extra,
  } as unknown as SupplyDataContext;
  return { ctx, sent };
}

beforeEach(() => {
  clearBufferMemory();
  vectorStoreMemoryData.clear();
});

describe('the ai-events helper', () => {
  it('stringifies the data as the msg', () => {
    const { ctx, sent } = fakeSupply();
    logAiEvent(ctx, 'ai.text.splitter.split', { textLength: 3, chunks: 1 });
    expect(sent).toEqual([{ name: 'ai.text.splitter.split', msg: '{"textLength":3,"chunks":1}' }]);
  });

  it('does nothing without logAiEvent and never throws', () => {
    expect(() => logAiEvent({}, 'ai.llm.generated', { a: 1 })).not.toThrow();
    const boom = {
      logAiEvent: () => {
        throw new Error('hook failed');
      },
    };
    expect(() => logAiEvent(boom, 'ai.llm.generated', { a: 1 })).not.toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const { ctx, sent } = fakeSupply();
    logAiEvent(ctx, 'ai.llm.generated', cycle);
    expect(sent[0].msg).toBe('{"self":"[circular]"}');
  });

  it('removes credential keys and secret-looking values, at any depth, without changing the input', () => {
    const input = {
      query: 'hi',
      apiKey: 'a',
      Token: 'b',
      accessToken: 'c',
      PASSWORD: 'd',
      secret: 'e',
      authorization: 'f',
      credentials: { x: 1 },
      nested: { list: ['fine', FAKE_KEY], authorization: 'g', deep: { token: 'h', ok: true } },
      note: `uses ${FAKE_KEY}`,
    };
    expect(stripCredentialValues(input)).toEqual({
      query: 'hi',
      nested: { list: ['fine'], deep: { ok: true } },
    });
    expect(input.apiKey).toBe('a');
  });

  it('cuts an error text at 1000 characters and removes secrets', () => {
    expect(eventErrorText(new Error(`bad ${FAKE_KEY}`))).toBe('bad [redacted]');
    expect(eventErrorText(new Error('x'.repeat(2000)))).toHaveLength(1000);
  });
});

describe('model events (ai.llm.generated, ai.llm.error)', () => {
  const answer: AiChatResponse = { message: { role: 'assistant', content: 'whole' } };
  const adapter = (parse: () => AiChatResponse = () => answer): ChatAdapter => ({
    provider: 'fake',
    model: 'fake-1',
    credentialType: 'fakeApi',
    capabilities: { structuredOutput: false, structuredOutputWithTools: false },
    buildRequest: (): HttpRequestOptions => ({ method: 'POST', url: 'https://model.test/v1', body: {} }),
    parseResponse: parse,
  });

  it('reports a generated answer with the messages and the response', async () => {
    const { ctx, sent } = fakeSupply();
    const model: AiChatModel = new HttpChatModel(ctx, adapter(), { itemIndex: 0, maxRetries: 0 });
    await model.chat({ messages: [{ role: 'user', content: 'hello there' }] });
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe('ai.llm.generated');
    const msg = JSON.parse(sent[0].msg);
    expect(msg.messages[0].content).toBe('hello there');
    expect(msg.response.content).toBe('whole');
  });

  it('reports a model error with a redacted, cut message and no stack', async () => {
    const { ctx, sent } = fakeSupply();
    const failing = adapter(() => {
      throw new Error(`upstream said ${FAKE_KEY}`);
    });
    const model = new HttpChatModel(ctx, failing, { itemIndex: 0, maxRetries: 0 });
    await expect(model.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(sent.map((e) => e.name)).toEqual(['ai.llm.error']);
    expect(sent[0].msg).toContain('upstream said [redacted]');
    expect(sent[0].msg).not.toContain(FAKE_KEY);
    expect(sent[0].msg).not.toContain('    at ');
  });
});

describe('ai.tool.called', () => {
  const definition = {
    name: 'lookup',
    description: 'd',
    parameters: { type: 'object', properties: {} } as never,
  };

  it('arrives without a seeded apiKey or a secret value', async () => {
    const { ctx, sent } = fakeSupply();
    const tool = createTool(ctx, definition, async () => ({ found: true }));
    await tool.invoke({ query: 'cats', apiKey: 'seeded-api-key', note: FAKE_KEY, Authorization: 'x' });
    expect(sent.map((e) => e.name)).toEqual(['ai.tool.called']);
    const msg = JSON.parse(sent[0].msg);
    expect(msg.input).toEqual({ query: 'cats' });
    expect(msg.response).toEqual({ found: true });
    expect(sent[0].msg).not.toContain('seeded-api-key');
    expect(sent[0].msg).not.toContain(FAKE_KEY);
  });

  it('reports a failing call too, with the error text', async () => {
    const { ctx, sent } = fakeSupply();
    const tool = createTool(ctx, definition, async () => {
      throw new Error('tool exploded');
    });
    await expect(tool.invoke({ query: 'x' })).rejects.toThrow('tool exploded');
    expect(sent.map((e) => e.name)).toEqual(['ai.tool.called']);
    expect(JSON.parse(sent[0].msg).error).toBe('tool exploded');
  });

  it('a code tool called by the agent emits it with the tool node as the source', async () => {
    const c = capture();
    scriptModel('Model', [toolCalls(['Upper', { query: 'hello' }]), 'done']);
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: 'go' }),
        node('Model', 'test.fakeChatModel'),
        node('Upper', 'ai.toolCode', {
          toolDescription: 'Uppercases',
          jsCode: 'return query.toUpperCase();',
        }),
      ],
      connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Upper', 'Agent', 'ai_tool']),
      { services: c.svc() },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const called = c.of('ai.tool.called');
    expect(called).toHaveLength(1);
    expect(called[0].nodeName).toBe('Upper');
    expect(called[0].nodeType).toBe('ai.toolCode');
    expect(JSON.parse(called[0].msg).response).toBe('HELLO');
  });
});

describe('embeddings events', () => {
  it('HttpEmbeddings reports one document event per batch and a query event, with the texts', async () => {
    const { ctx, sent } = fakeSupply({
      helpers: {
        httpRequestWithAuthentication: async (_type: string, options: HttpRequestOptions) => options.body,
      },
    });
    const embeddings = new HttpEmbeddings(ctx, {
      credentialType: 'fake',
      model: 'embed-1',
      itemIndex: 0,
      batchSize: 2,
      maxRetries: 0,
      request: (texts) => ({ method: 'POST', url: 'https://embed.test/v1', body: texts as never }),
      parse: (body) => (body as string[]).map(() => [1, 2]),
    });
    await embeddings.embedDocuments(['a', 'b', 'c']);
    await embeddings.embedQuery('where?');
    expect(sent.map((e) => e.name)).toEqual([
      'ai.embeddings.embedded.document',
      'ai.embeddings.embedded.document',
      'ai.embeddings.embedded.query',
    ]);
    expect(JSON.parse(sent[0].msg)).toEqual({ documents: ['a', 'b'] });
    expect(JSON.parse(sent[2].msg)).toEqual({ query: 'where?' });
  });

  it('a failing embedding call reports no event', async () => {
    const { ctx, sent } = fakeSupply({
      helpers: {
        httpRequestWithAuthentication: async () => {
          throw new Error('down');
        },
      },
    });
    const embeddings = new HttpEmbeddings(ctx, {
      credentialType: 'fake',
      model: 'embed-1',
      itemIndex: 0,
      batchSize: 2,
      maxRetries: 0,
      request: () => ({ method: 'POST', url: 'https://embed.test/v1' }),
      parse: () => [],
    });
    await expect(embeddings.embedQuery('x')).rejects.toThrow('down');
    expect(sent).toEqual([]);
  });

  it('the Bedrock embeddings node reports them', async () => {
    const http = new FakeHttpClient(() => ({ body: { embedding: [1, 2], inputTextTokenCount: 2 } }));
    const sent: Array<{ name: AiEventName; msg: string }> = [];
    const n: WorkflowNode = {
      ...node('Node', 'ai.embeddingsAwsBedrock', { model: 'amazon.titan-embed-text-v2:0' }),
      credentials: { aws: { id: 'c', name: 'aws' } },
    };
    const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, toolNodeTypes);
    const base = createBaseContext({
      workflow,
      node: n,
      services: services({
        http,
        nodeTypes: toolNodeTypes,
        creds: { aws: { region: 'us-east-1', accessKeyId: 'AKIDTESTKEY000000000', secretAccessKey: 'fake' } },
      }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    });
    const ctx = {
      ...base,
      getInputData: () => [],
      getInputConnectionData: async () => undefined,
      runCode: async () => [],
      executeWorkflow: async () => ({ executionId: '', data: null }),
      getToolParameter: () => undefined,
      logSubNodeRun: () => undefined,
      logAiEvent: (name: AiEventName, msg?: string) => {
        sent.push({ name, msg: msg ?? '' });
      },
    };
    const { response } = await toolNodeTypes.get('ai.embeddingsAwsBedrock')!.supplyData!(ctx as never, 0);
    const embeddings = response as AiEmbeddings;
    await embeddings.embedDocuments(['doc one']);
    await embeddings.embedQuery('q');
    expect(sent.map((e) => e.name)).toEqual([
      'ai.embeddings.embedded.document',
      'ai.embeddings.embedded.query',
    ]);
  });
});

describe('memory events', () => {
  it('window memory reports a get and an add', async () => {
    const c = capture();
    scriptModel('Model', ['Nice to meet you, Ada.']);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent'),
        node('Model', 'test.fakeChatModel'),
        node('Memory', 'ai.memoryBufferWindow', { contextWindowLength: 2 }),
      ],
      connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Memory', 'Agent', 'ai_memory']),
      {
        triggerItems: [{ json: { sessionId: 's1', chatInput: 'My name is Ada' } }],
        services: c.svc(),
      },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(c.names()).toContain('ai.memory.get.messages');
    expect(c.names()).toContain('ai.memory.added.message');
    const added = c.of('ai.memory.added.message')[0];
    expect(added.nodeName).toBe('Memory');
    expect(added.msg).toContain('Ada');
  });
});

describe('output parser events', () => {
  const parserRun = async (parserParams: DataObject, modelReplies: string[], fixerReplies?: string[]) => {
    const c = capture();
    scriptModel('Model', modelReplies);
    if (fixerReplies) scriptModel('Fixer', fixerReplies);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent', { hasOutputParser: true }, { typeVersion: 2 }),
        node('Model', 'test.fakeChatModel'),
        node('Parser', 'ai.outputParserStructured', {
          jsonSchemaExample: '{"city": "Rome"}',
          ...parserParams,
        }),
        node('Fixer', 'test.fakeChatModel'),
      ],
      connect(
        ['Chat', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['Parser', 'Agent', 'ai_outputParser'],
        ['Fixer', 'Parser', 'ai_languageModel'],
      ),
      { triggerItems: [{ json: { chatInput: '?', sessionId: 's1' } }], services: c.svc() },
    );
    return { c, r };
  };

  it('the structured parser reports a parsed answer', async () => {
    const { c, r } = await parserRun({}, ['{"city": "Paris"}']);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const parsed = c.of('ai.output.parser.parsed');
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed[0].nodeName).toBe('Parser');
    expect(JSON.parse(parsed[0].msg).response).toEqual({ city: 'Paris' });
  });

  it('the auto-fixing parser reports the fixed text', async () => {
    const { c, r } = await parserRun({ autoFix: true }, ['not json'], ['{"city": "Paris"}']);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const parsed = c.of('ai.output.parser.parsed');
    expect(parsed.some((e) => JSON.parse(e.msg).response === '{"city": "Paris"}')).toBe(true);
  });

  it('the item list parser reports its list', async () => {
    const c = capture();
    scriptModel('Model', ['a\nb']);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent', { hasOutputParser: true }, { typeVersion: 2 }),
        node('Model', 'test.fakeChatModel'),
        node('Parser', 'ai.outputParserItemList'),
      ],
      connect(
        ['Chat', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['Parser', 'Agent', 'ai_outputParser'],
      ),
      { triggerItems: [{ json: { chatInput: '?', sessionId: 's1' } }], services: c.svc() },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(JSON.parse(c.of('ai.output.parser.parsed')[0].msg).response).toEqual(['a', 'b']);
  });
});

/** calls the connected retriever once with a fixed query */
const probe: NodeType = {
  description: {
    name: 'test.retrieverProbe',
    displayName: 'Probe',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Probe' },
    inputs: ['main', { type: 'ai_retriever', displayName: 'Retriever', maxConnections: 1 }],
    outputs: ['main'],
    properties: [],
  },
  async execute(ctx: ExecuteContext) {
    const retriever = (await getRetriever(ctx, 0))!;
    await retriever.retrieve('pets');
    return [[{ json: {} }]];
  },
};
const probeTypes = new NodeTypes([...nodes, ...testNodes, probe]);

describe('document, splitter, vector store and retriever events', () => {
  const KEY = `ai-events-${process.pid}-${Date.now()}`;
  const DOCS = ['Cats and dogs are pets', 'A car has an engine on the road'];

  it('insert reports the loader, the splitter and the populated store; update reports updated', async () => {
    const c = capture();
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'test.vectorStoreMemory', { mode: 'insert', memoryKey: KEY }),
        node('Loader', 'ai.documentDefaultDataLoader', {
          jsonMode: 'expressionData',
          jsonData: '={{ $json.text }}',
          textSplittingMode: 'custom',
        }),
        node('Splitter', 'ai.textSplitterRecursiveCharacter', { chunkSize: 12, chunkOverlap: 0 }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(
        ['Trigger', 'Store'],
        ['Loader', 'Store', 'ai_document'],
        ['Splitter', 'Loader', 'ai_textSplitter'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
      { triggerItems: DOCS.map((text) => ({ json: { text } })), services: c.svc() },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(c.names()).toContain('ai.text.splitter.split');
    expect(c.names()).toContain('ai.document.processed');
    const populated = c.of('ai.vector.store.populated');
    expect(populated).toHaveLength(1);
    expect(populated[0].nodeName).toBe('Store');
    expect(JSON.parse(c.of('ai.document.processed')[0].msg).items).toBe(1);

    const u = capture();
    const updated = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'test.vectorStoreMemory', { mode: 'update', memoryKey: KEY, id: '={{ $json.id }}' }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
      { triggerItems: [{ json: { id: 'doc-a', note: 'Pizza' } }], services: u.svc() },
    );
    expect(updated.status, JSON.stringify(updated.error)).toBe('success');
    expect(u.names()).toEqual(['ai.vector.store.updated']);
  });

  it('a retriever reports the search and the retrieval', async () => {
    const fill = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'test.vectorStoreMemory', { mode: 'insert', memoryKey: KEY }),
        node('Loader', 'ai.documentDefaultDataLoader', {
          jsonMode: 'expressionData',
          jsonData: '={{ $json.text }}',
        }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(
        ['Trigger', 'Store'],
        ['Loader', 'Store', 'ai_document'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
      { triggerItems: DOCS.map((text) => ({ json: { text } })) },
    );
    expect(fill.status, JSON.stringify(fill.error)).toBe('success');
    const c = capture();
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Probe', 'test.retrieverProbe'),
        node('Store', 'test.vectorStoreMemory', { mode: 'retrieve', memoryKey: KEY }),
        node('Embeddings', 'test.fakeEmbeddings'),
        node('Inner', 'ai.retrieverVectorStore', { topK: 2 }),
      ],
      connect(
        ['Trigger', 'Probe'],
        ['Store', 'Inner', 'ai_vectorStore'],
        ['Embeddings', 'Store', 'ai_embedding'],
        ['Inner', 'Probe', 'ai_retriever'],
      ),
      { nodeTypes: probeTypes, services: c.svc({ nodeTypes: probeTypes }) },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(c.names()).toEqual(['ai.vector.store.searched', 'ai.retriever.get.relevant.documents']);
    expect(c.of('ai.vector.store.searched')[0].nodeName).toBe('Store');
    expect(c.of('ai.retriever.get.relevant.documents')[0].nodeName).toBe('Inner');
  });
});
