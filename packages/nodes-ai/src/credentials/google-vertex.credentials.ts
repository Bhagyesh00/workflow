/**
 * Google Vertex AI credential: a service account plus the project and region the models run in. No `test`
 * request: the Vertex Chat Model node tests it through `methods.credentialTest`, as n8n (it mints a token
 * and lists the project's locations).
 *
 * `authenticate` puts a cached bearer token on the request, and only on a request to a Google API host:
 * the token must not follow a request an author points at another server. The token comes from
 * `oauth2.googleapis.com`, so a credential with allowed domains must list that host too.
 */
import type { CredentialType } from '@workflow/workflow';

export const VERTEX_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const VERTEX_DEFAULT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** hosts that take the token: `googleapis.com` and its sub-domains, over https */
export const GOOGLE_API_HOST = /(^|\.)googleapis\.com$/i;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export const googleVertexAiApi: CredentialType = {
  name: 'googleVertexAiApi',
  displayName: 'Google Vertex AI',
  icon: 'simple:googlecloud',
  properties: [
    {
      displayName: 'Project ID',
      name: 'projectId',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'my-project-123456',
      description: 'The Google Cloud project that runs the models',
    },
    {
      displayName: 'Region',
      name: 'region',
      type: 'string',
      default: 'global',
      placeholder: 'global, eu, us or us-central1',
      description: 'Where the models run. A node can override it.',
    },
    {
      displayName: 'Service Account Email',
      name: 'email',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'name@project.iam.gserviceaccount.com',
    },
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true, rows: 4 },
      description: 'The private_key from the service account key file',
    },
    {
      displayName: 'Impersonate a User',
      name: 'inpersonate',
      type: 'boolean',
      default: false,
    },
    {
      displayName: 'Email',
      name: 'delegatedEmail',
      type: 'string',
      default: '',
      description: 'The user the service account acts for',
      displayOptions: { show: { inpersonate: [true] } },
    },
    {
      displayName: 'Scope(s)',
      name: 'scopes',
      type: 'string',
      default: VERTEX_DEFAULT_SCOPE,
      description: 'Space-separated Google API scopes',
    },
  ],
  authenticate: async (credentials, request, helpers) => {
    if (!helpers) throw new Error('This credential can only get a token through the workflow engine');
    const email = text(credentials.email).trim();
    const privateKey = text(credentials.privateKey);
    const scopes = (text(credentials.scopes).trim() || VERTEX_DEFAULT_SCOPE).split(/[,\s]+/).filter(Boolean);
    if (!email || !privateKey) throw new Error('The Vertex AI credential needs an email and a private key');
    let target: URL | undefined;
    try {
      target = new URL(request.url);
    } catch {
      target = undefined;
    }
    if (target?.protocol !== 'https:' || !GOOGLE_API_HOST.test(target.hostname)) {
      throw new Error('The Vertex AI credential signs only requests to a Google API host over https');
    }
    const subject = credentials.inpersonate === true ? text(credentials.delegatedEmail).trim() : '';
    const token = await helpers.cachedToken(
      privateKey,
      JSON.stringify({
        tokenUrl: VERTEX_TOKEN_URL,
        subject: subject || email,
        scopes,
        resource: '',
        role: '',
      }),
      () =>
        helpers.jwtBearerToken({
          email,
          privateKey,
          scopes,
          tokenUrl: VERTEX_TOKEN_URL,
          ...(subject ? { subject } : {}),
        }),
    );
    const headers = Object.fromEntries(
      Object.entries(request.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'authorization'),
    );
    return { ...request, headers: { ...headers, authorization: `Bearer ${token}` } };
  },
};
