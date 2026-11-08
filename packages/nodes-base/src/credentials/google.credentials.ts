/**
 * The Google service account credential, with the field names of n8n (`inpersonate` is its spelling).
 * `authenticate` puts a cached bearer token on the request. The token URL is fixed, and it must be inside
 * the credential's allowed domains like every other host.
 */
import type { CredentialType } from '@workflow/workflow';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** the Vertex AI hosts and the project list: as in n8n, the Vertex nodes need no scope typed */
const VERTEX_API_HOST =
  /(^|[.-])aiplatform\.((eu|us)\.rep\.)?googleapis\.com$|^cloudresourcemanager\.googleapis\.com$/i;
/** the Sheets API host: as in n8n, a Sheets call with a service account needs no scope typed */
const SHEETS_API_HOST = /^sheets\.googleapis\.com$/i;
/** the scopes n8n's Sheets path asks for, in its order */
const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.metadata',
];

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** the scopes a call to `value` gets when none is typed; none for any other host */
function defaultScopes(value: string): string[] {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return [];
    if (VERTEX_API_HOST.test(url.hostname)) return [CLOUD_PLATFORM_SCOPE];
    if (SHEETS_API_HOST.test(url.hostname)) return SHEETS_SCOPES;
    return [];
  } catch {
    return [];
  }
}

export const googleApi: CredentialType = {
  name: 'googleApi',
  displayName: 'Google Service Account API',
  icon: 'simple:googlecloud',
  properties: [
    {
      displayName: 'Region',
      name: 'region',
      type: 'string',
      default: 'global',
      placeholder: 'us-central1',
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
      default: '',
      description: 'Space-separated Google API scopes',
    },
  ],
  authenticate: async (credentials, request, helpers) => {
    if (!helpers) throw new Error('This credential can only get a token through the workflow engine');
    const email = text(credentials.email);
    const privateKey = text(credentials.privateKey);
    const typed = text(credentials.scopes)
      .split(/[,\s]+/)
      .filter(Boolean);
    const scopes = typed.length ? typed : defaultScopes(request.url);
    if (!email || !privateKey || !scopes.length) {
      throw new Error('The Google credential needs an email, a private key and at least one scope');
    }
    const subject = credentials.inpersonate === true ? text(credentials.delegatedEmail) : '';
    const token = await helpers.cachedToken(
      privateKey,
      JSON.stringify({
        tokenUrl: GOOGLE_TOKEN_URL,
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
          tokenUrl: GOOGLE_TOKEN_URL,
          ...(subject ? { subject } : {}),
        }),
    );
    const headers = Object.fromEntries(
      Object.entries(request.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'authorization'),
    );
    return { ...request, headers: { ...headers, authorization: `Bearer ${token}` } };
  },
};
