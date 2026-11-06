/** Credentials for app integrations: Slack, Notion, Airtable, Telegram, Postgres, Redis, MySQL, SMTP. */
import type { CredentialType, NodeProperty } from '@workflow/workflow';

export const slackApi: CredentialType = {
  name: 'slackApi',
  displayName: 'Slack API',
  icon: 'simple:slack',
  documentationUrl: 'https://api.slack.com/authentication/token-types',
  properties: [
    {
      displayName: 'Access Token',
      name: 'accessToken',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      placeholder: 'xoxb-...',
      description: 'Bot (xoxb-) or user (xoxp-) token of your Slack app',
    },
  ],
  authenticate: {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } },
  },
  test: { request: { url: 'https://slack.com/api/auth.test', method: 'POST' } },
};

export const NOTION_VERSION = '2022-06-28';

export const notionApi: CredentialType = {
  name: 'notionApi',
  displayName: 'Notion API',
  icon: 'simple:notion',
  documentationUrl: 'https://developers.notion.com/docs/authorization',
  properties: [
    {
      displayName: 'Internal Integration Secret',
      name: 'apiKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      placeholder: 'ntn_...',
    },
  ],
  authenticate: {
    type: 'generic',
    properties: {
      headers: { Authorization: '=Bearer {{$credentials.apiKey}}', 'Notion-Version': NOTION_VERSION },
    },
  },
  test: { request: { url: 'https://api.notion.com/v1/users/me', method: 'GET' } },
};

export const airtableTokenApi: CredentialType = {
  name: 'airtableTokenApi',
  displayName: 'Airtable Personal Access Token API',
  icon: 'simple:airtable',
  documentationUrl: 'https://airtable.com/create/tokens',
  properties: [
    {
      displayName: 'Access Token',
      name: 'accessToken',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      placeholder: 'pat...',
      description: 'Needs the data.records:read/write and schema.bases:read scopes',
    },
  ],
  authenticate: {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } },
  },
  test: { request: { url: 'https://api.airtable.com/v0/meta/whoami', method: 'GET' } },
};

export const telegramApi: CredentialType = {
  name: 'telegramApi',
  displayName: 'Telegram API',
  icon: 'simple:telegram',
  documentationUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
  properties: [
    {
      displayName: 'Access Token',
      name: 'accessToken',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      placeholder: '123456:ABC-DEF...',
      description: 'Bot token from @BotFather',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.telegram.org',
      description: 'Change only when using a self-hosted Bot API server',
    },
  ],
  // the token is part of the URL path, so requests are built by the node (see Telegram.node.ts)
  test: {
    request: { url: '={{$credentials.baseUrl}}/bot{{$credentials.accessToken}}/getMe', method: 'GET' },
  },
};

/** PEM fields for the client side of TLS (n8n's names), shown with either encrypting SSL mode */
const SSL_CLIENT_CERT_PROPERTIES: NodeProperty[] = [
  {
    displayName: 'Client Private Key',
    name: 'clientPrivateKey',
    type: 'string',
    default: '',
    typeOptions: { rows: 4, password: true },
    displayOptions: { show: { ssl: ['allow', 'require'] } },
  },
  {
    displayName: 'Client Certificate',
    name: 'clientCertificate',
    type: 'string',
    default: '',
    typeOptions: { rows: 4, password: true },
    displayOptions: { show: { ssl: ['allow', 'require'] } },
  },
];

/** the SSH tunnel block of the SQL credentials (n8n's names, including `privateKey` and `passphrase`) */
export const SSH_TUNNEL_PROPERTIES: NodeProperty[] = [
  { displayName: 'SSH Tunnel', name: 'sshTunnel', type: 'boolean', default: false },
  {
    displayName: 'SSH Authenticate with',
    name: 'sshAuthenticateWith',
    type: 'options',
    default: 'password',
    options: [
      { name: 'Password', value: 'password' },
      { name: 'Private Key', value: 'privateKey' },
    ],
    displayOptions: { show: { sshTunnel: [true] } },
  },
  {
    displayName: 'SSH Host',
    name: 'sshHost',
    type: 'string',
    default: 'localhost',
    displayOptions: { show: { sshTunnel: [true] } },
  },
  {
    displayName: 'SSH Port',
    name: 'sshPort',
    type: 'number',
    default: 22,
    displayOptions: { show: { sshTunnel: [true] } },
  },
  {
    displayName: 'SSH User',
    name: 'sshUser',
    type: 'string',
    default: 'root',
    displayOptions: { show: { sshTunnel: [true] } },
  },
  {
    displayName: 'SSH Password',
    name: 'sshPassword',
    type: 'string',
    default: '',
    typeOptions: { password: true },
    displayOptions: { show: { sshTunnel: [true], sshAuthenticateWith: ['password'] } },
  },
  {
    displayName: 'Private Key',
    name: 'privateKey',
    type: 'string',
    default: '',
    typeOptions: { rows: 4, password: true },
    displayOptions: { show: { sshTunnel: [true], sshAuthenticateWith: ['privateKey'] } },
  },
  {
    displayName: 'Passphrase',
    name: 'passphrase',
    type: 'string',
    default: '',
    typeOptions: { password: true },
    description: 'Passphrase of the private key. Leave empty if the key has none.',
    displayOptions: { show: { sshTunnel: [true], sshAuthenticateWith: ['privateKey'] } },
  },
];

export const postgres: CredentialType = {
  name: 'postgres',
  displayName: 'Postgres',
  icon: 'simple:postgresql',
  properties: [
    { displayName: 'Host', name: 'host', type: 'string', default: 'localhost', required: true },
    { displayName: 'Database', name: 'database', type: 'string', default: 'postgres', required: true },
    { displayName: 'User', name: 'user', type: 'string', default: 'postgres', required: true },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    { displayName: 'Port', name: 'port', type: 'number', default: 5432 },
    {
      displayName: 'SSL',
      name: 'ssl',
      type: 'options',
      default: 'disable',
      options: [
        { name: 'Disable', value: 'disable' },
        { name: 'Allow (Encrypt, Do Not Verify Certificate)', value: 'allow' },
        { name: 'Require (Encrypt and Verify Certificate)', value: 'require' },
      ],
    },
    {
      displayName: 'CA Certificate',
      name: 'caCertificate',
      type: 'string',
      default: '',
      typeOptions: { rows: 4 },
      description: 'PEM certificate of the CA that signed the server certificate (for private CAs)',
      displayOptions: { show: { ssl: ['require'] } },
    },
    ...SSL_CLIENT_CERT_PROPERTIES,
    {
      displayName: 'Max Connections',
      name: 'maxConnections',
      type: 'number',
      default: 5,
      typeOptions: { minValue: 1, maxValue: 50 },
    },
    ...SSH_TUNNEL_PROPERTIES,
  ],
};

export const redis: CredentialType = {
  name: 'redis',
  displayName: 'Redis',
  icon: 'simple:redis',
  properties: [
    { displayName: 'Host', name: 'host', type: 'string', default: 'localhost', required: true },
    { displayName: 'Port', name: 'port', type: 'number', default: 6379 },
    {
      displayName: 'User',
      name: 'user',
      type: 'string',
      default: '',
      description: 'Redis 6+ ACL user (optional)',
    },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    { displayName: 'Database', name: 'database', type: 'number', default: 0 },
    { displayName: 'SSL', name: 'ssl', type: 'boolean', default: false },
    {
      displayName: 'Disable TLS Verification (Insecure)',
      name: 'disableTlsVerification',
      type: 'boolean',
      default: false,
      description: 'Whether to accept a certificate that cannot be verified, such as a self-signed one',
      displayOptions: { show: { ssl: [true] } },
    },
  ],
};

export const mySql: CredentialType = {
  name: 'mySql',
  displayName: 'MySQL',
  icon: 'simple:mysql',
  properties: [
    { displayName: 'Host', name: 'host', type: 'string', default: 'localhost', required: true },
    { displayName: 'Database', name: 'database', type: 'string', default: 'mysql', required: true },
    { displayName: 'User', name: 'user', type: 'string', default: 'mysql', required: true },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    { displayName: 'Port', name: 'port', type: 'number', default: 3306 },
    {
      displayName: 'SSL',
      name: 'ssl',
      type: 'options',
      default: 'disable',
      options: [
        { name: 'Disable', value: 'disable' },
        { name: 'Allow (Encrypt, Do Not Verify Certificate)', value: 'allow' },
        { name: 'Require (Encrypt and Verify Certificate)', value: 'require' },
      ],
    },
    {
      displayName: 'CA Certificate',
      name: 'caCertificate',
      type: 'string',
      default: '',
      typeOptions: { rows: 4 },
      displayOptions: { show: { ssl: ['require'] } },
    },
    ...SSL_CLIENT_CERT_PROPERTIES,
    {
      displayName: 'Connect Timeout',
      name: 'connectTimeout',
      type: 'number',
      default: 10000,
      description: 'Milliseconds',
    },
    ...SSH_TUNNEL_PROPERTIES,
  ],
};

export const smtp: CredentialType = {
  name: 'smtp',
  displayName: 'SMTP',
  icon: 'lucide:mail',
  properties: [
    { displayName: 'User', name: 'user', type: 'string', default: '' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'smtp.example.com',
    },
    { displayName: 'Port', name: 'port', type: 'number', default: 465 },
    {
      displayName: 'SSL/TLS',
      name: 'secure',
      type: 'boolean',
      default: true,
      description:
        'Whether to use TLS from the start (port 465). Off uses STARTTLS when the server offers it.',
    },
    {
      displayName: 'Disable STARTTLS',
      name: 'disableStartTls',
      type: 'boolean',
      default: false,
      displayOptions: { show: { secure: [false] } },
    },
    {
      displayName: 'Client Host Name',
      name: 'hostName',
      type: 'string',
      default: '',
      description: 'Name sent in the EHLO greeting; defaults to the machine name',
    },
  ],
};
