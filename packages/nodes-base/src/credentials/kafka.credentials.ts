/** The Kafka and Schema Registry credentials, with the field names of n8n. */
import type { CredentialType } from '@workflow/workflow';

export const kafka: CredentialType = {
  name: 'kafka',
  displayName: 'Kafka',
  // sends no HTTP requests with the credential: no "Allowed HTTP Request Domains" fields
  hideDomainRestrictionFields: true,
  properties: [
    {
      displayName: 'Client ID',
      name: 'clientId',
      type: 'string',
      default: '',
      placeholder: 'my-app',
    },
    {
      displayName: 'Brokers',
      name: 'brokers',
      type: 'string',
      default: '',
      placeholder: 'kafka1:9092,kafka2:9092',
    },
    { displayName: 'SSL', name: 'ssl', type: 'boolean', default: true },
    {
      displayName: 'CA Certificate',
      name: 'ca',
      type: 'string',
      default: '',
      typeOptions: { rows: 4, password: true },
      displayOptions: { show: { ssl: [true] } },
      description: 'PEM certificate of the authority that signed the broker certificates',
    },
    {
      displayName: 'Client Certificate',
      name: 'cert',
      type: 'string',
      default: '',
      typeOptions: { rows: 4, password: true },
      displayOptions: { show: { ssl: [true] } },
      description: 'PEM client certificate for mTLS. Needs the Client Private Key too.',
    },
    {
      displayName: 'Client Private Key',
      name: 'key',
      type: 'string',
      default: '',
      typeOptions: { rows: 4, password: true },
      displayOptions: { show: { ssl: [true] } },
      description: 'PEM private key for mTLS. Needs the Client Certificate too.',
    },
    {
      displayName: 'Ignore SSL Issues (Insecure)',
      name: 'allowUnauthorizedCerts',
      type: 'boolean',
      default: false,
      displayOptions: { show: { ssl: [true] } },
      description: 'Whether to connect even if the broker certificate cannot be verified',
    },
    { displayName: 'Authentication', name: 'authentication', type: 'boolean', default: false },
    {
      displayName: 'Username',
      name: 'username',
      type: 'string',
      default: '',
      displayOptions: { show: { authentication: [true] } },
    },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      displayOptions: { show: { authentication: [true] } },
    },
    {
      displayName: 'SASL Mechanism',
      name: 'saslMechanism',
      type: 'options',
      default: 'plain',
      displayOptions: { show: { authentication: [true] } },
      options: [
        { name: 'Plain', value: 'plain' },
        { name: 'scram-sha-256', value: 'scram-sha-256' },
        { name: 'scram-sha-512', value: 'scram-sha-512' },
      ],
    },
  ],
};

export const schemaRegistryApi: CredentialType = {
  name: 'schemaRegistryApi',
  displayName: 'Schema Registry',
  // sends no HTTP requests with the credential: no "Allowed HTTP Request Domains" fields
  hideDomainRestrictionFields: true,
  properties: [
    {
      displayName: 'URL',
      name: 'url',
      type: 'string',
      default: '',
      placeholder: 'https://schema-registry-domain:8081',
      description: 'URL of the schema registry',
    },
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'basicAuth',
      options: [
        { name: 'Basic Auth', value: 'basicAuth' },
        { name: 'None', value: 'none' },
      ],
    },
    {
      displayName: 'Username',
      name: 'username',
      type: 'string',
      default: '',
      displayOptions: { show: { authentication: ['basicAuth'] } },
      description: 'Username or API key',
    },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      displayOptions: { show: { authentication: ['basicAuth'] } },
      description: 'Password or API secret',
    },
  ],
};
