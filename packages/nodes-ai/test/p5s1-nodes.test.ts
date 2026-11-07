/**
 * Phase 5 S1 C0e: what the lanes build on. Names and registrations of the node and credential types, the
 * real credential code, the ports of the dynamic nodes and the shared test harness. No stub's body.
 */
import { applyAuthentication } from '@workflow/core';
import { credentials as baseCredentials } from '@workflow/nodes-base';
import {
  type CredentialType,
  type DataObject,
  evaluatePortExpression,
  evaluateSimple,
  type NodeInputConfig,
  type NodeType,
  portType,
  resolvePorts,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import {
  batchingOption,
  credentials,
  databricksGatewayUrl,
  nodes,
  redactSecrets,
  runInBatches,
} from '../src';
import { embeddingsNodes, HttpEmbeddings } from '../src/nodes/embeddings/embeddings.nodes';
import { chatModelNodes } from '../src/nodes/models/chat-models.nodes';
import { LmChatAnthropicNode } from '../src/nodes/models/LmChatAnthropic.node';
import { LmChatGoogleGeminiNode } from '../src/nodes/models/LmChatGoogleGemini.node';
import { LmChatOllamaNode } from '../src/nodes/models/LmChatOllama.node';
import { LmChatOpenAiNode } from '../src/nodes/models/LmChatOpenAi.node';
import { LmChatOpenAiCompatibleNode } from '../src/nodes/models/LmChatOpenAiCompatible.node';
import { COMPLETION_MODEL_NODES } from '../src/shared/ai-inputs';
import { HttpEmbeddings as moved } from '../src/shared/http-embeddings';
import {
  connect,
  credentialTypes,
  node,
  nodeTypes,
  run,
  services,
  toolCredentialTypes,
  toolNodeTypes,
} from './harness';

const byName = (name: string): NodeType => {
  const type = nodes.find((n) => n.description.name === name);
  if (!type) throw new Error(`${name} is not registered`);
  return type;
};
const credential = (name: string): CredentialType => {
  const type = credentials.find((c) => c.name === name);
  if (!type) throw new Error(`${name} is not registered`);
  return type;
};
const defaults = (name: string) =>
  Object.fromEntries(credential(name).properties.map((p) => [p.name, p.default])) as DataObject;
const testUrl = (name: string, data: DataObject = defaults(name)) =>
  String(evaluateSimple(String(credential(name).test?.request.url), { $credentials: data }));
const ports = (type: NodeType, side: 'inputs' | 'outputs', parameters: DataObject = {}) =>
  resolvePorts(
    type.description[side],
    { parameters } as unknown as WorkflowNode,
    evaluatePortExpression,
  ) as Array<string | { type: string; displayName?: string; filter?: unknown }>;

const MODELS: Array<[string, string[]]> = [
  ['ai.lmChatAwsBedrock', ['aws', 'awsAssumeRole']],
  ['ai.lmChatAzureOpenAi', ['azureOpenAiApi', 'azureEntraCognitiveServicesOAuth2Api']],
  ['ai.lmChatGoogleVertex', ['googleApi', 'googleVertexAiApi']],
  ['ai.lmChatMistralCloud', ['mistralCloudApi']],
  ['ai.lmChatCohere', ['cohereApi']],
  ['ai.lmCohere', ['cohereApi']],
  ['ai.lmOllama', ['ollamaApi']],
  ['ai.lmLemonade', ['lemonadeApi']],
  ['ai.lmOpenHuggingFaceInference', ['huggingFaceApi']],
  ['ai.lmChatDeepSeek', ['deepSeekApi']],
  ['ai.lmChatXAiGrok', ['xAiApi']],
  ['ai.lmChatOpenRouter', ['openRouterApi']],
  ['ai.lmChatVercelAiGateway', ['vercelAiGatewayApi']],
  ['ai.lmChatNvidia', ['nvidiaApi']],
  ['ai.lmChatMoonshot', ['moonshotApi']],
  ['ai.lmChatMinimax', ['minimaxApi']],
  ['ai.lmChatAlibabaCloud', ['alibabaCloudApi']],
  ['ai.lmChatDatabricks', ['databricksOAuth2Api']],
  ['ai.lmChatLemonade', ['lemonadeApi']],
  ['ai.lmChatGroq', ['groqApi']],
];
const EMBEDDINGS: Array<[string, string[]]> = [
  ['ai.embeddingsAwsBedrock', ['aws', 'awsAssumeRole']],
  ['ai.embeddingsAzureOpenAi', ['azureOpenAiApi', 'azureEntraCognitiveServicesOAuth2Api']],
  ['ai.embeddingsGoogleVertex', ['googleApi', 'googleVertexAiApi']],
  ['ai.embeddingsMistralCloud', ['mistralCloudApi']],
  ['ai.embeddingsCohere', ['cohereApi']],
  ['ai.embeddingsNvidia', ['nvidiaApi']],
  ['ai.embeddingsDatabricks', ['databricksOAuth2Api']],
  ['ai.embeddingsLemonade', ['lemonadeApi']],
  ['ai.embeddingsHuggingFaceInference', ['huggingFaceApi']],
];

describe('node registrations', () => {
  it('the split keeps the five model nodes, each from its own file', () => {
    const split: Array<[string, NodeType]> = [
      ['ai.lmChatOpenAi', LmChatOpenAiNode],
      ['ai.lmChatOpenAiCompatible', LmChatOpenAiCompatibleNode],
      ['ai.lmChatAnthropic', LmChatAnthropicNode],
      ['ai.lmChatGoogleGemini', LmChatGoogleGeminiNode],
      ['ai.lmChatOllama', LmChatOllamaNode],
    ];
    for (const [name, type] of split) {
      expect(type.description.name).toBe(name);
      expect(chatModelNodes).toContain(type);
      expect(byName(name)).toBe(type);
    }
  });

  it.each(MODELS)('%s is a model sub-node on its credentials', (name, creds) => {
    const d = byName(name).description;
    expect(chatModelNodes).toContain(byName(name));
    expect(d.inputs).toEqual([]);
    expect(d.outputs).toEqual(['ai_languageModel']);
    expect(d.categories).toEqual(['AI', 'Language Models']);
    expect(d.credentials?.map((c) => c.name)).toEqual(creds);
  });

  it.each(EMBEDDINGS)('%s is an embeddings sub-node on its credentials', (name, creds) => {
    const d = byName(name).description;
    expect(embeddingsNodes).toContain(byName(name));
    expect(d.inputs).toEqual([]);
    expect(d.outputs).toEqual(['ai_embedding']);
    expect(d.categories).toEqual(['AI', 'Embeddings']);
    expect(d.credentials?.map((c) => c.name)).toEqual(creds);
  });

  it('every completion model named for the chat-only filter is registered', () => {
    for (const name of COMPLETION_MODEL_NODES) expect(byName(name).description.name).toBe(name);
  });

  it('AI Agent Tool has no main input and outputs a tool', () => {
    const d = byName('ai.agentTool').description;
    expect(d.outputs).toEqual(['ai_tool']);
    expect((d.inputs as NodeInputConfig[]).map(portType)).not.toContain('main');
    expect((d.inputs as NodeInputConfig[]).map(portType)).toEqual(
      expect.arrayContaining(['ai_languageModel', 'ai_memory', 'ai_tool', 'ai_outputParser']),
    );
    expect(byName('ai.agentTool').execute).toBeTypeOf('function');
  });

  it('Model Selector has one model input per Number of Inputs, 2 to 10', () => {
    const type = byName('ai.modelSelector');
    expect(type.description.outputs).toEqual(['ai_languageModel']);
    expect(type.supplyData).toBeTypeOf('function');
    expect(ports(type, 'inputs')).toHaveLength(2);
    expect(ports(type, 'inputs', { numberInputs: 5 })).toHaveLength(5);
    expect(ports(type, 'inputs', { numberInputs: 50 })).toHaveLength(10);
    expect(ports(type, 'inputs', { numberInputs: 3 })[2]).toMatchObject({
      type: 'ai_languageModel',
      displayName: 'Model 3',
      required: true,
      maxConnections: 1,
    });
  });

  it('Guardrails asks for a model only when a model check is on, and refuses completion models', () => {
    const type = byName('ai.guardrails');
    expect(ports(type, 'inputs')).toEqual(['main']);
    expect(ports(type, 'inputs', { guardrails: { pii: { value: {} } } })).toEqual(['main']);
    for (const check of ['jailbreak', 'nsfw', 'topicalAlignment', 'custom']) {
      const inputs = ports(type, 'inputs', { guardrails: { [check]: {} } });
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toMatchObject({
        type: 'ai_languageModel',
        required: true,
        maxConnections: 1,
        filter: { excludedNodes: COMPLETION_MODEL_NODES },
      });
    }
    expect(ports(type, 'inputs', { operation: 'sanitize', guardrails: { jailbreak: {} } })).toEqual(['main']);
  });

  it('Guardrails has Pass and Fail outputs when it checks, one output when it sanitizes', () => {
    const type = byName('ai.guardrails');
    expect(ports(type, 'outputs')).toEqual([
      { type: 'main', displayName: 'Pass' },
      { type: 'main', displayName: 'Fail' },
    ]);
    expect(ports(type, 'outputs', { operation: 'sanitize' })).toEqual(['main']);
  });

  it('embeddings.nodes.ts re-exports HttpEmbeddings', () => {
    expect(HttpEmbeddings).toBe(moved);
  });

  it('the package index exports the helpers other packages use', () => {
    expect(redactSecrets).toBeTypeOf('function');
    expect(batchingOption).toBeTypeOf('function');
    expect(runInBatches).toBeTypeOf('function');
    expect(databricksGatewayUrl).toBeTypeOf('function');
  });
});

describe('custom header on OpenAI and Anthropic', () => {
  const headers = async (name: string, data: DataObject) =>
    (await applyAuthentication(credential(name), data, { url: 'https://x.test', headers: { a: '1' } }))
      .headers;
  const key = { openAiApi: { authorization: 'Bearer k' }, anthropicApi: { 'x-api-key': 'k' } };

  it.each(['openAiApi', 'anthropicApi'] as const)('%s sends it only when switched on', async (name) => {
    expect(await headers(name, { apiKey: 'k' })).toEqual({ a: '1', ...key[name] });
    const on = { apiKey: 'k', header: true, headerName: 'X-Team', headerValue: 'blue' };
    expect(await headers(name, on)).toEqual({ a: '1', ...key[name], 'x-team': 'blue' });
    expect(await headers(name, { ...on, header: false })).toEqual({ a: '1', ...key[name] });
    expect(await headers(name, { ...on, headerName: '  ' })).toEqual({ a: '1', ...key[name] });
  });

  it.each(['openAiApi', 'anthropicApi'])('%s masks the value and shows the fields only when on', (name) => {
    const fields = credential(name).properties;
    expect(fields.find((p) => p.name === 'header')).toMatchObject({ type: 'boolean', default: false });
    const value = fields.find((p) => p.name === 'headerValue');
    expect(value?.typeOptions?.password).toBe(true);
    expect(value?.displayOptions).toEqual({ show: { header: [true] } });
    expect(fields.find((p) => p.name === 'headerName')?.displayOptions).toEqual({ show: { header: [true] } });
  });
});

describe('model credentials', () => {
  const TESTS: Array<[string, string]> = [
    ['mistralCloudApi', 'https://api.mistral.ai/v1/models'],
    ['cohereApi', 'https://api.cohere.ai/v1/models'],
    ['deepSeekApi', 'https://api.deepseek.com/models'],
    ['groqApi', 'https://api.groq.com/openai/v1/models'],
    ['xAiApi', 'https://api.x.ai/v1/models'],
    ['openRouterApi', 'https://openrouter.ai/api/v1/key'],
    ['vercelAiGatewayApi', 'https://ai-gateway.vercel.sh/v1/chat/completions'],
    ['nvidiaApi', 'https://integrate.api.nvidia.com/v1/models'],
    ['moonshotApi', 'https://api.moonshot.ai/v1/models'],
    ['minimaxApi', 'https://api.minimax.io/v1/files/list'],
    ['alibabaCloudApi', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models'],
    ['lemonadeApi', 'http://localhost:8000/api/v1/models'],
    ['huggingFaceApi', 'https://huggingface.co/api/whoami-v2'],
  ];

  it.each(TESTS)('%s tests against %s with its defaults', (name, url) => {
    expect(testUrl(name)).toBe(url);
  });

  it.each(TESTS.map(([name]) => name))('%s masks its key', (name) => {
    expect(credential(name).properties.find((p) => p.name === 'apiKey')?.typeOptions?.password).toBe(true);
  });

  it('a region picks the base URL the test request and the node read', () => {
    const regions = (name: string) =>
      credential(name).properties.find((p) => p.displayName === 'Region')?.options as Array<{
        name: string;
        value: string;
      }>;
    const expected: Array<[string, Record<string, string>]> = [
      ['moonshotApi', { China: 'https://api.moonshot.cn/v1/models' }],
      ['minimaxApi', { China: 'https://api.minimaxi.com/v1/files/list' }],
      [
        'alibabaCloudApi',
        {
          'US (Virginia)': 'https://dashscope-us.aliyuncs.com/compatible-mode/v1/models',
          'China (Beijing)': 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
          'Hong Kong (China)': 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1/models',
        },
      ],
    ];
    for (const [name, urls] of expected) {
      for (const [label, url] of Object.entries(urls)) {
        const value = regions(name).find((r) => r.name === label)?.value;
        expect(testUrl(name, { url: value }), label).toBe(url);
      }
    }
  });

  it('Cohere honours a custom URL', () => {
    expect(testUrl('cohereApi', { url: 'https://cohere.internal.test' })).toBe(
      'https://cohere.internal.test/v1/models',
    );
    expect(credential('cohereApi').properties.find((p) => p.name === 'url')?.type).toBe('string');
  });

  it.each(['deepSeekApi', 'xAiApi', 'openRouterApi'])('%s keeps its URL fixed', (name) => {
    expect(credential(name).properties.find((p) => p.name === 'url')?.type).toBe('hidden');
  });

  it('a key is sent as a Bearer token', async () => {
    for (const [name] of TESTS) {
      const out = await applyAuthentication(
        credential(name),
        { apiKey: 'k' },
        { url: 'https://x.test', headers: { a: '1' } },
      );
      expect(out.headers, name).toEqual({ a: '1', authorization: 'Bearer k' });
    }
  });

  it.each(['lemonadeApi', 'nvidiaApi'])('%s sends no header without a key', async (name) => {
    for (const data of [{}, { apiKey: '' }, { apiKey: '   ' }]) {
      const out = await applyAuthentication(credential(name), data, { url: 'https://x.test' });
      expect(out.headers).toBeUndefined();
    }
  });

  it('Vercel tests with the smallest real request', () => {
    expect(credential('vercelAiGatewayApi').test?.request).toMatchObject({
      method: 'POST',
      body: { max_tokens: 1 },
    });
  });

  it('Azure and Vertex credentials exist with no test request', () => {
    for (const name of ['azureOpenAiApi', 'azureEntraCognitiveServicesOAuth2Api', 'googleVertexAiApi'])
      expect(credential(name).test, name).toBeUndefined();
  });
});

describe('tool harness', () => {
  it('toolNodeTypes holds both packages and the test nodes', () => {
    expect(toolNodeTypes.get('ai.agent')).toBeDefined();
    expect(toolNodeTypes.get('core.noOp')).toBeDefined();
    expect(toolNodeTypes.get('test.trigger')).toBeDefined();
    expect(nodeTypes.get('core.noOp')).toBeUndefined();
  });

  it('toolCredentialTypes holds both packages', () => {
    expect(toolCredentialTypes.get('openAiApi')).toBeDefined();
    for (const name of ['aws', 'awsAssumeRole', 'googleApi', 'databricksOAuth2Api', 'httpBasicAuth']) {
      expect(baseCredentials.map((c) => c.name)).toContain(name);
      expect(toolCredentialTypes.get(name), name).toBeDefined();
    }
    expect(credentialTypes.get('aws')).toBeUndefined();
  });

  it('services() uses both registries when nodeTypes is set', () => {
    expect(services().nodeTypes).toBe(nodeTypes);
    expect(services().credentialTypes).toBe(credentialTypes);
    const svc = services({ nodeTypes: toolNodeTypes });
    expect(svc.nodeTypes).toBe(toolNodeTypes);
    expect(svc.credentialTypes).toBe(toolCredentialTypes);
  });

  it('run() takes nodeTypes and runs a node of the other package', async () => {
    const r = await run(
      [node('Trigger', 'test.trigger'), node('NoOp', 'core.noOp')],
      connect(['Trigger', 'NoOp']),
      { triggerItems: [{ json: { a: 1 } }], nodeTypes: toolNodeTypes },
    );
    expect(r.status).toBe('success');
    expect(r.output('NoOp')).toEqual([{ a: 1 }]);
  });
});
