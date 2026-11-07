/**
 * Databricks AI Agent (P5-37): the Agent with one MLflow trace per item, off by default. The workspace and
 * the signed storage host are FakeHttpClient fixtures written from the MLflow REST docs; no real host.
 */
import { NodeTypes } from '@workflow/core';
import type { AiTool, DataObject, HttpRequestOptions, Logger, NodeType } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentProperties } from '../src/nodes/agent/Agent.node';
import { DatabricksAiAgentNode } from '../src/nodes/vendors/databricks/DatabricksAiAgent.node';
import { buildSpans, readExperiment } from '../src/nodes/vendors/databricks/mlflow';
import {
  connect,
  type FakeHandler,
  FakeHttpClient,
  node,
  run,
  scriptModel,
  services,
  toolCalls,
  toolNodeTypes,
} from './harness';

const HOST = 'https://dbx.example.com';
const STORE = 'https://store.example.com';
const TOKEN = 'dapi-token-0123456789abcdef';
const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const CREDS = { host: HOST, grantType: 'clientCredentials', clientId: 'sp-1', clientSecret: 'shh-secret' };

const toolNode: NodeType = {
  description: {
    name: 'test.dbxLookup',
    displayName: 'Lookup',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Lookup' },
    inputs: [],
    outputs: ['ai_tool'],
    properties: [],
  },
  async supplyData() {
    const tool: AiTool = {
      kind: 'tool',
      name: 'lookup',
      description: 'Looks a value up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      invoke: async () => `the key is ${SECRET}`,
    };
    return { response: tool };
  },
};
const types = new NodeTypes([...toolNodeTypes.list(), toolNode]);

interface Fixture {
  signedUri?: string;
  existingExperiment?: boolean;
  failTraces?: boolean;
}

function workspace(fixture: Fixture = {}): FakeHandler {
  let traces = 0;
  return (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/oidc/v1/token')
      return { body: { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 } };
    if (path === '/api/2.0/mlflow/experiments/get-by-name') {
      return fixture.existingExperiment
        ? { body: { experiment: { experiment_id: '77', name: 'x' } } }
        : { status: 404, body: { error_code: 'RESOURCE_DOES_NOT_EXIST' } };
    }
    if (path === '/api/2.0/mlflow/experiments/create') return { body: { experiment_id: '42' } };
    if (path === '/api/3.0/mlflow/traces') {
      if (fixture.failTraces) return { status: 500, body: { error_code: 'INTERNAL_ERROR' } };
      traces += 1;
      return { body: { trace: { trace_info: { trace_id: `tr-${traces}` } } } };
    }
    if (/\/credentials-for-data-upload$/.test(path)) {
      return {
        body: {
          credential_info: {
            type: 'AZURE_ADLS_GEN2_SAS',
            signed_uri: fixture.signedUri ?? `${STORE}/blob/${path.split('/')[5]}?sig=abc`,
            headers: [{ name: 'x-ms-blob-type', value: 'BlockBlob' }],
          },
        },
      };
    }
    if (url.origin === STORE) return { status: 201, body: '' };
    throw new Error(`Unexpected request ${request.method ?? 'GET'} ${request.url}`);
  };
}

function warnings(): { logger: Logger; messages: Array<{ message: string; meta?: DataObject }> } {
  const messages: Array<{ message: string; meta?: DataObject }> = [];
  const noop = () => {};
  return {
    messages,
    logger: {
      debug: noop,
      info: noop,
      error: noop,
      warn: (message, meta) => messages.push({ message, meta }),
    } as Logger,
  };
}

async function agent(
  params: DataObject,
  options: {
    fixture?: Fixture;
    handler?: FakeHandler;
    questions?: string[];
    credential?: boolean;
    tool?: boolean;
    logger?: Logger;
  } = {},
) {
  const fake = new FakeHttpClient(options.handler ?? workspace(options.fixture));
  const links: Array<[string, string, ('ai_languageModel' | 'ai_tool')?]> = [
    ['Trigger', 'Agent'],
    ['Model', 'Agent', 'ai_languageModel'],
  ];
  if (options.tool) links.push(['Tool', 'Agent', 'ai_tool']);
  const result = await run(
    [
      node('Trigger', 'test.trigger'),
      node(
        'Agent',
        'ai.databricksAiAgent',
        { promptType: 'define', text: '={{ $json.q }}', ...params },
        options.credential === false ? {} : { credentials: { databricksOAuth2Api: { id: 'c', name: 'c' } } },
      ),
      node('Model', 'test.fakeChatModel'),
      ...(options.tool ? [node('Tool', 'test.dbxLookup')] : []),
    ],
    connect(...links),
    {
      nodeTypes: types,
      triggerItems: (options.questions ?? ['hello']).map((q) => ({ json: { q } })),
      services: services({
        nodeTypes: types,
        creds: { databricksOAuth2Api: CREDS },
        http: fake,
        ...(options.logger ? { logger: options.logger } : {}),
      }),
    },
  );
  const at = (path: string) => fake.requests.filter((r) => new URL(r.url).pathname === path);
  const uploads = fake.requests.filter((r) => new URL(r.url).origin === STORE);
  return { result, fake, at, uploads };
}

beforeEach(() => {
  scriptModel('Model', ['first answer', 'second answer']);
});

describe('Databricks AI Agent', () => {
  it('takes the Agent properties and inputs, with the parser switch always shown', () => {
    const d = DatabricksAiAgentNode.description;
    const names = d.properties.map((p) => p.name);
    for (const p of agentProperties) expect(names).toContain(p.name);
    expect(names).toContain('exportTraces');
    expect(names).toContain('experiment');
    expect(d.properties.find((p) => p.name === 'exportTraces')?.default).toBe(false);
    expect(d.properties.find((p) => p.name === 'hasOutputParser')?.displayOptions).toBeUndefined();
    expect(d.usableAsTool).toBeFalsy();
    expect(d.credentials).toEqual([{ name: 'databricksOAuth2Api', required: false }]);
  });

  it('exports one trace per item to the workspace and uploads its spans to the signed address', async () => {
    const { result, at, uploads, fake } = await agent({ exportTraces: true }, { questions: ['one', 'two'] });
    expect(result.status).toBe('success');
    expect(result.output('Agent')).toEqual([{ output: 'first answer' }, { output: 'second answer' }]);
    // the experiment is looked up and created once, not per item
    expect(at('/api/2.0/mlflow/experiments/get-by-name')).toHaveLength(1);
    expect(at('/api/2.0/mlflow/experiments/create')).toHaveLength(1);
    expect(at('/api/2.0/mlflow/experiments/create')[0].body).toEqual({
      name: '/Shared/workflow-traces-wf1',
    });
    const traces = at('/api/3.0/mlflow/traces');
    expect(traces).toHaveLength(2);
    const info = (traces[0].body as any).trace.trace_info;
    expect(info.trace_location.mlflow_experiment.experiment_id).toBe('42');
    expect(info.state).toBe('OK');
    expect(info.request_preview).toBe('one');
    expect(info.response_preview).toBe('first answer');
    expect(at('/api/2.0/mlflow/traces/tr-1/credentials-for-data-upload')).toHaveLength(1);
    expect(at('/api/2.0/mlflow/traces/tr-2/credentials-for-data-upload')).toHaveLength(1);
    expect(uploads.map((u) => [u.method, new URL(u.url).pathname])).toEqual([
      ['PUT', '/blob/tr-1'],
      ['PUT', '/blob/tr-2'],
    ]);
    const spans = (uploads[0].body as any).spans;
    expect(spans[0]).toMatchObject({ trace_id: 'tr-1', name: 'Agent' });
    expect(JSON.parse(spans[0].attributes['mlflow.spanInputs'])).toEqual({ input: 'one' });
    // a hanging workspace must not hold a finished item: every export call has a short timeout
    const exportCalls = fake.requests.filter((r) => /mlflow/.test(r.url) || r.method === 'PUT');
    expect(exportCalls.length).toBeGreaterThanOrEqual(8);
    expect(exportCalls.map((r) => r.timeout)).toEqual(exportCalls.map(() => 10_000));
  });

  it('builds a tool span for each step and sends the workspace calls with the token', async () => {
    scriptModel('Model', [toolCalls(['lookup', { q: 'x' }]), 'done']);
    const { result, fake, uploads } = await agent({ exportTraces: true }, { tool: true });
    expect(result.status).toBe('success');
    const spans = (uploads[0].body as any).spans as Array<any>;
    expect(spans.map((s) => s.name)).toEqual(['Agent', 'lookup']);
    expect(spans[1].parent_span_id).toBe(spans[0].span_id);
    expect(JSON.parse(spans[1].attributes['mlflow.spanType'])).toBe('TOOL');
    const workspaceCalls = fake.requests.filter((r) => new URL(r.url).origin === HOST);
    for (const call of workspaceCalls.filter((r) => new URL(r.url).pathname.startsWith('/api/'))) {
      expect(call.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('does not fail the node when an export fails, and logs no user text', async () => {
    const { logger, messages } = warnings();
    const { result, uploads } = await agent(
      { exportTraces: true },
      { fixture: { failTraces: true }, questions: ['my private question'], logger },
    );
    expect(result.status).toBe('success');
    expect(result.output('Agent')).toEqual([{ output: 'first answer' }]);
    expect(uploads).toHaveLength(0);
    expect(messages.map((m) => m.message)).toEqual(['The MLflow trace export failed']);
    expect(JSON.stringify(messages)).not.toContain('my private question');
  });

  it('sends nothing to Databricks when the export is off', async () => {
    const { result, fake } = await agent({});
    expect(result.status).toBe('success');
    expect(result.output('Agent')).toEqual([{ output: 'first answer' }]);
    expect(fake.requests).toHaveLength(0);
  });

  it('redacts a secret in a tool result from the payload', async () => {
    scriptModel('Model', [toolCalls(['lookup', { q: 'x' }]), `final ${SECRET}`]);
    const { result, fake, uploads } = await agent({ exportTraces: true }, { tool: true });
    expect(result.status).toBe('success');
    const sent = JSON.stringify(
      fake.requests.filter((r) => /mlflow/.test(r.url) || r.method === 'PUT').map((r) => r.body),
    );
    expect(sent).not.toContain(SECRET);
    expect(JSON.stringify(uploads[0].body)).toContain('[redacted]');
  });

  it('refuses an http signed address and still succeeds', async () => {
    const { result, uploads, fake } = await agent(
      { exportTraces: true },
      { fixture: { signedUri: 'http://store.example.com/blob/tr-1?sig=abc' } },
    );
    expect(result.status).toBe('success');
    expect(uploads).toHaveLength(0);
    expect(fake.requests.some((r) => r.url.startsWith('http://'))).toBe(false);
  });

  it('never sends the token to the upload host, only the headers the workspace gave', async () => {
    const { uploads } = await agent({ exportTraces: true });
    expect(uploads).toHaveLength(1);
    const upload: HttpRequestOptions = uploads[0];
    expect(upload.headers).toEqual({ 'x-ms-blob-type': 'BlockBlob' });
    expect(upload.followRedirects).toBe(false);
    const text = JSON.stringify(upload);
    expect(text).not.toContain(TOKEN);
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text).not.toContain('n8n_DatabricksNode');
  });

  it('fails with n8n text when the export is on and no credential is selected', async () => {
    const { result, fake } = await agent({ exportTraces: true }, { credential: false });
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('Select a Databricks credential to export traces to MLflow');
    expect(fake.requests).toHaveLength(0);
  });

  it('uses an experiment id without a lookup, and a named existing experiment without creating it', async () => {
    const byId = await agent({
      exportTraces: true,
      experiment: { __rl: true, mode: 'id', value: '555' },
    });
    expect(byId.at('/api/2.0/mlflow/experiments/get-by-name')).toHaveLength(0);
    expect(
      (byId.at('/api/3.0/mlflow/traces')[0].body as any).trace.trace_info.trace_location.mlflow_experiment
        .experiment_id,
    ).toBe('555');
    const byName = await agent(
      { exportTraces: true, experiment: { __rl: true, mode: 'name', value: '/Shared/mine' } },
      { fixture: { existingExperiment: true } },
    );
    expect(byName.at('/api/2.0/mlflow/experiments/get-by-name')[0].qs).toEqual({
      experiment_name: '/Shared/mine',
    });
    expect(byName.at('/api/2.0/mlflow/experiments/create')).toHaveLength(0);
    expect(
      (byName.at('/api/3.0/mlflow/traces')[0].body as any).trace.trace_info.trace_location.mlflow_experiment
        .experiment_id,
    ).toBe('77');
  });

  it('refuses an http workspace host', async () => {
    const fake = new FakeHttpClient(workspace());
    const result = await run(
      [
        node('Trigger', 'test.trigger'),
        node(
          'Agent',
          'ai.databricksAiAgent',
          { promptType: 'define', text: 'hi', exportTraces: true },
          {
            credentials: { databricksOAuth2Api: { id: 'c', name: 'c' } },
          },
        ),
        node('Model', 'test.fakeChatModel'),
      ],
      connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel']),
      {
        nodeTypes: types,
        services: services({
          nodeTypes: types,
          creds: { databricksOAuth2Api: { ...CREDS, host: 'http://dbx.example.com' } },
          http: fake,
        }),
      },
    );
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('must be an https URL');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('mlflow helpers', () => {
  it('reads the experiment locator and falls back to a workflow name', () => {
    expect(readExperiment({ __rl: true, mode: 'id', value: ' 9 ' }, 'w')).toEqual({ mode: 'id', value: '9' });
    expect(readExperiment('/Shared/a', 'w')).toEqual({ mode: 'name', value: '/Shared/a' });
    expect(readExperiment({ mode: 'name', value: '' }, 'w')).toEqual({
      mode: 'name',
      value: '/Shared/workflow-traces-w',
    });
  });

  it('marks a failed item as an error span', () => {
    const spans = buildSpans('t', {
      itemIndex: 0,
      input: 'q',
      startedAt: 1000,
      endedAt: 2000,
      error: new Error('boom'),
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe('STATUS_CODE_ERROR');
    expect(spans[0].start_time_unix_nano).toBe('1000000000');
  });
});
