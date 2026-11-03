/**
 * Digest Auth credential: the HTTP client answers the server's Digest challenge with one retry.
 */
import type { CredentialType } from '@workflow/workflow';

export const httpDigestAuth: CredentialType = {
  name: 'httpDigestAuth',
  displayName: 'Digest Auth',
  icon: 'lucide:key-round',
  properties: [
    { displayName: 'User', name: 'user', type: 'string', default: '' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
  ],
  authenticate: async (credentials, request) => ({
    ...request,
    auth: {
      username: String(credentials.user ?? ''),
      password: String(credentials.password ?? ''),
      scheme: 'digest',
    },
  }),
};
