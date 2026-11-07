/**
 * The Google service account credential, with the field names of n8n (`inpersonate` is its spelling).
 * `authenticate` puts a cached bearer token on the request. The token URL is fixed, and it must be inside
 * the credential's allowed domains like every other host.
 */
import type { CredentialType } from '@workflow/workflow';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export const googleApi: CredentialType = {
  name: 'googleApi',
  displayName: 'Google Service Account API',
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
    const scopes = text(credentials.scopes)
      .split(/[,\s]+/)
      .filter(Boolean);
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
