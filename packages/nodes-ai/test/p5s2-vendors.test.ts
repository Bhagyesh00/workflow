/**
 * Phase 5 S2 C0f contracts: the vendor node registry, the chat model on a root node's context, the
 * agent's per-item observer, the Databricks https host and the Qwen Cloud workspace header. These hold
 * after the lanes fill the stubs, so nothing here calls a stub.
 */
import { applyAuthentication, NodeTypes, silentLogger } from '@workflow/core';
import type { AiChatResponse, DataObject, HttpRequestOptions, Logger, NodeType } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { alibabaCloudApi } from '../src/credentials/models.credentials';
import {
  type AgentItemEvent,
  AgentNode,
  agentInputs,
  agentProperties,
  executeAgent,
} from '../src/nodes/agent/Agent.node';
import { AgentToolNode } from '../src/nodes/agent/AgentTool.node';
import { DatabricksAiAgentNode } from '../src/nodes/vendors/databricks/DatabricksAiAgent.node';
import { vendorNodes } from '../src/nodes/vendors/index';
import { type ChatAdapter, HttpChatModel } from '../src/shared/chat-model';
import { databricksGatewayUrl, databricksHttpsHost } from '../src/shared/databricks';
import {
  connect,
  FakeHttpClient,
  modelRequests,
  node,
  run,
  scriptModel,
  sequence,
  services,
  testNodes,
} from './harness';

const VENDORS: Array<[name: string, credential: string, usableAsTool: boolean]> = [
  ['ai.openAi', 'openAiApi', false],
  ['ai.anthropic', 'anthropicApi', true],
  ['ai.googleGemini', 'googleGeminiApi', true],
  ['ai.ollama', 'ollamaApi', true],
  ['ai.moonshot', 'moonshotApi', true],
  ['ai.alibabaCloud', 'alibabaCloudApi', true],
  ['ai.minimax', 'minimaxApi', true],
  ['ai.databricksAiAgent', 'databricksOAuth2Api', false],
];

describe('vendor nodes', () => {
  it('registers the eight vendor nodes once, with their credential, icon and categories', () => {
    expect(vendorNodes.map((n) => n.description.name)).toEqual(VENDORS.map(([name]) => name));
    for (const [name, credential] of VENDORS) {
      const d = vendorNodes.find((n) => n.description.name === name)!.description;
      expect(d.categories, name).toEqual(['AI', 'Vendors']);
      expect(d.icon, name).toMatch(/^simple:[a-z0-9-]+$/);
      expect(d.credentials?.map((c) => c.name), name).toEqual([credential]);
      expect(d.outputs, name).toEqual(['main']);
    }
    expect(vendorNodes.every((n) => typeof n.execute === 'function')).toBe(true);
    expect(vendorNodes.find((n) => n.description.name === 'ai.alibabaCloud')?.description.displayName).toBe(
      'Qwen Cloud',
    );
  });

  it('marks usableAsTool as n8n does: not on OpenAI and Databricks', () => {
    for (const [name, , usable] of VENDORS) {
      const d = vendorNodes.find((n) => n.description.name === name)!.description;
      expect(Boolean(d.usableAsTool), name).toBe(usable);
    }
  });

  it('every vendor node but Databricks has a resource and operation shell', () => {
    for (const type of vendorNodes) {
      const d = type.description;
      if (d.name === 'ai.databricksAiAgent') continue;
      const resource = d.properties.find((p) => p.name === 'resource');
      expect(resource?.options?.length, d.name).toBeGreaterThan(0);
      for (const option of resource?.options ?? []) {
        if (!('value' in option)) continue;
        const operation = d.properties.find(
          (p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes(option.value),
        );
        expect(operation?.options?.length, `${d.name} ${String(option.value)}`).toBeGreaterThan(0);
      }
    }
  });

  it('the Databricks AI Agent takes the Agent inputs and properties', () => {
    expect(DatabricksAiAgentNode.description.inputs).toBe(agentInputs);
    expect(AgentNode.description.inputs).toBe(agentInputs);
    expect(typeof agentInputs).toBe('string');
    expect(agentInputs).toContain('ai_languageModel');
    expect(agentInputs).toContain('needsFallback');
    expect(agentInputs).toContain('hasOutputParser');
    for (const property of agentProperties) {
      expect(DatabricksAiAgentNode.description.properties.map((p) => p.name)).toContain(property.name);
    }
    // the engine calls execute(ctx) with one argument; the tool node keeps executeAgent as it is
    expect(AgentToolNode.execute).toBe(executeAgent);
  });
});

// ---------------------------------------------------------------------------------------------
// HttpChatModel on a root node's ExecuteContext
// ---------------------------------------------------------------------------------------------

const probeAdapter: ChatAdapter = {
  provider: 'probe',
  model: 'probe-1',
  credentialType: 'openAiApi',
  capabilities: { structuredOutput: false, structuredOutputWithTools: false },
  buildRequest: (): HttpRequestOptions => ({
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    body: { probe: true },
  }),
  parseResponse: (body): AiChatResponse => ({
    message: { role: 'assistant', content: String((body as DataObject).text) },
  }),
};

const chatProbeNode: NodeType = {
  description: {
    name: 'test.chatProbe',
    displayName: 'Chat Probe',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Probe' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'openAiApi', required: true }],
    properties: [],
  },
  async execute(ctx) {
    // a root node's context fits the host type with no cast
    const model = new HttpChatModel(ctx, probeAdapter, { itemIndex: 0, maxRetries: 0 });
    const response = await model.chat({ messages: [{ role: 'user', content: 'ping' }] });
    return [[{ json: { text: response.message.content as string, nodeName: model.nodeName ?? '' } }]];
  },
};

describe('HttpChatModel on an ExecuteContext', () => {
  it('sends the request with the credential and logs no sub-node run', async () => {
    const types = new NodeTypes([...nodes, ...testNodes, chatProbeNode]);
    const http = new FakeHttpClient(sequence({ body: { text: 'pong' } }));
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Probe', 'test.chatProbe', {}, { credentials: { openAiApi: { id: 'c', name: 'c' } } }),
      ],
      connect(['Trigger', 'Probe']),
      {
        nodeTypes: types,
        services: services({ nodeTypes: types, http, creds: { openAiApi: { apiKey: 'sk-probe-key' } } }),
      },
    );
    expect(r.status).toBe('success');
    expect(r.output('Probe')).toEqual([{ text: 'pong', nodeName: 'Probe' }]);
    expect(http.requests).toHaveLength(1);
    const headers = Object.fromEntries(
      Object.entries(http.requests[0].headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(headers.authorization).toBe('Bearer sk-probe-key');
    // only the two nodes ran; a sub-node log would add an entry under its own name
    expect(Object.keys(r.runData).sort()).toEqual(['Probe', 'Trigger']);
    expect(r.runData.Probe).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// executeAgent observer
// ---------------------------------------------------------------------------------------------

let observer: ((event: AgentItemEvent) => void | Promise<void>) | undefined;

const observedAgentNode: NodeType = {
  description: {
    name: 'test.observedAgent',
    displayName: 'Observed Agent',
    description: '',
    group: ['transform'],
    version: [1, 2],
    defaults: { name: 'Agent' },
    inputs: agentInputs,
    outputs: ['main'],
    properties: agentProperties,
  },
  execute: (ctx) => executeAgent(ctx, observer),
};

const observedTypes = new NodeTypes([...nodes, ...testNodes, observedAgentNode]);

function warnings(): { logger: Logger; messages: Array<{ message: string; meta?: DataObject }> } {
  const messages: Array<{ message: string; meta?: DataObject }> = [];
  return {
    messages,
    logger: { ...silentLogger, warn: (message, meta) => messages.push({ message, meta }) },
  };
}

async function runObserved(
  items: string[],
  agentParams: DataObject = {},
  extra: Parameters<typeof node>[3] = {},
  logger: Logger = silentLogger,
) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      node(
        'Agent',
        'test.observedAgent',
        { promptType: 'define', text: '={{ $json.q }}', ...agentParams },
        extra,
      ),
      node('Model', 'test.fakeChatModel'),
    ],
    connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel']),
    {
      triggerItems: items.map((q) => ({ json: { q } })),
      nodeTypes: observedTypes,
      services: services({ nodeTypes: observedTypes, logger }),
    },
  );
}

describe('executeAgent observer', () => {
  beforeEach(() => {
    observer = undefined;
    modelRequests.clear();
  });

  it('fires once per item with the prompt, the times and the result', async () => {
    scriptModel('Model', ['first answer', 'second answer']);
    const events: AgentItemEvent[] = [];
    observer = (event) => {
      events.push(event);
    };
    const before = Date.now();
    const r = await runObserved(['one', 'two']);
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'first answer' }, { output: 'second answer' }]);
    expect(events.map((e) => [e.itemIndex, e.input, e.result?.output, e.error])).toEqual([
      [0, 'one', 'first answer', undefined],
      [1, 'two', 'second answer', undefined],
    ]);
    for (const e of events) {
      expect(e.startedAt).toBeGreaterThanOrEqual(before);
      expect(e.endedAt).toBeGreaterThanOrEqual(e.startedAt);
      expect(e.result?.usage.modelCalls).toBe(1);
    }
  });

  it('fires per item in batches too', async () => {
    scriptModel('Model', ['a', 'b', 'c']);
    const seen: number[] = [];
    observer = async (event) => {
      seen.push(event.itemIndex);
    };
    const r = await runObserved(['x', 'y', 'z'], { options: { batching: { batchSize: 2 } } });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toHaveLength(3);
    expect(seen.sort()).toEqual([0, 1, 2]);
  });

  it('a failing observer is logged without user text and does not fail the node', async () => {
    scriptModel('Model', ['secret answer one', 'secret answer two']);
    observer = () => {
      throw new Error('observer broke on secret prompt');
    };
    const { logger, messages } = warnings();
    const r = await runObserved(['secret prompt', 'secret prompt 2'], {}, {}, logger);
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'secret answer one' }, { output: 'secret answer two' }]);
    const observerWarnings = messages.filter((m) => m.message.includes('observer'));
    expect(observerWarnings).toHaveLength(2);
    expect(JSON.stringify(observerWarnings)).not.toContain('secret');
  });

  it('a failed item fires with its error, and continue-on-fail still gives the error item', async () => {
    scriptModel('Model', ['fine']);
    const events: AgentItemEvent[] = [];
    observer = (event) => {
      events.push(event);
    };
    const r = await runObserved(['ok', ''], {}, { onError: 'continueRegularOutput' });
    expect(r.status).toBe('success');
    const out = r.output('Agent');
    expect(out[0]).toEqual({ output: 'fine' });
    expect(typeof out[1].error).toBe('string');
    expect(events).toHaveLength(2);
    expect(events[0].result?.output).toBe('fine');
    expect(events[1].itemIndex).toBe(1);
    expect(events[1].result).toBeUndefined();
    expect(events[1].error).toBeInstanceOf(Error);
  });

  it('without an observer the agent runs as before', async () => {
    scriptModel('Model', ['plain']);
    const r = await runObserved(['hello']);
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'plain' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Databricks host and Qwen Cloud workspace
// ---------------------------------------------------------------------------------------------

describe('databricksHttpsHost', () => {
  it('keeps an https host and cuts the trailing slash', () => {
    expect(databricksHttpsHost('https://adb-1.azuredatabricks.net/')).toBe('https://adb-1.azuredatabricks.net');
    expect(databricksHttpsHost(' https://w.cloud.databricks.com ')).toBe('https://w.cloud.databricks.com');
  });

  it('refuses http and other unsafe forms without repeating the host', () => {
    for (const host of [
      'http://w.cloud.databricks.com',
      'w.cloud.databricks.com',
      'https://user:pass@w.cloud.databricks.com',
      'https://w.cloud.databricks.com?x=1',
      'https://w.cloud.databricks.com#frag',
      '',
    ]) {
      expect(() => databricksHttpsHost(host), host).toThrow(/must be an https URL/);
      try {
        databricksHttpsHost(host);
      } catch (error) {
        if (host) expect((error as Error).message).not.toContain(host);
      }
    }
  });

  it('the gateway URL builds on it, unchanged', () => {
    expect(databricksGatewayUrl('https://w.cloud.databricks.com/')).toBe(
      'https://w.cloud.databricks.com/ai-gateway/openai/v1',
    );
    expect(() => databricksGatewayUrl('http://w.cloud.databricks.com')).toThrow(/must be an https URL/);
  });
});

describe('alibabaCloudApi workspace', () => {
  const request: HttpRequestOptions = {
    url: 'https://dashscope-intl.aliyuncs.com/api/v1/x',
    headers: { a: '1' },
  };

  it('has an optional Workspace ID field that is not a secret', () => {
    const field = alibabaCloudApi.properties.find((p) => p.name === 'workspaceId');
    expect(field?.type).toBe('string');
    expect(field?.default).toBe('');
    expect(field?.required).toBeFalsy();
    expect(field?.typeOptions?.password).toBeFalsy();
  });

  it('sends Bearer and no workspace header when the field is empty', async () => {
    const out = await applyAuthentication(alibabaCloudApi, { apiKey: 'dash-key', workspaceId: '  ' }, request);
    expect(out.headers).toEqual({ a: '1', authorization: 'Bearer dash-key' });
  });

  it('sends the workspace header when the field is set', async () => {
    const out = await applyAuthentication(
      alibabaCloudApi,
      { apiKey: 'dash-key', workspaceId: ' ws-42 ' },
      request,
    );
    expect(out.headers).toEqual({
      a: '1',
      authorization: 'Bearer dash-key',
      'X-DashScope-WorkSpace': 'ws-42',
    });
  });
});
