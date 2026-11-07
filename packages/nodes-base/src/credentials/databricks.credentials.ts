/**
 * The Databricks credential every Databricks AI node takes. It holds a host and a grant: client credentials
 * through `authenticate`, or authorization code with PKCE through the server's OAuth2 flow. The host must be https.
 */
import type { CredentialType, HttpRequestOptions, NodeProperty } from '@workflow/workflow';

/** a client-credentials token call takes this scope; `offline_access` belongs to the user grant only */
const CLIENT_SCOPE = 'all-apis';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The workspace origin, https only: the token calls carry the client secret. The message never repeats the
 * host, which may hold a user name or a password.
 */
function databricksHost(value: unknown): string {
  let url: URL;
  try {
    url = new URL(text(value));
  } catch {
    throw new Error('Enter the Databricks host as an https URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('The Databricks host must be an https URL without credentials, query or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const withBearer = (request: HttpRequestOptions, token: string): HttpRequestOptions => ({
  ...request,
  headers: { ...(request.headers ?? {}), authorization: `Bearer ${token}` },
});

function hidden(name: string, value: string): NodeProperty {
  return { displayName: name, name, type: 'hidden', default: value };
}

export const databricksOAuth2Api: CredentialType = {
  name: 'databricksOAuth2Api',
  displayName: 'Databricks OAuth2 API',
  icon: 'simple:databricks',
  extends: ['oAuth2Api'],
  properties: [
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://adb-1234567890123456.7.azuredatabricks.net',
    },
    {
      displayName: 'Grant Type',
      name: 'grantType',
      type: 'options',
      default: 'clientCredentials',
      options: [
        { name: 'Client Credentials (Service Principal)', value: 'clientCredentials' },
        { name: 'Authorization Code with PKCE (User)', value: 'pkce' },
      ],
    },
    hidden('authUrl', '={{$credentials.host}}/oidc/v1/authorize'),
    hidden('accessTokenUrl', '={{$credentials.host}}/oidc/v1/token'),
    hidden('scope', 'all-apis offline_access'),
    hidden('authQueryParameters', ''),
    hidden('authentication', 'header'),
    // the refresh path never reaches `authenticate`: this keeps its token call on https too
    hidden('httpsOnlyTokenUrl', 'true'),
  ],
  // the request that proves the connection: workspace serving endpoints. An http host never gets a URL, so
  // neither the token call nor the stored token of a connected account goes anywhere.
  test: {
    request: {
      url: "={{$credentials.host.startsWith('https://') ? $credentials.host + '/api/2.0/serving-endpoints' : 'refused'}}",
    },
  },
  authenticate: async (credentials, request, helpers) => {
    const host = databricksHost(credentials.host);
    if (credentials.grantType === 'pkce') {
      // the engine sends this grant through the OAuth2 flow; this branch only serves a caller that comes here
      const stored = credentials.oauthTokenData as { access_token?: unknown } | undefined;
      if (typeof stored?.access_token !== 'string' || !stored.access_token) {
        throw new Error('The Databricks account is not connected yet. Connect it first.');
      }
      return withBearer(request, stored.access_token);
    }
    if (!helpers) throw new Error('This credential can only get a token through the workflow engine');
    const clientId = text(credentials.clientId);
    const clientSecret = text(credentials.clientSecret);
    if (!clientId || !clientSecret)
      throw new Error('The Databricks credential needs a client ID and a secret');
    const tokenUrl = `${host}/oidc/v1/token`;
    const token = await helpers.cachedToken(
      clientSecret,
      JSON.stringify({ tokenUrl, subject: clientId, scopes: [CLIENT_SCOPE], resource: '', role: '' }),
      () =>
        helpers.clientCredentialsToken({
          tokenUrl,
          clientId,
          clientSecret,
          scope: CLIENT_SCOPE,
          authentication: 'header',
        }),
    );
    return withBearer(request, token);
  },
};
