/** JWT credential: a shared secret or a PEM key pair, and the signing algorithm. */
import type { CredentialType } from '@workflow/workflow';
import { JWT_ALGORITHMS } from '../utils/jwt';

export const jwtAuth: CredentialType = {
  name: 'jwtAuth',
  displayName: 'JWT Auth',
  icon: 'lucide:key-square',
  properties: [
    {
      displayName: 'Key Type',
      name: 'keyType',
      type: 'options',
      default: 'passphrase',
      options: [
        { name: 'Passphrase', value: 'passphrase' },
        { name: 'PEM Key', value: 'pemKey' },
      ],
    },
    {
      displayName: 'Secret',
      name: 'secret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      displayOptions: { show: { keyType: ['passphrase'] } },
    },
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      default: '',
      typeOptions: { password: true, rows: 4 },
      description: 'PEM private key, used to sign (RS, PS and ES algorithms)',
      displayOptions: { show: { keyType: ['pemKey'] } },
    },
    {
      displayName: 'Public Key',
      name: 'publicKey',
      type: 'string',
      default: '',
      typeOptions: { password: true, rows: 4 },
      description: 'PEM public key, used to verify (RS, PS and ES algorithms)',
      displayOptions: { show: { keyType: ['pemKey'] } },
    },
    {
      displayName: 'Algorithm',
      name: 'algorithm',
      type: 'options',
      default: 'HS256',
      options: JWT_ALGORITHMS.map((a) => ({ name: a, value: a })),
    },
  ],
};
