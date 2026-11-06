/** The AMQP 1.0 credential, with the field names of n8n and an optional CA for TLS. */
import type { CredentialType } from '@workflow/workflow';

export const amqp: CredentialType = {
  name: 'amqp',
  displayName: 'AMQP',
  // sends no HTTP requests with the credential: no "Allowed HTTP Request Domains" fields
  hideDomainRestrictionFields: true,
  properties: [
    { displayName: 'Hostname', name: 'hostname', type: 'string', default: 'localhost' },
    { displayName: 'Port', name: 'port', type: 'number', default: 5672 },
    { displayName: 'User', name: 'username', type: 'string', default: '' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    {
      displayName: 'Transport Type',
      name: 'transportType',
      type: 'options',
      default: 'tcp',
      description:
        'Whether the connection is plain (TCP) or encrypted (TLS). An encrypted connection verifies the broker certificate.',
      options: [
        { name: 'TCP', value: 'tcp' },
        { name: 'TLS', value: 'tls' },
      ],
    },
    {
      displayName: 'CA Certificate',
      name: 'ca',
      type: 'string',
      default: '',
      typeOptions: { rows: 4, password: true },
      displayOptions: { show: { transportType: ['tls'] } },
      description: 'PEM certificate of the authority that signed the broker certificate',
    },
  ],
};
