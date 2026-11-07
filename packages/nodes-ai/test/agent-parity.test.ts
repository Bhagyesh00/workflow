import { NodeTypes } from '@workflow/core';
import {
  type AiChatModel,
  type AiChatResponse,
  type AiTool,
  type Connections,
  type DataObject,
  evaluatePortExpression,
  type ExecutionResult,
  highlightedResponseKey,
  type Item,
  type NodeType,
  resolveNodeParameters,
  resolvePorts,
  type WorkflowNode,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import { AgentNode } from '../src/nodes/agent/Agent.node';
import { runAgent } from '../src/nodes/agent/agent-loop';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import {
  connect,
  FakeHttpClient,
  type FakeReply,
  modelRequests,
  node,
  run,
  scriptModel,
  sequence,
  services,
  testNodes,
  toolCalls,
} from './harness';

const TEXT = 'No prompt specified';
const chat = (chatInput: string, extra: Partial<Item> = {}): Item[] => [
  { json: { sessionId: 's1', chatInput, action: 'sendMessage' }, ...extra },
];

const bin = (text: string | Buffer, mimeType: string, fileName: string) => ({
  data: Buffer.from(text).toString('base64'),
  mimeType,
  fileName,
  fileSize: Buffer.byteLength(text),
});

interface Setup {
  agent?: DataObject;
  version?: number;
  extraNodes?: WorkflowNode[];
  links?: Parameters<typeof connect>;
  fallback?: boolean;
  trigger?: DataObject;
}

function workflow(setup: Setup = {}) {
  const nodes = [
    node('Chat', 'ai.chatTrigger', setup.trigger ?? {}),
    node('Agent', 'ai.agent', setup.agent ?? {}, { typeVersion: setup.version ?? 2 }),
    node('Model', 'test.fakeChatModel'),
    ...(setup.fallback ? [node('Fallback', 'test.fakeChatModel')] : []),
    ...(setup.extraNodes ?? []),
  ];
  const connections: Connections = connect(
    ['Chat', 'Agent'],
    ['Model', 'Agent', 'ai_languageModel'],
    ...(setup.links ?? []),
  );
  if (setup.fallback) {
    // the second chat-model port of the agent
    connections.Fallback = { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 1 }]] };
  }
  return { nodes, connections };
}

async function runSetup(
  setup: Setup,
  items: Item[] = chat('Hi'),
  extra: Partial<Parameters<typeof run>[2]> = {},
) {
  const wf = workflow(setup);
  return run(wf.nodes, wf.connections, { triggerItems: items, ...extra });
}

beforeEach(() => {
  clearBufferMemory();
  modelRequests.clear();
});

describe('Agent parity: fallback model on a streaming run', () => {
  const AGENT = node('Agent', 'ai.agent');
  const answer = (content: string, toolCallsOf: AiChatResponse['message']['toolCalls'] = undefined) =>
    ({ message: { role: 'assistant', content, toolCalls: toolCallsOf } }) as AiChatResponse;
  const model = (extra: Partial<AiChatModel>): AiChatModel => ({
    kind: 'chatModel',
    provider: 'fake',
    model: 'fake-1',
    chat: async () => {
      throw new Error('only chat here');
    },
    ...extra,
  });
  const failsAfter = (text?: string) =>
    model({
      stream: async (_request, onDelta) => {
        if (text) onDelta(text);
        throw new Error('The stream broke');
      },
    });
  const streamingAnswer = (text: string) =>
    model({
      stream: async (_request, onDelta) => {
        onDelta(text);
        return answer(text);
      },
    });
  const go = async (main: AiChatModel, fallbackModel: AiChatModel, tools: AiTool[] = []) => {
    const chunks: string[] = [];
    const run = runAgent({
      node: AGENT,
      itemIndex: 0,
      model: main,
      fallbackModel,
      tools,
      systemMessage: '',
      input: 'Hi',
      maxIterations: 5,
      streaming: true,
      onChunk: (chunk) => chunks.push(chunk),
    });
    return { run, chunks };
  };
  const plainAnswer = (text: string) => model({ chat: async () => answer(text) });

  it('a failure after a delta rethrows and leaves the fallback alone', async () => {
    const chat = vi.fn(async () => answer('Full fallback answer'));
    const { run, chunks } = await go(failsAfter('Half of the mai'), model({ chat }));
    await expect(run).rejects.toThrow('The stream broke');
    expect(chat).not.toHaveBeenCalled();
    expect(chunks).toEqual(['Half of the mai']);
  });

  it('a failure before any delta sends a fallback that cannot stream in one chunk', async () => {
    const { run, chunks } = await go(failsAfter(), plainAnswer('Full fallback answer'));
    expect((await run).text).toBe('Full fallback answer');
    expect(chunks).toEqual(['Full fallback answer']);
  });

  it('a failure before any delta lets a streaming fallback stream', async () => {
    const { run, chunks } = await go(failsAfter(), streamingAnswer('Streamed answer'));
    expect((await run).text).toBe('Streamed answer');
    expect(chunks).toEqual(['Streamed answer']);
  });

  it('a stream that sent no delta still gets its answer out', async () => {
    const quiet = model({ stream: async () => answer('Quiet answer') });
    const { run, chunks } = await go(quiet, plainAnswer('unused'));
    expect((await run).text).toBe('Quiet answer');
    expect(chunks).toEqual(['Quiet answer']);
  });

  it('text from an earlier turn counts: the fallback is not tried after it', async () => {
    const chat = vi.fn(async () => answer('unused'));
    const stream = vi
      .fn<NonNullable<AiChatModel['stream']>>()
      .mockImplementationOnce(async (_request, onDelta) => {
        onDelta('Let me check. ');
        return answer('Let me check. ', [{ id: 't1', name: 'Look', arguments: {} }]);
      })
      .mockRejectedValueOnce(new Error('The stream broke'));
    const look: AiTool = {
      kind: 'tool',
      name: 'Look',
      description: 'Looks',
      parameters: { type: 'object', properties: {} },
      invoke: async () => 'seen',
    };
    const { run, chunks } = await go(model({ stream }), model({ chat }), [look]);
    await expect(run).rejects.toThrow('The stream broke');
    expect(chat).not.toHaveBeenCalled();
    expect(chunks).toEqual(['Let me check. ']);
  });
});

describe('Agent parity: AI Agent Tool with a fallback model', () => {
  it('the sub-agent falls back when its main model fails', async () => {
    const outer = scriptModel('Outer', [toolCalls(['Researcher', { input: 'q' }, 'c1']), 'done']);
    scriptModel('Inner', () => {
      throw new Error('main model down');
    });
    const spare = scriptModel('Spare', ['from the spare']);
    const connections: Connections = connect(
      ['Chat', 'Agent'],
      ['Outer', 'Agent', 'ai_languageModel'],
      ['Researcher', 'Agent', 'ai_tool'],
      ['Inner', 'Researcher', 'ai_languageModel'],
    );
    connections.Spare = { ai_languageModel: [[{ node: 'Researcher', type: 'ai_languageModel', index: 1 }]] };
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent', {}),
        node('Outer', 'test.fakeChatModel'),
        node('Researcher', 'ai.agentTool', {
          text: "={{ $fromAI('input', 'The prompt') }}",
          needsFallback: true,
        }),
        node('Inner', 'test.fakeChatModel'),
        node('Spare', 'test.fakeChatModel'),
      ],
      connections,
      { triggerItems: chat('Hi') },
    );
    expect(r.status).toBe('success');
    expect(spare).toHaveLength(1);
    expect(String(outer[1].messages.at(-1)?.content)).toContain('from the spare');
  });
});

describe('Agent parity: fallback model', () => {
  it('answers from the fallback model after the main model fails', async () => {
    scriptModel('Model', () => {
      throw new Error('main model down');
    });
    const fallback = scriptModel('Fallback', ['from the fallback']);
    const r = await runSetup({ agent: { needsFallback: true }, fallback: true });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'from the fallback' }]);
    expect(modelRequests.get('Model')).toHaveLength(1);
    expect(fallback).toHaveLength(1);
    expect(fallback[0].messages.at(-1)).toEqual({ role: 'user', content: 'Hi' });
  });

  it('does not touch the fallback model while the main model answers', async () => {
    scriptModel('Model', ['main answer']);
    const fallback = scriptModel('Fallback', ['unused']);
    const r = await runSetup({ agent: { needsFallback: true }, fallback: true });
    expect(r.output('Agent')).toEqual([{ output: 'main answer' }]);
    expect(fallback).toHaveLength(0);
  });

  it('goes to the fallback on the same turn with the same tools', async () => {
    const fallback = scriptModel('Fallback', ['it is 5']);
    scriptModel('Model', (_req, call) => {
      if (call === 0) return toolCalls(['Calculator', { input: '2+3' }]);
      throw new Error('main model down');
    });
    const r = await runSetup({
      agent: { needsFallback: true },
      fallback: true,
      extraNodes: [node('Calculator', 'ai.toolCalculator')],
      links: [['Calculator', 'Agent', 'ai_tool']],
    });
    expect(r.output('Agent')).toEqual([{ output: 'it is 5' }]);
    expect(fallback[0].tools?.map((t) => t.name)).toEqual(['Calculator']);
    expect(fallback[0].messages.at(-1)).toMatchObject({ role: 'tool', content: '5' });
  });

  it('asks for a model on the Fallback Model input when none is connected', async () => {
    scriptModel('Model', ['x']);
    const r = await runSetup({ agent: { needsFallback: true } });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe(
      'Please connect a model to the Fallback Model input or disable the fallback option',
    );
  });
});

describe('Agent parity: batching', () => {
  it('waits between batches', async () => {
    scriptModel('Model', ['a', 'b']);
    const items = [...chat('one'), ...chat('two')];
    const started = Date.now();
    const r = await runSetup(
      { agent: { options: { batching: { batchSize: 1, delayBetweenBatches: 250 } } } },
      items,
    );
    expect(r.status).toBe('success');
    expect(r.output('Agent').map((o) => o.output)).toEqual(['a', 'b']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });

  it('runs a batch of two items without a pause', async () => {
    scriptModel('Model', ['a', 'b']);
    const items = [...chat('one'), ...chat('two')];
    const started = Date.now();
    const r = await runSetup(
      { agent: { options: { batching: { batchSize: 2, delayBetweenBatches: 2000 } } } },
      items,
    );
    expect(r.output('Agent')).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('stops after the first failed item when items run one by one', async () => {
    scriptModel('Model', () => {
      throw new Error('boom');
    });
    const r = await runSetup({}, [...chat('one'), ...chat('two')]);
    expect(r.status).toBe('error');
    expect(modelRequests.get('Model')).toHaveLength(1);
  });
});

describe('Agent parity: force the first tool call', () => {
  const calculator = {
    extraNodes: [node('Calculator', 'ai.toolCalculator')],
    links: [['Calculator', 'Agent', 'ai_tool']] as Setup['links'],
  };

  it('forces a tool on the first model call only', async () => {
    const requests = scriptModel('Model', [toolCalls(['Calculator', { input: '1+1' }]), 'two']);
    const r = await runSetup({ agent: { options: { forceToolCallOnFirstIteration: true } }, ...calculator });
    expect(r.status).toBe('success');
    expect(requests[0].toolChoice).toBe('any');
    expect(requests[1].toolChoice).toBeUndefined();
  });

  it('forces nothing when the option is off or the agent has no tools', async () => {
    const off = scriptModel('Model', ['plain']);
    await runSetup({ ...calculator });
    expect(off[0].toolChoice).toBeUndefined();
    const noTools = scriptModel('Model', ['plain']);
    await runSetup({ agent: { options: { forceToolCallOnFirstIteration: true } } });
    expect(noTools[0].toolChoice).toBeUndefined();
  });

  const OPENAI = { openAiApi: { apiKey: 'sk-test-key', baseUrl: 'https://api.openai.com/v1' } };
  const ANTHROPIC = { anthropicApi: { apiKey: 'ant-test-key', baseUrl: 'https://api.anthropic.com' } };
  const GEMINI = {
    googleGeminiApi: { apiKey: 'gem-test-key', host: 'https://generativelanguage.googleapis.com' },
  };
  const withCreds = (n: WorkflowNode, type: string): WorkflowNode => ({
    ...n,
    credentials: { [type]: { id: 'c1', name: type } },
  });

  async function runProvider(model: WorkflowNode, creds: Record<string, DataObject>, replies: FakeReply[]) {
    const http = new FakeHttpClient(sequence(...replies));
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', {
          promptType: 'define',
          text: 'Add 1 and 1',
          options: { enableStreaming: false, forceToolCallOnFirstIteration: true },
        }),
        model,
        node('Calculator', 'ai.toolCalculator'),
      ],
      connect(
        ['Trigger', 'Agent'],
        [model.name, 'Agent', 'ai_languageModel'],
        ['Calculator', 'Agent', 'ai_tool'],
      ),
      { services: services({ creds, http }) },
    );
    return { r, http };
  }

  it('sends tool_choice required to OpenAI', async () => {
    const { r, http } = await runProvider(withCreds(node('OpenAI', 'ai.lmChatOpenAi'), 'openAiApi'), OPENAI, [
      {
        body: {
          model: 'gpt-5-mini',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'two' } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        },
      },
    ]);
    expect(r.status).toBe('success');
    expect(http.bodies[0].tool_choice).toBe('required');
  });

  it('sends tool_choice any to Anthropic', async () => {
    const { r, http } = await runProvider(
      withCreds(node('Claude', 'ai.lmChatAnthropic', { model: 'claude-opus-4-8' }), 'anthropicApi'),
      ANTHROPIC,
      [
        {
          body: {
            model: 'claude',
            content: [{ type: 'text', text: 'two' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
      ],
    );
    expect(r.status).toBe('success');
    expect(http.bodies[0].tool_choice).toEqual({ type: 'any' });
  });

  it('sends an ANY function calling mode to Gemini', async () => {
    const { r, http } = await runProvider(
      withCreds(node('Gemini', 'ai.lmChatGoogleGemini'), 'googleGeminiApi'),
      GEMINI,
      [
        {
          body: {
            candidates: [{ content: { role: 'model', parts: [{ text: 'two' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
          },
        },
      ],
    );
    expect(r.status).toBe('success');
    expect(http.bodies[0].toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  });

  it('fails clearly on Ollama, which cannot be forced, without a request', async () => {
    const { r, http } = await runProvider(
      withCreds(node('Ollama', 'ai.lmChatOllama'), 'ollamaApi'),
      { ollamaApi: { baseUrl: 'https://ollama.test' } },
      [],
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('cannot be forced to call a tool');
    expect(http.requests).toHaveLength(0);
  });
});

describe('Agent parity: files', () => {
  const pdf = bin('%PDF-1.4 test', 'application/pdf', 'doc.pdf');
  const txt = bin('hello text', 'text/plain', 'notes.txt');
  const png = bin('PNGDATA', 'image/png', 'pic.png');
  const input = (binary: Record<string, unknown>): Item[] =>
    chat('Read these', { binary: binary as Item['binary'] });

  it('sends PDFs as files and text files as text when the option is on', async () => {
    const requests = scriptModel('Model', ['read']);
    const r = await runSetup(
      { agent: { options: { passthroughBinaryPdfs: true } } },
      input({ pdf, txt, png }),
    );
    expect(r.status).toBe('success');
    const content = requests[0].messages.at(-1)!.content as unknown as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: 'text', text: 'Read these' },
      {
        type: 'file',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 test').toString('base64'),
        fileName: 'doc.pdf',
      },
      { type: 'text', text: 'File: notes.txt\nContent:\nhello text' },
      { type: 'image', mimeType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') },
    ]);
  });

  it('sends only images by default', async () => {
    const requests = scriptModel('Model', ['read']);
    await runSetup({}, input({ pdf, txt, png }));
    const content = requests[0].messages.at(-1)!.content as unknown as Array<Record<string, unknown>>;
    expect(content.map((p) => p.type)).toEqual(['text', 'image']);
  });

  it('sends no image when image passthrough is off', async () => {
    const requests = scriptModel('Model', ['read']);
    await runSetup({ agent: { options: { passthroughBinaryImages: false } } }, input({ pdf, txt, png }));
    expect(requests[0].messages.at(-1)!.content).toBe('Read these');
  });

  it('refuses a file over the instance cap before any model request', async () => {
    const requests = scriptModel('Model', ['never']);
    const big = bin(Buffer.alloc(3 * 1024 * 1024, 1), 'application/pdf', 'big.pdf');
    const r = await runSetup({ agent: { options: { passthroughBinaryPdfs: true } } }, input({ big }), {
      services: services({ nodeLimits: { maxPassthroughBinaryBytes: 2 * 1024 * 1024 } }),
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe(
      'The file "big.pdf" is 3 MB, which exceeds the 2 MB limit for passing binary data to the model',
    );
    expect(requests).toHaveLength(0);
    expect(modelRequests.get('Model')).toEqual([]);
  });

  it('refuses images over the cap too, and files that together pass it', async () => {
    const requests = scriptModel('Model', ['never']);
    const limits = services({ nodeLimits: { maxPassthroughBinaryBytes: 1024 } });
    const image = bin(Buffer.alloc(2048, 1), 'image/png', 'huge.png');
    const r1 = await runSetup({}, input({ image }), { services: limits });
    expect(r1.error?.message).toContain('The file "huge.png" is 0 MB');
    const a = bin(Buffer.alloc(700, 1), 'application/pdf', 'a.pdf');
    const b = bin(Buffer.alloc(700, 1), 'application/pdf', 'b.pdf');
    const r2 = await runSetup({ agent: { options: { passthroughBinaryPdfs: true } } }, input({ a, b }), {
      services: limits,
    });
    expect(r2.status).toBe('error');
    expect(r2.error?.message).toContain('exceeds the 0 MB limit for passing binary data to the model');
    expect(requests).toHaveLength(0);
  });
});

describe('Agent parity: model kinds and versions', () => {
  it('gives a clear error for a completion model', async () => {
    let calls = 0;
    const completionModel: NodeType = {
      description: {
        name: 'test.completionModel',
        displayName: 'Completion Model',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Completion' },
        inputs: [],
        outputs: ['ai_languageModel'],
        properties: [],
      },
      async supplyData(ctx) {
        return {
          response: {
            kind: 'chatModel',
            provider: 'fake',
            model: 'completion-1',
            completion: true,
            nodeName: ctx.getNode().name,
            chat: async () => {
              calls++;
              throw new Error('must not be called');
            },
          },
        };
      },
    };
    const types = new NodeTypes([...nodes, ...testNodes, completionModel]);
    const r = await run(
      [node('Chat', 'ai.chatTrigger'), node('Agent', 'ai.agent'), node('Completion', 'test.completionModel')],
      connect(['Chat', 'Agent'], ['Completion', 'Agent', 'ai_languageModel']),
      { triggerItems: chat('Hi'), nodeTypes: types },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Completion is a text completion model; connect a chat model');
    expect(calls).toBe(0);
  });

  const inputsOf = (version: number, parameters: DataObject) => {
    const description = AgentNode.description;
    const resolved = resolveNodeParameters(description.properties, parameters, { nodeVersion: version });
    return resolvePorts(
      description.inputs,
      { ...node('Agent', 'ai.agent'), typeVersion: version, parameters: resolved },
      evaluatePortExpression,
    ).map((p) => (typeof p === 'string' ? p : p.type));
  };

  it('keeps the output parser port on version 1 and starts without it on version 2', () => {
    expect(inputsOf(1, {})).toContain('ai_outputParser');
    expect(inputsOf(2, {})).not.toContain('ai_outputParser');
    expect(inputsOf(2, { hasOutputParser: true })).toContain('ai_outputParser');
  });

  it('adds the second chat model port only with the fallback on, and filters completion models', () => {
    expect(inputsOf(2, {}).filter((t) => t === 'ai_languageModel')).toHaveLength(1);
    expect(inputsOf(2, { needsFallback: true }).filter((t) => t === 'ai_languageModel')).toHaveLength(2);
    const ports = resolvePorts(
      AgentNode.description.inputs,
      {
        ...node('Agent', 'ai.agent'),
        parameters: resolveNodeParameters(
          AgentNode.description.properties,
          { needsFallback: true },
          { nodeVersion: 2 },
        ),
      },
      evaluatePortExpression,
    );
    const models = ports.filter((p) => typeof p !== 'string' && p.type === 'ai_languageModel');
    for (const m of models)
      expect(m).toMatchObject({ filter: { excludedNodes: expect.arrayContaining(['ai.lmOllama']) } });
  });

  it('ignores a connected output parser on version 2 until the option is on', async () => {
    const parser = node('Parser', 'ai.outputParserStructured', { jsonSchemaExample: '{"city": "Rome"}' });
    const links: Setup['links'] = [['Parser', 'Agent', 'ai_outputParser']];
    const v2 = scriptModel('Model', ['{"city": "Paris"}']);
    const off = await runSetup({ extraNodes: [parser], links });
    expect(off.output('Agent')).toEqual([{ output: '{"city": "Paris"}' }]);
    expect(String(v2[0].messages[0]?.content)).not.toContain('JSON schema');

    scriptModel('Model', ['{"city": "Paris"}']);
    const on = await runSetup({ agent: { hasOutputParser: true }, extraNodes: [parser], links });
    expect(on.output('Agent')).toEqual([{ output: { city: 'Paris' } }]);

    scriptModel('Model', ['{"city": "Paris"}']);
    const v1 = await runSetup({ version: 1, extraNodes: [parser], links });
    expect(v1.output('Agent')).toEqual([{ output: { city: 'Paris' } }]);
  });
});

describe('Agent parity: metadata, saved output and hints', () => {
  async function runCaptured(setup: Setup, items: Item[] = chat('Hi')) {
    let customData: Record<string, string> | undefined;
    const r = await runSetup(setup, items, {
      services: services({
        hooks: {
          workflowExecuteAfter: (result: ExecutionResult) => {
            customData = result.state.resultData.customData as Record<string, string> | undefined;
          },
        },
      }),
    });
    return { r, customData };
  }

  it('puts the tracing metadata on the task', async () => {
    scriptModel('Model', ['ok']);
    const r = await runSetup({
      agent: {
        options: {
          tracingMetadata: {
            values: [
              { key: 'team', type: 'string', value: 'support' },
              { key: 'priority', type: 'number', value: '3' },
              { key: 'beta', type: 'boolean', value: 'true' },
              { key: '', type: 'string', value: 'dropped' },
            ],
          },
        },
      },
    });
    expect(r.runData.Agent[0].metadata).toMatchObject({
      tracing: { team: 'support', priority: 3, beta: true },
    });
  });

  it('saves a text answer for the execution filters', async () => {
    scriptModel('Model', ['saved answer']);
    const { customData } = await runCaptured({});
    expect(customData?.[highlightedResponseKey('Agent')]).toBe('saved answer');
  });

  it('saves nothing when the option is off', async () => {
    scriptModel('Model', ['saved answer']);
    const { customData } = await runCaptured({ agent: { options: { autoSaveHighlightedData: false } } });
    expect(customData?.[highlightedResponseKey('Agent')]).toBeUndefined();
  });

  it('saves nothing for a parser output, which is an object', async () => {
    scriptModel('Model', ['{"city": "Paris"}']);
    const { r, customData } = await runCaptured({
      agent: { hasOutputParser: true },
      extraNodes: [node('Parser', 'ai.outputParserStructured', { jsonSchemaExample: '{"city": "Rome"}' })],
      links: [['Parser', 'Agent', 'ai_outputParser']],
    });
    expect(r.output('Agent')).toEqual([{ output: { city: 'Paris' } }]);
    expect(customData?.[highlightedResponseKey('Agent')]).toBeUndefined();
  });

  it('saves only the first item output', async () => {
    scriptModel('Model', ['first', 'second']);
    const { customData } = await runCaptured({}, [...chat('a'), ...chat('b')]);
    expect(customData?.[highlightedResponseKey('Agent')]).toBe('first');
  });

  it('hints that streaming is on while the Chat Trigger does not stream', async () => {
    scriptModel('Model', ['ok']);
    const r = await runSetup({});
    expect(r.runData.Agent[0].hints?.[0].message).toContain('Streaming is on');
  });

  it('gives no streaming hint for a streaming trigger or with streaming off', async () => {
    scriptModel('Model', ['ok']);
    const streaming = await runSetup({ trigger: { options: { responseMode: 'streaming' } } });
    expect(streaming.runData.Agent[0].hints).toBeUndefined();
    scriptModel('Model', ['ok']);
    const off = await runSetup({ agent: { options: { enableStreaming: false } } });
    expect(off.runData.Agent[0].hints).toBeUndefined();
  });
});

describe('Agent parity: n8n texts', () => {
  it('says No prompt specified for an empty prompt', async () => {
    scriptModel('Model', ['x']);
    const auto = await runSetup({}, [{ json: { sessionId: 's1' } }]);
    expect(auto.error?.message).toBe(TEXT);
    const define = await runSetup({ agent: { promptType: 'define', text: '   ' } });
    expect(define.error?.message).toBe(TEXT);
  });

  it('uses You are a helpful assistant as the default system message', async () => {
    const requests = scriptModel('Model', ['x']);
    await runSetup({});
    expect(requests[0].messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' });
  });

  it('says Max iterations reached when the agent runs out of steps', async () => {
    scriptModel('Model', () => toolCalls(['Think', { thought: 'again' }]));
    const r = await runSetup({
      agent: { options: { maxIterations: 2 } },
      extraNodes: [node('Think', 'ai.toolThink')],
      links: [['Think', 'Agent', 'ai_tool']],
    });
    expect(r.error?.message).toBe(
      'Max iterations (2) reached. The agent could not complete the task within the allowed number of iterations.',
    );
  });
});
