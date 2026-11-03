/**
 * TOTP credential.
 *
 * STUB from the Phase 2 contract step (C0a); lane L1 writes the fields.
 */
import type { CredentialType } from '@workflow/workflow';

export const totpApi: CredentialType = {
  name: 'totpApi',
  displayName: 'TOTP',
  icon: 'lucide:timer',
  properties: [
    { displayName: 'Secret', name: 'secret', type: 'string', default: '', typeOptions: { password: true } },
    { displayName: 'Label', name: 'label', type: 'string', default: '', placeholder: 'GitHub:john-doe' },
  ],
};
