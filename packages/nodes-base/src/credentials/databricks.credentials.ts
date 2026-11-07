/**
 * The Databricks credential every Databricks AI node takes. It holds a host and a grant: client credentials
 * through `authenticate`, or authorization code with PKCE through the server's OAuth2 flow. Stub of the
 * shared-contracts step: the properties are final, L19 fills `authenticate` and the https rule.
 */
import type { CredentialType, NodeProperty } from '@workflow/workflow';

function hidden(name: string, value: string): NodeProperty {
  return { displayName: name, name, type: 'hidden', default: value };
}

export const databricksOAuth2Api: CredentialType = {
  name: 'databricksOAuth2Api',
  displayName: 'Databricks OAuth2 API',
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
  ],
  authenticate: async () => {
    throw new Error('not implemented (L19)');
  },
};
