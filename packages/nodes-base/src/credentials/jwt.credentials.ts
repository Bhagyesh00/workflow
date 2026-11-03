/**
 * JWT credential.
 *
 * STUB from the Phase 2 contract step (C0a); lane L1 writes the key type, PEM keys and algorithm.
 */
import type { CredentialType } from '@workflow/workflow';

export const jwtAuth: CredentialType = {
  name: 'jwtAuth',
  displayName: 'JWT Auth',
  icon: 'lucide:key-square',
  properties: [
    { displayName: 'Secret', name: 'secret', type: 'string', default: '', typeOptions: { password: true } },
  ],
};
