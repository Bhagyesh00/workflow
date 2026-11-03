/**
 * FTP and SFTP credentials, as n8n's ftp and sftp. The FTP node connects through the SSRF guard.
 * As in n8n, plain FTP sends the password unencrypted and the SFTP server's host key is not checked.
 */
import type { CredentialType } from '@workflow/workflow';

export const ftp: CredentialType = {
  name: 'ftp',
  displayName: 'FTP',
  icon: 'lucide:server',
  properties: [
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'localhost',
    },
    { displayName: 'Port', name: 'port', type: 'number', default: 21, required: true },
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
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      default: '',
      typeOptions: { password: true, rows: 4 },
      description:
        'A private key in OpenSSH or PEM format for key-based sign-in. When set, it is used instead of the password. A key pasted on one line is repaired.',
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
