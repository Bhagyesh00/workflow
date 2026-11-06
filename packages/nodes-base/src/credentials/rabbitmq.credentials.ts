/** The RabbitMQ credential, with the field names of n8n. */
import type { CredentialType } from '@workflow/workflow';

export const rabbitmq: CredentialType = {
  name: 'rabbitmq',
  displayName: 'RabbitMQ',
  // sends no HTTP requests with the credential: no "Allowed HTTP Request Domains" fields
  hideDomainRestrictionFields: true,
  properties: [
    { displayName: 'Hostname', name: 'hostname', type: 'string', default: '', placeholder: 'localhost' },
    { displayName: 'Port', name: 'port', type: 'number', default: 5672 },
    { displayName: 'User', name: 'username', type: 'string', default: 'guest' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    { displayName: 'Vhost', name: 'vhost', type: 'string', default: '/' },
    {
      displayName: 'SSL',
      name: 'ssl',
      type: 'boolean',
      default: false,
      description: 'Whether to connect over TLS (amqps)',
    },
    {
      displayName: 'Passwordless',
      name: 'passwordless',
      type: 'boolean',
      default: true,
      displayOptions: { show: { ssl: [true] } },
      description: 'Whether to sign in with the client certificate instead of a password (SASL EXTERNAL)',
    },
    {
      displayName: 'CA Certificates',
      name: 'ca',
      type: 'string',
      default: '',
      typeOptions: { rows: 4, password: true },
      displayOptions: { show: { ssl: [true] } },
      description: 'PEM certificate of the authority that signed the broker certificate',
    },
    {
      displayName: 'Client Certificate',
      name: 'cert',
      type: 'string',
      default: '',
      typeOptions: { rows: 4, password: true },
      displayOptions: { show: { ssl: [true], passwordless: [true] } },
      description: 'PEM client certificate. Needs the Client Key too.',
    },
    {
      displayName: 'Client Key',
      name: 'key',
      type: 'string',
      default: '',
      typeOptions: { rows: 4, password: true },
      displayOptions: { show: { ssl: [true], passwordless: [true] } },
      description: 'PEM private key of the client certificate',
    },
    {
      displayName: 'Passphrase',
      name: 'passphrase',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      displayOptions: { show: { ssl: [true], passwordless: [true] } },
      description: 'Passphrase of the client key, if it has one',
    },
  ],
};
