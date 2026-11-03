/**
 * FTP and SFTP credentials.
 *
 * STUB from the Phase 2 contract step (C0a); lane L5 writes the fields.
 */
import type { CredentialType } from '@workflow/workflow';

export const ftp: CredentialType = {
  name: 'ftp',
  displayName: 'FTP',
  icon: 'lucide:server',
  properties: [
    { displayName: 'Host', name: 'host', type: 'string', default: '', required: true },
    { displayName: 'Port', name: 'port', type: 'number', default: 21 },
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

export const sftp: CredentialType = {
  name: 'sftp',
  displayName: 'SFTP',
  icon: 'lucide:server',
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
