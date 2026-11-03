/**
 * SSH credentials (password or private key), as n8n's sshPassword and sshPrivateKey. The SSH node
 * connects through the SSRF guard; the server's host key is not checked (as in n8n).
 */
import type { CredentialType } from '@workflow/workflow';

export const sshPassword: CredentialType = {
  name: 'sshPassword',
  displayName: 'SSH Password',
  icon: 'lucide:terminal',
  properties: [
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'localhost',
    },
    { displayName: 'Port', name: 'port', type: 'number', default: 22, required: true },
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
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'localhost',
    },
    { displayName: 'Port', name: 'port', type: 'number', default: 22, required: true },
    { displayName: 'Username', name: 'username', type: 'string', default: '' },
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true, rows: 4 },
      description: 'The private key in OpenSSH or PEM format. A key pasted on one line is repaired.',
    },
    {
      displayName: 'Passphrase',
      name: 'passphrase',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description: 'Passphrase used to create the key, if no passphrase was used leave empty',
    },
  ],
};
