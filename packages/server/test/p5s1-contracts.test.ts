/**
 * Phase 5 S1 contract step C0f: the `resourceMapping` kind of /rest/node-types/options, tenant scope of
 * `readWorkflow` and `listWorkflows`, the passthrough limit, helpers and the client-credentials branch of
 * the credential test, the new credential types, the filter subpath.
 */
import type { HttpClient } from '@workflow/core';
import { evaluateFilter } from '@workflow/nodes-base/utils/filter';
import type {
  CredentialType,
  DataObject,
  HttpRequestOptions,
  NodePropertyOption,
  NodeType,
  ResourceMapperFields,
} from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { testCredential } from '../src/services/credential-test';
import {
  createTestServer,
  createWorkflow,
  memberAs,
  node,
  resetDatabase,
  signup,
  type TestServer,
} from './helpers';

const fieldsNamed = (names: string[]): ResourceMapperFields => ({
  fields: names.map((name) => ({
    id: name,
    displayName: name,
    required: false,
    defaultMatch: false,
    display: true,
  })),
});

const mapperNode: NodeType = {
  description: {
    name: 'test.p5s1Mapper',
    displayName: 'Mapper',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Mapper' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [{ displayName: 'Target', name: 'targetId', type: 'string', default: '' }],
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
  methods: {
    resourceMapping: {
      async nodesOfTarget(ctx) {
        const target = await ctx.readWorkflow?.(String(ctx.getCurrentNodeParameter('targetId')));
        if (!target) return { fields: [], emptyFieldsNotice: 'No such workflow' };
        return fieldsNamed(target.nodes.map((n) => n.name));
      },
      async allWorkflows(ctx) {
        const page = await ctx.listWorkflows?.({});
        return fieldsNamed((page?.workflows ?? []).map((w) => w.name));
      },
      async passthroughLimit(ctx) {
        return fieldsNamed([String(ctx.helpers.getInstanceLimits().maxPassthroughBinaryBytes)]);
      },
    },
  },
};

const TOKEN_URL = 'https://auth.example.test/token';
const TEST_URL = 'https://api.example.test/me';

const ownToken: Pick<CredentialType, 'extends' | 'properties' | 'authenticate'> = {
  extends: ['oAuth2Api'],
  properties: [{ displayName: 'Token URL', name: 'accessTokenUrl', type: 'hidden', default: TOKEN_URL }],
  authenticate: async (_data, request, helpers) => {
    const body = await helpers?.http<{ access_token: string }>({ url: TOKEN_URL, method: 'POST' });
    return {
      ...request,
      headers: { ...(request.headers ?? {}), authorization: `Own ${body?.access_token}` },
    };
  },
};

const testCredentials: CredentialType[] = [
  {
    ...ownToken,
    name: 'p5s1OwnToken',
    displayName: 'Own token',
    test: { request: { url: TEST_URL, method: 'GET' } },
  },
  { ...ownToken, name: 'p5s1OwnTokenNoTest', displayName: 'Own token, no test' },
];

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer(
    {},
    { nodePackages: [{ name: 'p5s1', nodes: [mapperNode], credentials: testCredentials }] },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

type Client = Awaited<ReturnType<typeof signup>>['client'];

/** P6-27: the body names the project (`workflowId` or `projectId` is required) */
const optionsBody = (client: Client, method: string, parameters: DataObject = {}) => ({
  projectId: client.defaultProjectId,
  nodeType: 'test.p5s1Mapper',
  method,
  kind: 'resourceMapping',
  node: node('Mapper', 'test.p5s1Mapper', parameters),
});

const mapping = (client: Client, method: string, parameters?: DataObject) =>
  client.data<ResourceMapperFields>(
    client.post('/rest/node-types/options', optionsBody(client, method, parameters)),
  );

const ids = (result: ResourceMapperFields) => result.fields.map((f) => f.id);

describe('POST /rest/node-types/options, kind resourceMapping', () => {
  it('calls the named method and answers with its fields', async () => {
    const { client } = await signup(server.app);
    const target = await createWorkflow(client, {
      name: 'Target',
      nodes: [node('Start', 'core.manualTrigger'), node('Next', 'core.noOp', {}, [200, 0])],
    });
    expect(ids(await mapping(client, 'nodesOfTarget', { targetId: target.id })).sort()).toEqual([
      'Next',
      'Start',
    ]);
  });

  it('refuses a method the kind does not have, and inherited names', async () => {
    const { client } = await signup(server.app);
    for (const method of ['missing', 'constructor', '__proto__', 'toString']) {
      const response = await client.post('/rest/node-types/options', optionsBody(client, method));
      expect(response.statusCode, method).toBe(400);
    }
    // a method of another kind
    const other = await client.post('/rest/node-types/options', {
      ...optionsBody(client, 'nodesOfTarget'),
      kind: 'loadOptions',
    });
    expect(other.statusCode).toBe(400);
  });

  it('is closed to a viewer', async () => {
    const owner = await signup(server.app);
    const { client: viewer } = await memberAs(owner, 'viewer', { name: 'Viewer' });
    const response = await viewer.post('/rest/node-types/options', optionsBody(viewer, 'allWorkflows'));
    expect(response.statusCode).toBe(403);
  });
});

describe('tenant scope of the loader context', () => {
  it('readWorkflow gives the tenant its own workflow and nothing of another tenant', async () => {
    const mine = await signup(server.app);
    const theirs = await signup(server.app);
    const own = await createWorkflow(mine.client, {
      name: 'Mine',
      nodes: [node('My start', 'core.manualTrigger')],
    });
    const other = await createWorkflow(theirs.client, {
      name: 'Theirs',
      nodes: [node('Their start', 'core.manualTrigger')],
    });

    expect(ids(await mapping(mine.client, 'nodesOfTarget', { targetId: own.id }))).toEqual(['My start']);
    expect(await mapping(mine.client, 'nodesOfTarget', { targetId: other.id })).toEqual({
      fields: [],
      emptyFieldsNotice: 'No such workflow',
    });
  });

  it('readWorkflow answers undefined for an id that is no uuid', async () => {
    const { client } = await signup(server.app);
    expect((await mapping(client, 'nodesOfTarget', { targetId: 'not-a-uuid' })).emptyFieldsNotice).toBe(
      'No such workflow',
    );
  });

  it('listWorkflows leaves out the workflows of another tenant', async () => {
    const mine = await signup(server.app);
    const theirs = await signup(server.app);
    await createWorkflow(mine.client, { name: 'Mine', nodes: [node('Start', 'core.manualTrigger')] });
    await createWorkflow(theirs.client, { name: 'Theirs', nodes: [node('Start', 'core.manualTrigger')] });

    expect(ids(await mapping(mine.client, 'allWorkflows'))).toEqual(['Mine']);
  });
});

describe('AI_AGENT_MAX_PASSTHROUGH_BINARY_SIZE_BYTES', () => {
  it('defaults to 50 MiB and reads the env variable', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).nodeLimits.maxPassthroughBinaryBytes).toBe(52_428_800);
    expect(
      loadConfig({ NODE_ENV: 'test', AI_AGENT_MAX_PASSTHROUGH_BINARY_SIZE_BYTES: '2048' }).nodeLimits
        .maxPassthroughBinaryBytes,
    ).toBe(2048);
  });

  it('refuses 0', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', AI_AGENT_MAX_PASSTHROUGH_BINARY_SIZE_BYTES: '0' })).toThrow();
  });

  it('reaches a node through getInstanceLimits', async () => {
    const { client } = await signup(server.app);
    expect(ids(await mapping(client, 'passthroughLimit'))).toEqual(['52428800']);
  });
});

describe('testCredential with a type that gets its own token', () => {
  /** answers a token request with a token and everything else with 200 */
  function recordingHttp() {
    const calls: HttpRequestOptions[] = [];
    const http = {
      request: async (options: HttpRequestOptions) => {
        calls.push(options);
        return options.url === TOKEN_URL
          ? { access_token: 'minted' }
          : { statusCode: 200, statusMessage: 'OK', headers: {}, body: {} };
      },
    } as unknown as HttpClient;
    return { calls, http };
  }

  const authorization = (call: HttpRequestOptions | undefined) => call?.headers?.authorization;

  it('client credentials: `authenticate` gets helpers and fetches through them', async () => {
    const { calls, http } = recordingHttp();
    const result = await testCredential(server.ctx.credentials, http, 'p5s1OwnToken', {
      grantType: 'clientCredentials',
      clientId: 'id',
    });
    expect(result.status).toBe('OK');
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, TEST_URL]);
    expect(authorization(calls[1])).toBe('Own minted');
  });

  it('client credentials: the allowed domains hold for the helpers too', async () => {
    const { calls, http } = recordingHttp();
    const result = await testCredential(server.ctx.credentials, http, 'p5s1OwnToken', {
      grantType: 'clientCredentials',
      clientId: 'id',
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'api.example.test',
    });
    expect(result.status).toBe('Error');
    expect(calls).toEqual([]);
  });

  it('another grant on the same type stays on the stored token', async () => {
    const { calls, http } = recordingHttp();
    const result = await testCredential(server.ctx.credentials, http, 'p5s1OwnToken', {
      grantType: 'pkce',
      clientId: 'id',
      oauthTokenData: { access_token: 'stored' },
    });
    expect(result.status).toBe('OK');
    expect(calls.map((c) => c.url)).toEqual([TEST_URL]);
    expect(authorization(calls[0])).toBe('Bearer stored');
  });

  it('with no test request: client credentials has nothing to test, a user grant must be connected', async () => {
    const { calls, http } = recordingHttp();
    expect(
      await testCredential(server.ctx.credentials, http, 'p5s1OwnTokenNoTest', {
        grantType: 'clientCredentials',
      }),
    ).toEqual({ status: 'OK', message: 'This credential type has no connection test' });
    expect(
      await testCredential(server.ctx.credentials, http, 'p5s1OwnTokenNoTest', { grantType: 'pkce' }),
    ).toEqual({ status: 'Error', message: 'The account is not connected yet' });
    expect(calls).toEqual([]);
  });
});

describe('the new credential types', () => {
  const resolved = (name: string) => server.ctx.registries.credentialTypes.getResolved(name);
  const property = (type: string, name: string) => resolved(type)?.properties.find((p) => p.name === name);

  it('databricksOAuth2Api extends OAuth2 with templated URLs on its host', () => {
    expect(server.ctx.registries.credentialTypes.isA('databricksOAuth2Api', 'oAuth2Api')).toBe(true);
    expect(property('databricksOAuth2Api', 'host')).toMatchObject({ type: 'string', required: true });
    expect(property('databricksOAuth2Api', 'authUrl')).toMatchObject({
      type: 'hidden',
      default: '={{$credentials.host}}/oidc/v1/authorize',
    });
    expect(property('databricksOAuth2Api', 'accessTokenUrl')).toMatchObject({
      type: 'hidden',
      default: '={{$credentials.host}}/oidc/v1/token',
    });
    expect(property('databricksOAuth2Api', 'scope')?.default).toBe('all-apis offline_access');
    const grant = property('databricksOAuth2Api', 'grantType');
    expect(grant?.default).toBe('clientCredentials');
    expect(grant?.options?.map((o) => (o as NodePropertyOption).value)).toEqual([
      'clientCredentials',
      'pkce',
    ]);
    expect(typeof resolved('databricksOAuth2Api')?.authenticate).toBe('function');
  });

  it('aws, awsAssumeRole and googleApi hold their fields, secrets marked as passwords', () => {
    for (const name of [
      'region',
      'accessKeyId',
      'temporaryCredentials',
      'customEndpoints',
      'bedrockEndpoint',
    ]) {
      expect(property('aws', name), name).toBeDefined();
    }
    for (const [type, name] of [
      ['aws', 'secretAccessKey'],
      ['aws', 'sessionToken'],
      ['awsAssumeRole', 'stsSecretAccessKey'],
      ['awsAssumeRole', 'stsSessionToken'],
      ['googleApi', 'privateKey'],
    ] as const) {
      expect(property(type, name)?.typeOptions?.password, `${type}.${name}`).toBe(true);
    }
    expect(property('awsAssumeRole', 'externalId')?.required).toBe(true);
    expect(property('awsAssumeRole', 'roleSessionName')?.default).toBe('workflow-session');
    expect(property('awsAssumeRole', 'useSystemCredentialsForRole')).toBeUndefined();
    for (const name of ['email', 'region', 'inpersonate', 'delegatedEmail', 'scopes']) {
      expect(property('googleApi', name), name).toBeDefined();
    }
  });
});

describe('nodes-base subpath', () => {
  it('exports the filter from ./utils/filter', () => {
    expect(typeof evaluateFilter).toBe('function');
  });
});
