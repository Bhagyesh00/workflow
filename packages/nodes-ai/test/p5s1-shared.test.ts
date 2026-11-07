/**
 * Phase 5 S1 shared contracts of nodes-ai, on fake contexts: model inputs, batching, the event-stream
 * branch of HttpChatModel, minProperties, the Databricks URL and the agent's two one-line changes.
 */
import type {
  AiChatModel,
  AiChatRequest,
  AiChatResponse,
  AiEmbeddings,
  AiTool,
  DataObject,
  ExecuteContext,
  HttpRequestOptions,
  Item,
  SupplyDataContext,
  WorkflowNode,
} from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNode } from '../src/nodes/agent/Agent.node';
import { runAgent } from '../src/nodes/agent/agent-loop';
import { COMPLETION_MODEL_NODES, getChatModel, getFallbackModel, getPrompt } from '../src/shared/ai-inputs';
import { batchingOption, runInBatches } from '../src/shared/batching';
import { type ChatAdapter, HttpChatModel } from '../src/shared/chat-model';
import { databricksGatewayUrl } from '../src/shared/databricks';
import { HttpEmbeddings } from '../src/shared/http-embeddings';
import { validateJsonSchema } from '../src/shared/json-schema';

// The branch under test is HttpChatModel's; the decoder itself is L11's. Frames here are JSON bytes.
const decoderEnds = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/shared/event-stream', () => ({
  createEventStreamDecoder: () => ({
    push: (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)),
    end: () => {
      decoderEnds.count++;
    },
  }),
}));

const NODE = {
  id: 'n1',
  name: 'AI Agent',
  type: 'ai.agent',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
} as WorkflowNode;

function fakeContext(raw: unknown, parameters: DataObject = {}): ExecuteContext {
  return {
    getNode: () => NODE,
    getInputConnectionData: async () => raw,
    getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) => parameters[name] ?? fallback,
  } as unknown as ExecuteContext;
}

function fakeModel(extra: Partial<AiChatModel> = {}): AiChatModel {
  return {
    kind: 'chatModel',
    provider: 'fake',
    model: 'fake-1',
    chat: async () => ({ message: { role: 'assistant', content: 'ok' } }),
    ...extra,
  };
}

describe('getChatModel', () => {
  it('refuses a completion model when chatOnly is set, naming the model node', async () => {
    const ctx = fakeContext(fakeModel({ completion: true, nodeName: 'Cohere Model' }));
    await expect(getChatModel(ctx, 0, { chatOnly: true })).rejects.toThrow(
      'Cohere Model is a text completion model; connect a chat model',
    );
  });

  it('passes a completion model without chatOnly, and a chat model with it', async () => {
    const completion = fakeModel({ completion: true, nodeName: 'Cohere Model' });
    await expect(getChatModel(fakeContext(completion), 0)).resolves.toBe(completion);
    const chat = fakeModel();
    await expect(getChatModel(fakeContext(chat), 0, { chatOnly: true })).resolves.toBe(chat);
  });

  it('reads the slot it is asked for, and keeps the first entry by default', async () => {
    const first = fakeModel();
    const second = fakeModel();
    const ctx = fakeContext([first, second]);
    await expect(getChatModel(ctx, 0)).resolves.toBe(first);
    await expect(getChatModel(ctx, 0, { slot: 1 })).resolves.toBe(second);
  });

  it('fails with the usual text when the slot is empty', async () => {
    await expect(getChatModel(fakeContext([undefined, fakeModel()]), 0)).rejects.toThrow(
      'Connect a chat model to this node',
    );
    await expect(getChatModel(fakeContext(fakeModel()), 0, { slot: 1 })).rejects.toThrow(
      'Connect a chat model to this node',
    );
  });

  it('lists the four completion model nodes', () => {
    expect(COMPLETION_MODEL_NODES).toEqual([
      'ai.lmCohere',
      'ai.lmOllama',
      'ai.lmLemonade',
      'ai.lmOpenHuggingFaceInference',
    ]);
  });
});

describe('getFallbackModel', () => {
  const missing = 'Please connect a model to the Fallback Model input or disable the fallback option';

  it('returns the model on the second port', async () => {
    const fallback = fakeModel();
    await expect(getFallbackModel(fakeContext([fakeModel(), fallback]), 0)).resolves.toBe(fallback);
  });

  it('fails with its own text on an empty slot and on a single port', async () => {
    await expect(getFallbackModel(fakeContext([fakeModel(), undefined]), 0)).rejects.toThrow(missing);
    await expect(getFallbackModel(fakeContext(fakeModel()), 0)).rejects.toThrow(missing);
    await expect(getFallbackModel(fakeContext(undefined), 0)).rejects.toThrow(missing);
  });

  it('refuses a node that supplies something else', async () => {
    await expect(getFallbackModel(fakeContext([fakeModel(), { kind: 'memory' }]), 0)).rejects.toThrow(
      'does not supply a chatModel',
    );
  });
});

describe('getPrompt', () => {
  const noChatInput: Item = { json: {} };

  it('keeps the texts of today without emptyText', () => {
    expect(() => getPrompt(fakeContext(undefined, { promptType: 'auto' }), 0, noChatInput)).toThrow(
      'No "chatInput" field in the input item',
    );
    expect(() =>
      getPrompt(fakeContext(undefined, { promptType: 'define', text: ' ' }), 0, noChatInput),
    ).toThrow('The prompt is empty');
  });

  it('throws emptyText in both empty cases', () => {
    const options = { emptyText: 'No prompt specified' };
    expect(() => getPrompt(fakeContext(undefined, { promptType: 'auto' }), 0, noChatInput, options)).toThrow(
      'No prompt specified',
    );
    expect(() =>
      getPrompt(fakeContext(undefined, { promptType: 'define', text: '' }), 0, noChatInput, options),
    ).toThrow('No prompt specified');
  });

  it('throws emptyText for an expression that gives nothing', () => {
    for (const text of [undefined, null]) {
      const ctx = {
        ...fakeContext(undefined, { promptType: 'define' }),
        getNodeParameter: (name: string) => (name === 'promptType' ? 'define' : text),
      } as unknown as ExecuteContext;
      expect(() => getPrompt(ctx, 0, noChatInput, { emptyText: 'No prompt specified' })).toThrow(
        'No prompt specified',
      );
    }
  });

  it('returns the prompt when there is one', () => {
    const item: Item = { json: { chatInput: 'hello' } };
    expect(getPrompt(fakeContext(undefined, { promptType: 'auto' }), 0, item)).toBe('hello');
    expect(getPrompt(fakeContext(undefined, { promptType: 'define', text: 'hi' }), 0, item)).toBe('hi');
  });
});

describe('batchingOption', () => {
  it('has the parameter names and labels of n8n, with the given default', () => {
    const property = batchingOption(5);
    expect(property).toMatchObject({ displayName: 'Batch Processing', name: 'batching', type: 'collection' });
    expect(property.options).toMatchObject([
      { displayName: 'Batch Size', name: 'batchSize', type: 'number', default: 5 },
      { displayName: 'Delay Between Batches', name: 'delayBetweenBatches', type: 'number', default: 0 },
    ]);
    expect(batchingOption(1).options).toMatchObject([{ default: 1 }, { default: 0 }]);
  });
});

describe('runInBatches', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns results in input order, even when a later item finishes first', async () => {
    const pending = runInBatches(3, { batchSize: 3, delayMs: 0 }, async (index) => {
      await new Promise((resolve) => setTimeout(resolve, (3 - index) * 10));
      return index * 2;
    });
    await vi.advanceTimersByTimeAsync(30);
    const results = await pending;
    expect(results).toEqual([
      { status: 'fulfilled', value: 0 },
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 4 },
    ]);
  });

  it('waits between batches, and never after the last one', async () => {
    const started: number[] = [];
    let done = false;
    const pending = runInBatches(5, { batchSize: 2, delayMs: 1000 }, async (index) => {
      started.push(index);
      return index;
    }).then((results) => {
      done = true;
      return results;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(999);
    expect(started).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual([0, 1, 2, 3]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await pending).toHaveLength(5);
  });

  it('runs a batch at the same time', async () => {
    let running = 0;
    let peak = 0;
    const pending = runInBatches(4, { batchSize: 2, delayMs: 0 }, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
    });
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(peak).toBe(2);
  });

  it('settles a failed item as rejected and goes on, a synchronous throw included', async () => {
    const results = await runInBatches(3, { batchSize: 1, delayMs: 0 }, (index) => {
      if (index === 0) throw new Error('sync');
      if (index === 1) return Promise.reject(new Error('async'));
      return Promise.resolve('ok');
    });
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    expect((results[0] as PromiseRejectedResult).reason.message).toBe('sync');
  });

  it('treats a batch size below 1 as 1, and runs nothing for no items', async () => {
    const seen: number[] = [];
    await runInBatches(2, { batchSize: 0, delayMs: 0 }, async (index) => {
      seen.push(index);
    });
    expect(seen).toEqual([0, 1]);
    await expect(
      runInBatches(0, { batchSize: 2, delayMs: 100 }, () => Promise.reject(new Error('never'))),
    ).resolves.toEqual([]);
  });

  it('stops on abort, before the first batch and during a delay', async () => {
    const before = new AbortController();
    before.abort(new Error('stopped'));
    const never = vi.fn(async () => 1);
    await expect(runInBatches(2, { batchSize: 1, delayMs: 0, signal: before.signal }, never)).rejects.toThrow(
      'stopped',
    );
    expect(never).not.toHaveBeenCalled();

    const during = new AbortController();
    const run = vi.fn(async () => 1);
    const pending = runInBatches(2, { batchSize: 1, delayMs: 1000, signal: during.signal }, run);
    const outcome = expect(pending).rejects.toThrow('stopped later');
    await vi.advanceTimersByTimeAsync(10);
    during.abort(new Error('stopped later'));
    await outcome;
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('minProperties', () => {
  const schema = { type: 'object', minProperties: 2 };

  it('fails an object with too few properties', () => {
    const errors = validateJsonSchema({ a: 1 }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('must have at least 2 properties');
    expect(validateJsonSchema({ a: 1, b: undefined }, schema)).toHaveLength(1);
  });

  it('passes an object with enough, and an empty object when it is not set', () => {
    expect(validateJsonSchema({ a: 1, b: 2 }, schema)).toEqual([]);
    expect(validateJsonSchema({}, { type: 'object' })).toEqual([]);
  });

  it('applies to a nested object', () => {
    const nested = { type: 'object', properties: { inner: { type: 'object', minProperties: 1 } } };
    expect(validateJsonSchema({ inner: {} }, nested)).toHaveLength(1);
  });
});

describe('databricksGatewayUrl', () => {
  it('builds the gateway URL from an https host', () => {
    expect(databricksGatewayUrl('https://adb-1.cloud.databricks.com')).toBe(
      'https://adb-1.cloud.databricks.com/ai-gateway/openai/v1',
    );
    expect(databricksGatewayUrl(' https://adb-1.cloud.databricks.com/ ')).toBe(
      'https://adb-1.cloud.databricks.com/ai-gateway/openai/v1',
    );
  });

  it.each([
    'http://adb-1.cloud.databricks.com',
    'adb-1.cloud.databricks.com',
    'ftp://adb-1.cloud.databricks.com',
    'https://user:pw@adb-1.cloud.databricks.com',
    'https://adb-1.cloud.databricks.com?x=1',
    '',
  ])('refuses %j, without repeating it', (host) => {
    expect(() => databricksGatewayUrl(host)).toThrow('must be an https URL');
    try {
      databricksGatewayUrl(host);
    } catch (error) {
      if (host) expect((error as Error).message).not.toContain(host);
    }
  });
});

describe('HttpEmbeddings moved to its own file', () => {
  it('sends texts in batches', async () => {
    const calls: string[][] = [];
    const ctx = {
      signal: new AbortController().signal,
      logSubNodeRun: () => {},
      helpers: {
        httpRequestWithAuthentication: async (_type: string, options: HttpRequestOptions) => {
          const texts = options.body as string[];
          calls.push(texts);
          return texts.map(() => [1, 2]);
        },
      },
    } as unknown as SupplyDataContext;
    const embeddings: AiEmbeddings = new HttpEmbeddings(ctx, {
      credentialType: 'fake',
      model: 'embed-1',
      itemIndex: 0,
      batchSize: 2,
      maxRetries: 0,
      request: (texts) => ({ method: 'POST', url: 'https://embed.test/v1', body: texts }),
      parse: (body) => body as number[][],
    });
    await expect(embeddings.embedDocuments(['a', 'b', 'c'])).resolves.toHaveLength(3);
    expect(calls).toEqual([['a', 'b'], ['c']]);
    expect(embeddings.dimensions).toBe(2);
  });
});

describe('HttpChatModel', () => {
  const answer: AiChatResponse = { message: { role: 'assistant', content: 'whole' } };

  function fakeSupply(body: unknown) {
    const logs: Array<{ input: DataObject; output: DataObject; error?: Error }> = [];
    const ctx = {
      getNode: () => ({ ...NODE, name: 'My Model' }),
      signal: new AbortController().signal,
      logSubNodeRun: (input: DataObject, output: DataObject, error?: Error) => {
        logs.push({ input, output, error });
      },
      helpers: { httpRequestWithAuthentication: async () => body },
    } as unknown as SupplyDataContext;
    return { ctx, logs };
  }

  function fakeAdapter(extra: Partial<ChatAdapter> = {}): ChatAdapter {
    return {
      provider: 'fake',
      model: 'fake-1',
      credentialType: 'fakeApi',
      capabilities: { structuredOutput: false, structuredOutputWithTools: false },
      buildRequest: (): HttpRequestOptions => ({ method: 'POST', url: 'https://model.test/v1', body: {} }),
      parseResponse: () => answer,
      ...extra,
    };
  }

  const request: AiChatRequest = { messages: [{ role: 'user', content: 'hi' }] };

  it('carries the node name and the completion flag', () => {
    const { ctx } = fakeSupply({});
    const chat = new HttpChatModel(ctx, fakeAdapter(), { itemIndex: 0, maxRetries: 0 });
    expect(chat.nodeName).toBe('My Model');
    expect(chat.completion).toBeFalsy();
    const completion = new HttpChatModel(ctx, fakeAdapter(), {
      itemIndex: 0,
      maxRetries: 0,
      completion: true,
    });
    expect(completion.completion).toBe(true);
  });

  it('logs a file by its name, never its data', async () => {
    const { ctx, logs } = fakeSupply({});
    const model = new HttpChatModel(ctx, fakeAdapter(), { itemIndex: 0, maxRetries: 0 });
    await model.chat({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'read this' },
            { type: 'file', data: 'U0VDUkVU', mimeType: 'application/pdf', fileName: 'report.pdf' },
            { type: 'file', data: 'U0VDUkVU', mimeType: 'text/plain' },
            { type: 'image', data: 'U0VDUkVU', mimeType: 'image/png' },
          ],
        },
      ],
    });
    const logged = JSON.stringify(logs[0].input);
    expect(logged).toContain('[file report.pdf]');
    expect(logged).toContain('[file text/plain]');
    expect(logged).toContain('[image image/png]');
    expect(logged).not.toContain('U0VDUkVU');
  });

  describe('eventStream adapters', () => {
    const encode = (frames: unknown) => new TextEncoder().encode(JSON.stringify(frames));

    function streamingAdapter(events: Array<[string, unknown]>) {
      return fakeAdapter({
        eventStream: true,
        streamParser: (onDelta) => ({
          push: (event, json) => {
            events.push([event, json]);
            if (typeof json.text === 'string') onDelta(json.text);
          },
          finish: () => answer,
        }),
      });
    }

    beforeEach(() => {
      decoderEnds.count = 0;
    });

    it('sends the frames of a live stream to the parser, then ends the decoder', async () => {
      const body = (async function* () {
        yield encode([{ eventType: 'start', payload: { role: 'assistant' } }]);
        yield encode([
          { eventType: 'delta', payload: { text: 'a' } },
          { eventType: 'delta', payload: { text: 'b' } },
        ]);
      })();
      const events: Array<[string, unknown]> = [];
      const { ctx } = fakeSupply(body);
      const model = new HttpChatModel(ctx, streamingAdapter(events), { itemIndex: 0, maxRetries: 0 });
      const deltas: string[] = [];
      await expect(model.stream!(request, (text) => deltas.push(text))).resolves.toBe(answer);
      expect(events).toEqual([
        ['start', { role: 'assistant' }],
        ['delta', { text: 'a' }],
        ['delta', { text: 'b' }],
      ]);
      expect(deltas).toEqual(['a', 'b']);
      expect(decoderEnds.count).toBe(1);
    });

    it('still parses a whole answer when the body is not a stream', async () => {
      const events: Array<[string, unknown]> = [];
      const { ctx } = fakeSupply({ whole: true });
      const model = new HttpChatModel(ctx, streamingAdapter(events), { itemIndex: 0, maxRetries: 0 });
      const deltas: string[] = [];
      await expect(model.stream!(request, (text) => deltas.push(text))).resolves.toBe(answer);
      expect(events).toEqual([]);
      expect(deltas).toEqual(['whole']);
      expect(decoderEnds.count).toBe(0);
    });

    it('exports the decoder L11 fills', async () => {
      const actual = await vi.importActual<typeof import('../src/shared/event-stream')>(
        '../src/shared/event-stream',
      );
      expect(typeof actual.createEventStreamDecoder).toBe('function');
    });
  });
});

describe('agent', () => {
  it('the loop passes the tool call id to the tool', async () => {
    const seen: Array<string | undefined> = [];
    const tool: AiTool = {
      kind: 'tool',
      name: 'lookup',
      description: 'Look something up',
      parameters: { type: 'object', properties: {} },
      invoke: async (_args, options) => {
        seen.push(options?.toolCallId);
        return 'found';
      },
    };
    let calls = 0;
    const model = fakeModel({
      chat: async () =>
        calls++ === 0
          ? {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-7', name: 'lookup', arguments: {} }],
              },
            }
          : { message: { role: 'assistant', content: 'done' } },
    });
    const result = await runAgent({
      node: NODE,
      itemIndex: 0,
      model,
      tools: [tool],
      systemMessage: '',
      input: 'hi',
      maxIterations: 3,
    });
    expect(seen).toEqual(['call-7']);
    expect(result.text).toBe('done');
  });

  it('the Agent node refuses a completion model before any model call', async () => {
    const chat = vi.fn(async () => ({ message: { role: 'assistant' as const, content: 'no' } }));
    const model = fakeModel({ completion: true, nodeName: 'Ollama Model', chat });
    const known: Record<string, unknown> = {
      getNode: () => NODE,
      getInputData: () => [{ json: { chatInput: 'hi' } }],
      getInputConnectionData: async () => model,
      getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
        name === 'promptType' ? 'auto' : fallback,
      continueOnFail: () => false,
    };
    // any other context method answers nothing: only the refusal is under test here
    const ctx = new Proxy(known, {
      get: (target, key: string) => (key in target ? target[key] : () => undefined),
    }) as unknown as ExecuteContext;
    await expect(AgentNode.execute!(ctx)).rejects.toThrow(
      'Ollama Model is a text completion model; connect a chat model',
    );
    expect(chat).not.toHaveBeenCalled();
  });
});
