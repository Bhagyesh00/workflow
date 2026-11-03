/**
 * Generic OAuth1 credential.
 *
 * STUB from the Phase 2 contract step (C0a); lane L8 writes the fields, the token data and the
 * `authenticate` function (signOAuth1Request).
 */
import type { CredentialType } from '@workflow/workflow';

export const oAuth1Api: CredentialType = {
  name: 'oAuth1Api',
  displayName: 'OAuth1 API',
  icon: 'lucide:key-round',
  properties: [
    { displayName: 'Consumer Key', name: 'consumerKey', type: 'string', default: '', required: true },
    {
      displayName: 'Consumer Secret',
      name: 'consumerSecret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    { displayName: 'Request Token URL', name: 'requestTokenUrl', type: 'string', default: '' },
    { displayName: 'Authorization URL', name: 'authUrl', type: 'string', default: '' },
    { displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'string', default: '' },
  ],
};
