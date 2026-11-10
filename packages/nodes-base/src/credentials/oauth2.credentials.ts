/**
 * OAuth2 credential types. The server runs the authorization flow (state, PKCE, callback) and
 * stores the tokens in the hidden `oauthTokenData`; the engine refreshes them on expiry or 401.
 * Service-specific types extend `oAuth2Api` and pin their URLs and scopes as hidden properties.
 */
import type { CredentialType, NodeProperty } from '@workflow/workflow';

function hidden(name: string, value: string): NodeProperty {
  return { displayName: name, name, type: 'hidden', default: value };
}

export const oAuth2Api: CredentialType = {
  name: 'oAuth2Api',
  displayName: 'OAuth2 API',
  icon: 'lucide:key-square',
  properties: [
    {
      displayName: 'Grant Type',
      name: 'grantType',
      type: 'options',
      default: 'authorizationCode',
      options: [
        { name: 'Authorization Code', value: 'authorizationCode' },
        { name: 'Client Credentials', value: 'clientCredentials' },
        { name: 'PKCE', value: 'pkce', description: 'Authorization code with proof key (public clients)' },
      ],
    },
    {
      displayName: 'Authorization URL',
      name: 'authUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://example.com/oauth/authorize',
      displayOptions: { show: { grantType: ['authorizationCode', 'pkce'] } },
    },
    {
      displayName: 'Access Token URL',
      name: 'accessTokenUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://example.com/oauth/token',
    },
    { displayName: 'Client ID', name: 'clientId', type: 'string', default: '', required: true },
    {
      displayName: 'Client Secret',
      name: 'clientSecret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    {
      displayName: 'Scope',
      name: 'scope',
      type: 'string',
      default: '',
      description: 'Space-separated scopes',
    },
    {
      displayName: 'Auth URI Query Parameters',
      name: 'authQueryParameters',
      type: 'string',
      default: '',
      placeholder: 'access_type=offline&prompt=consent',
      description: 'Extra query parameters for the authorization URL',
      displayOptions: { show: { grantType: ['authorizationCode', 'pkce'] } },
    },
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'header',
      description: 'How the client ID and secret are sent to the token endpoint',
      options: [
        { name: 'Send as Basic Auth Header', value: 'header' },
        { name: 'Send Client Credentials in Body', value: 'body' },
      ],
    },
    {
      displayName: 'Encrypted Tokens (JWE)',
      name: 'jweEnabled',
      type: 'boolean',
      default: false,
      // the generic type only: a service type that extends it does not offer the field
      doNotInherit: true,
      description:
        "The provider sends its tokens encrypted as JWE for this workspace's public key. Give the provider the key URL shown below. A plain token response is refused.",
    },
    { displayName: 'OAuth Token Data', name: 'oauthTokenData', type: 'hidden', default: {} },
  ],
};

export const googleOAuth2Api: CredentialType = {
  name: 'googleOAuth2Api',
  displayName: 'Google OAuth2 API',
  icon: 'simple:google',
  extends: ['oAuth2Api'],
  properties: [
    hidden('grantType', 'authorizationCode'),
    hidden('authUrl', 'https://accounts.google.com/o/oauth2/v2/auth'),
    hidden('accessTokenUrl', 'https://oauth2.googleapis.com/token'),
    // offline access + consent so Google returns a refresh token every time
    hidden('authQueryParameters', 'access_type=offline&prompt=consent'),
    hidden('authentication', 'body'),
    {
      displayName: 'Scope',
      name: 'scope',
      type: 'string',
      default: '',
      description: 'Space-separated Google API scopes',
    },
  ],
};

export const gmailOAuth2: CredentialType = {
  name: 'gmailOAuth2',
  displayName: 'Gmail OAuth2 API',
  icon: 'simple:gmail',
  extends: ['googleOAuth2Api'],
  properties: [
    hidden(
      'scope',
      [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.labels',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/gmail.send',
      ].join(' '),
    ),
  ],
  test: { request: { url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', method: 'GET' } },
};

export const googleSheetsOAuth2Api: CredentialType = {
  name: 'googleSheetsOAuth2Api',
  displayName: 'Google Sheets OAuth2 API',
  icon: 'simple:googlesheets',
  extends: ['googleOAuth2Api'],
  properties: [
    hidden(
      'scope',
      [
        'https://www.googleapis.com/auth/spreadsheets',
        // listing spreadsheets for the picker
        'https://www.googleapis.com/auth/drive.metadata.readonly',
      ].join(' '),
    ),
  ],
  test: {
    request: { url: 'https://www.googleapis.com/drive/v3/about', method: 'GET', qs: { fields: 'user' } },
  },
};

export const slackOAuth2Api: CredentialType = {
  name: 'slackOAuth2Api',
  displayName: 'Slack OAuth2 API',
  icon: 'simple:slack',
  extends: ['oAuth2Api'],
  properties: [
    hidden('grantType', 'authorizationCode'),
    hidden('authUrl', 'https://slack.com/oauth/v2/authorize'),
    hidden('accessTokenUrl', 'https://slack.com/api/oauth.v2.access'),
    hidden(
      'scope',
      [
        'chat:write',
        'channels:read',
        'channels:history',
        'channels:manage',
        'groups:read',
        'groups:history',
        'groups:write',
        'im:read',
        'mpim:read',
        'users:read',
        'reactions:write',
        'files:write',
      ].join(' '),
    ),
    // message search needs a user token
    hidden('authQueryParameters', 'user_scope=search:read'),
    hidden('authentication', 'body'),
  ],
  test: { request: { url: 'https://slack.com/api/auth.test', method: 'POST' } },
};
