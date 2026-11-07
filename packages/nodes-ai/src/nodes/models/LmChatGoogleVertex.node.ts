/**
 * Google Vertex Chat Model sub-node: Gemini models on Google Cloud Vertex AI. The credential is a service
 * account (`googleApi`) or a Vertex AI credential with a project (`googleVertexAiApi`). Projects come from
 * the Cloud Resource Manager; the Vertex AI credential is tested here, as n8n does: a token is minted and
 * the project's locations are listed.
 */
import type {
  CredentialTestContext,
  DataObject,
  HttpFullResponse,
  ListSearchResult,
  NodeCredentialTestResult,
  NodeType,
} from '@workflow/workflow';
import { VERTEX_DEFAULT_SCOPE, VERTEX_TOKEN_URL } from '../../credentials/google-vertex.credentials';
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
const NO_PROJECT = 'Select or enter a Google Cloud project ID.';
const CANNOT_CONNECT =
  'Could not connect to Vertex AI. Check the service account details, project ID, and Vertex AI permissions.';

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
    const auth = ctx.helpers.auth;
    if (!email || !privateKey || !auth) throw new Error('missing service account');
    const subject = data.inpersonate === true ? text(data.delegatedEmail) : '';
    // the scope reading of the credential's `authenticate`, so the test asks for what a run asks for
    const scopes = (text(data.scopes) || VERTEX_DEFAULT_SCOPE).split(/[,\s]+/).filter(Boolean);
    const { token } = await auth.jwtBearerToken({
      email,
      privateKey,
      scopes,
      tokenUrl: VERTEX_TOKEN_URL,
      ...(subject ? { subject } : {}),
    });
    const locations = await auth.http<HttpFullResponse>({
      url: `${vertexHost('global')}/v1/projects/${encodeURIComponent(project)}/locations?pageSize=1`,
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      followRedirects: false,
      timeout: TEST_TIMEOUT_MS,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
    if (locations.statusCode < 200 || locations.statusCode >= 300) throw new Error('locations refused');
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
