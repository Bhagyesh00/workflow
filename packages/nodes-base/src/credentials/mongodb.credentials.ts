/**
 * The MongoDB credential, with n8n's field names: a connection string, or host, port, database and user
 * given one by one, plus optional TLS material. It has no `test`: the nodes that take it name their own
 * connection test with `testedBy`, because only the driver (behind the SSRF guard) can prove a connection.
 */
import type { CredentialType, NodeProperty } from '@workflow/workflow';

const byValues = { show: { configurationType: ['values'] } };
const withTls = { show: { tls: [true] } };

/** PEM text or a secret: masked in the editor and redacted by the API */
function secretText(displayName: string, name: string, description: string): NodeProperty {
  return {
    displayName,
    name,
    type: 'string',
    default: '',
    typeOptions: { rows: 4, password: true },
    description,
    displayOptions: withTls,
  };
}

export const mongoDb: CredentialType = {
  name: 'mongoDb',
  displayName: 'MongoDB',
  icon: 'simple:mongodb',
  documentationUrl: 'https://www.mongodb.com/docs/manual/reference/connection-string/',
  // the driver opens its own sockets: no HTTP request carries this credential
  hideDomainRestrictionFields: true,
  properties: [
    {
      displayName: 'Configuration Type',
      name: 'configurationType',
      type: 'options',
      default: 'values',
      options: [
        {
          name: 'Connection String',
          value: 'connectionString',
          description: 'One mongodb:// or mongodb+srv:// string holds the whole connection',
        },
        { name: 'Values', value: 'values', description: 'Host, port, user and password one by one' },
      ],
    },
    {
      displayName: 'Connection String',
      name: 'connectionString',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      placeholder: 'mongodb+srv://<user>:<password>@cluster0.example.mongodb.net/?retryWrites=true',
      description:
        'Used instead of the separate values. It may hold the password, so it is stored as a secret.',
      displayOptions: { show: { configurationType: ['connectionString'] } },
    },
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: 'localhost',
      required: true,
      displayOptions: byValues,
    },
    {
      displayName: 'Database',
      name: 'database',
      type: 'string',
      default: '',
      description: 'Default database; give it here even with a connection string',
    },
    { displayName: 'User', name: 'user', type: 'string', default: '', displayOptions: byValues },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      displayOptions: byValues,
    },
    { displayName: 'Port', name: 'port', type: 'number', default: 27017, displayOptions: byValues },
    { displayName: 'Use TLS', name: 'tls', type: 'boolean', default: false },
    secretText('CA Certificate', 'ca', 'PEM certificate of the CA that signed the server certificate'),
    secretText('Public Client Certificate', 'cert', 'PEM client certificate, when the server asks for one'),
    secretText('Private Client Key', 'key', 'PEM private key of the client certificate'),
    {
      displayName: 'Passphrase',
      name: 'passphrase',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description: 'Passphrase of the private client key, if it has one',
      displayOptions: withTls,
    },
  ],
};
