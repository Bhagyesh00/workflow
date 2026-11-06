/** The IMAP credential, with the field names of n8n. */
import type { CredentialType } from '@workflow/workflow';

export const imap: CredentialType = {
  name: 'imap',
  displayName: 'IMAP',
  // sends no HTTP requests with the credential: no "Allowed HTTP Request Domains" fields
  hideDomainRestrictionFields: true,
  properties: [
    { displayName: 'User', name: 'user', type: 'string', default: '' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    { displayName: 'Host', name: 'host', type: 'string', default: '', placeholder: 'imap.example.com' },
    { displayName: 'Port', name: 'port', type: 'number', default: 993 },
    {
      displayName: 'SSL/TLS',
      name: 'secure',
      type: 'boolean',
      default: true,
      description:
        'Connect over TLS from the start. Turned off, the connection moves to TLS only when the server offers STARTTLS.',
    },
    {
      displayName: 'Allow Self-Signed Certificates',
      name: 'allowUnauthorizedCerts',
      type: 'boolean',
      default: false,
      description: 'Connect even when the server certificate cannot be verified',
    },
  ],
};
