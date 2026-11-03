/**
 * Generic OAuth1 credential (n8n's `oAuth1Api`). The sign-in flow stores the token and its secret in
 * the hidden `oauthTokenData`; requests are signed by `authenticate` (HMAC-SHA1, -SHA256 or -SHA512).
 */
import type { CredentialType, DataObject } from '@workflow/workflow';
import { type OAuth1SignatureMethod, signOAuth1Request } from '../utils/oauth1';

export const oAuth1Api: CredentialType = {
  name: 'oAuth1Api',
  displayName: 'OAuth1 API',
  icon: 'lucide:key-round',
  properties: [
    { displayName: 'Authorization URL', name: 'authUrl', type: 'string', default: '', required: true },
    { displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'string', default: '', required: true },
    {
      displayName: 'Request Token URL',
      name: 'requestTokenUrl',
      type: 'string',
      default: '',
      required: true,
    },
    { displayName: 'Consumer Key', name: 'consumerKey', type: 'string', default: '', required: true },
    {
      displayName: 'Consumer Secret',
      name: 'consumerSecret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    {
      displayName: 'Signature Method',
      name: 'signatureMethod',
      type: 'options',
      default: 'HMAC-SHA1',
      options: [
        { name: 'HMAC-SHA1', value: 'HMAC-SHA1' },
        { name: 'HMAC-SHA256', value: 'HMAC-SHA256' },
        { name: 'HMAC-SHA512', value: 'HMAC-SHA512' },
      ],
    },
    { displayName: 'OAuth Token Data', name: 'oauthTokenData', type: 'hidden', default: {} },
  ],
  authenticate: async (credentials, request) => {
    const token = credentials.oauthTokenData as DataObject | undefined;
    if (!token?.oauth_token) {
      throw new Error('The OAuth1 credential is not connected. Open it and connect the account.');
    }
    return signOAuth1Request(request, {
      consumerKey: String(credentials.consumerKey ?? ''),
      consumerSecret: String(credentials.consumerSecret ?? ''),
      token: String(token.oauth_token),
      tokenSecret: String(token.oauth_token_secret ?? ''),
      signatureMethod: (credentials.signatureMethod as OAuth1SignatureMethod | undefined) ?? 'HMAC-SHA1',
    });
  },
};
