/**
 * Google Vertex Chat Model sub-node: Gemini models on Google Cloud Vertex AI. The credential is a service
 * account (`googleApi`) or a Vertex AI credential with a project (`googleVertexAiApi`). Projects come from
 * the Cloud Resource Manager; the Vertex AI credential is tested here, as n8n does: a token is minted and
 * the project's locations are listed.
 */
import { createSign } from 'node:crypto';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type {
  CredentialTestContext,
  DataObject,
  ListSearchResult,
  NodeCredentialTestResult,
  NodeType,
} from '@workflow/workflow';
import {
  GOOGLE_API_HOST,
  VERTEX_DEFAULT_SCOPE,
  VERTEX_TOKEN_URL,
} from '../../credentials/google-vertex.credentials';
import { geminiAdapter, vertexHost } from '../../providers/gemini';
import { HttpChatModel, readCommonOptions } from '../../shared/chat-model';
import {
  geminiGenerationOptions,
  readGeminiGeneration,
  readVertexTarget,
  vertexAuthenticationProperty,
  vertexCredentialType,
  vertexProjectProperty,
  vertexRegionOption,
} from './gemini-options';
import { modelDescription } from './model-options';

export const VERTEX_DEFAULT_MODEL = 'gemini-2.5-flash';
const PROJECT_SEARCH_URL = 'https://cloudresourcemanager.googleapis.com/v3/projects:search';
const TEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const NO_PROJECT = 'Select or enter a Google Cloud project ID.';
const CANNOT_CONNECT =
  'Could not connect to Vertex AI. Check the service account details, project ID, and Vertex AI permissions.';

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

/** the JWT bearer assertion of a service account; a key error never quotes the key */
function assertion(email: string, privateKey: string, scopes: string, subject: string): string {
  const seconds = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: email,
      ...(subject ? { sub: subject } : {}),
      scope: scopes,
      aud: VERTEX_TOKEN_URL,
      iat: seconds,
      exp: seconds + 3600,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${head}.${claims}`)
    .sign(privateKey.replace(/\\n/g, '\n').trim());
  return `${head}.${claims}.${b64url(signature)}`;
}

interface TestResponse {
  status: number;
  body: unknown;
}

/**
 * One https request to a Google API host. The host passes the SSRF guard once and the socket takes only
 * the checked addresses (no second lookup); redirects are not followed.
 */
async function guardedRequest(
  ctx: CredentialTestContext,
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
): Promise<TestResponse> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !GOOGLE_API_HOST.test(target.hostname)) {
    throw new Error('Only Google API hosts are called');
  }
  const allowed = await ctx.helpers.resolveAllowedHost(target.hostname);
  const lookup = ((hostname, options, callback) =>
    allowed.lookup(hostname, options as { all?: boolean }, callback as never)) as LookupFunction;
  const agent = new https.Agent({ lookup });
  try {
    return await new Promise<TestResponse>((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: init.method,
          headers: { accept: 'application/json', ...init.headers },
          agent,
          timeout: TEST_TIMEOUT_MS,
          signal: ctx.signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) request.destroy(new Error('The answer is too large'));
            else chunks.push(chunk);
          });
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = text;
            try {
              body = JSON.parse(text);
            } catch {
              // not JSON: the status is what the test reads
            }
            resolve({ status: response.statusCode ?? 0, body });
          });
          response.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('Timed out')));
      request.on('error', reject);
      request.end(init.body);
    });
  } finally {
    agent.destroy();
  }
}

/** mint a token for the credential and list the project's locations */
async function googleVertexAiCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const data = credential.data;
  const project = text(data.projectId);
  if (!project) return { status: 'Error', message: NO_PROJECT };
  try {
    const email = text(data.email);
    const privateKey = typeof data.privateKey === 'string' ? data.privateKey : '';
    if (!email || !privateKey) throw new Error('missing service account');
    const subject = data.inpersonate === true ? text(data.delegatedEmail) : '';
    const scopes = text(data.scopes) || VERTEX_DEFAULT_SCOPE;
    const minted = await guardedRequest(ctx, VERTEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: assertion(email, privateKey, scopes, subject),
      }).toString(),
    });
    const token = (minted.body as { access_token?: unknown } | undefined)?.access_token;
    if (minted.status !== 200 || typeof token !== 'string' || !token) throw new Error('no token');
    const locations = await guardedRequest(
      ctx,
      `${vertexHost('global')}/v1/projects/${encodeURIComponent(project)}/locations?pageSize=1`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    );
    if (locations.status < 200 || locations.status >= 300) throw new Error('locations refused');
    return { status: 'OK', message: 'Connection tested successfully' };
  } catch {
    // the cause is not passed on: it can quote a host answer or key text
    return { status: 'Error', message: CANNOT_CONNECT };
  }
}

export const LmChatGoogleVertexNode: NodeType = {
  description: {
    ...modelDescription(
      {
        name: 'ai.lmChatGoogleVertex',
        displayName: 'Google Vertex Chat Model',
        description: 'Gemini models on Google Cloud Vertex AI',
        icon: 'simple:googlecloud',
        alias: ['vertex', 'google', 'gemini', 'llm'],
        credential: 'googleApi',
        defaultsName: 'Google Vertex Chat Model',
      },
      [
        vertexAuthenticationProperty,
        vertexProjectProperty,
        {
          displayName: 'Model Name',
          name: 'modelName',
          type: 'string',
          default: VERTEX_DEFAULT_MODEL,
          required: true,
          description: 'The Gemini model, for example gemini-2.5-flash or gemini-2.5-pro',
        },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          placeholder: 'Add option',
          options: [vertexRegionOption, ...geminiGenerationOptions()],
        },
      ],
    ),
    credentials: [
      { name: 'googleApi', required: true, displayOptions: { show: { authentication: ['googleApi'] } } },
      {
        name: 'googleVertexAiApi',
        required: true,
        testedBy: 'googleVertexAiCredentialTest',
        displayOptions: { show: { authentication: ['googleVertexAiApi'] } },
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const { credentialType, target } = await readVertexTarget(ctx, itemIndex, options);
    const model = String(ctx.getNodeParameter('modelName', itemIndex, VERTEX_DEFAULT_MODEL)).trim();
    if (!model) throw new Error('Enter the model name');
    const adapter = geminiAdapter({
      host: vertexHost(target.location),
      model,
      vertex: target,
      credentialType,
      ...readGeminiGeneration(options, common),
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
  methods: {
    credentialTest: { googleVertexAiCredentialTest },
    listSearch: {
      async searchProjects(ctx, filter, paginationToken): Promise<ListSearchResult> {
        const credentialType = vertexCredentialType(ctx.getCurrentNodeParameter('authentication'));
        // letters, digits and a few separators: the term is a search phrase, not a query language
        const term = (filter ?? '').replace(/[^A-Za-z0-9 _.-]/g, ' ').trim();
        const response = (await ctx.helpers.httpRequestWithAuthentication(credentialType, {
          url: PROJECT_SEARCH_URL,
          qs: {
            pageSize: 50,
            ...(term ? { query: term } : {}),
            ...(paginationToken ? { pageToken: paginationToken } : {}),
          },
        })) as {
          projects?: Array<{ projectId?: string; displayName?: string; state?: string }>;
          nextPageToken?: string;
        };
        return {
          results: (response.projects ?? [])
            .filter((p) => p.projectId && (!p.state || p.state === 'ACTIVE'))
            .map((p) => ({
              name:
                p.displayName && p.displayName !== p.projectId
                  ? `${p.displayName} (${p.projectId})`
                  : String(p.projectId),
              value: String(p.projectId),
            })),
          paginationToken: response.nextPageToken || undefined,
        };
      },
    },
  },
};
