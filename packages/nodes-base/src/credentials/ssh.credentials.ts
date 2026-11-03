/**
 * SSH credentials (password or private key).
 *
 * STUB from the Phase 2 contract step (C0a); lane L5 writes the fields.
 */
import type { CredentialType } from '@workflow/workflow';

export const sshPassword: CredentialType = {
  name: 'sshPassword',
  displayName: 'SSH Password',
  icon: 'lucide:terminal',
  properties: [
    { displayName: 'Host', name: 'host', type: 'string', default: '', required: true },
    { displayName: 'Port', name: 'port', type: 'number', default: 22 },
    { displayName: 'Username', name: 'username', type: 'string', default: '' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
  ],
};

export const sshPrivateKey: CredentialType = {
  name: 'sshPrivateKey',
  displayName: 'SSH Private Key',
  icon: 'lucide:terminal',
  properties: [
    { displayName: 'Host', name: 'host', type: 'string', default: '', required: true },
    { displayName: 'Port', name: 'port', type: 'number', default: 22 },
    { displayName: 'Username', name: 'username', type: 'string', default: '' },
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      default: '',
      typeOptions: { password: true, rows: 4 },
    },
    {
      displayName: 'Passphrase',
      name: 'passphrase',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
  ],
};
