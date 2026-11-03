/**
 * Digest Auth credential.
 *
 * STUB from the Phase 2 contract step (C0a); lane L6 writes `authenticate` (auth scheme `digest`).
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
};
