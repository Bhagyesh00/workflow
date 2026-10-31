/** Credentials for app integrations: Slack, Notion, Airtable, Telegram, Postgres, Redis, MySQL, SMTP. */
import type { CredentialType } from '@workflow/workflow';

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
    {
      displayName: 'Max Connections',
      name: 'maxConnections',
      type: 'number',
      default: 5,
      typeOptions: { minValue: 1, maxValue: 50 },
    },
  ],
};

export const redis: CredentialType = {
  name: 'redis',
  displayName: 'Redis',
  icon: 'simple:redis',
  properties: [
    { displayName: 'Host', name: 'host', type: 'string', default: 'localhost', required: true },
    { displayName: 'Port', name: 'port', type: 'number', default: 6379 },
    { displayName: 'User', name: 'user', type: 'string', default: '', description: 'Redis 6+ ACL user (optional)' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    { displayName: 'Database', name: 'database', type: 'number', default: 0 },
    { displayName: 'SSL', name: 'ssl', type: 'boolean', default: false },
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
    {
      displayName: 'Connect Timeout',
      name: 'connectTimeout',
      type: 'number',
      default: 10000,
      description: 'Milliseconds',
    },
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
