/** TOTP credential: the base32 secret of an authenticator and an optional issuer:username label. */
import type { CredentialType } from '@workflow/workflow';

export const totpApi: CredentialType = {
  name: 'totpApi',
  displayName: 'TOTP',
  icon: 'lucide:timer',
  properties: [
    {
      displayName: 'Secret',
      name: 'secret',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      placeholder: 'BVDRSBXQB2ZEL5HE',
      description: 'The base32 secret shown when you set up two-factor authentication',
    },
    {
      displayName: 'Label',
      name: 'label',
      type: 'string',
      default: '',
      placeholder: 'GitHub:john-doe',
      description: 'Optional, written as issuer:username. It does not change the code.',
    },
  ],
};
