/**
 * Node and credential type descriptions served by the in-browser demo backend and by the test
 * suite's mock server. They mirror the shape the real server sends (GET /rest/node-types) and
 * between them use every parameter type the editor supports.
 */
import type { CredentialTypeDescription, NodeTypeDescription, WorkflowDefinition } from '@workflow/workflow';

const manualTrigger: NodeTypeDescription = {
  name: 'core.manualTrigger',
  displayName: 'Manual Trigger',
  description: 'Starts the workflow when you execute it from the editor',
  icon: 'lucide:mouse-pointer-click',
  group: ['trigger'],
  version: 1,
  defaults: { name: 'When clicking Execute workflow' },
  inputs: [],
  outputs: ['main'],
  maxNodes: 1,
  categories: ['Core', 'Triggers'],
  properties: [
    {
      displayName: 'This step starts the workflow when you click "Execute workflow".',
      name: 'notice',
      type: 'notice',
      default: '',
    },
  ],
};

const webhook: NodeTypeDescription = {
  name: 'core.webhook',
  displayName: 'Webhook',
  description: 'Starts the workflow when an HTTP request arrives',
  icon: 'lucide:webhook',
  group: ['trigger'],
  version: 1,
  defaults: { name: 'Webhook' },
  inputs: [],
  outputs: ['main'],
  categories: ['Core', 'Triggers'],
  alias: ['http', 'endpoint', 'callback'],
  webhooks: [
    { name: 'default', httpMethod: '={{$parameter["httpMethod"]}}', path: '={{$parameter["path"]}}' },
  ],
  eventTriggerDescription: 'Waiting for you to call the test URL',
  credentials: [
    { name: 'httpBasicAuth', required: true, displayOptions: { show: { authentication: ['basicAuth'] } } },
  ],
  properties: [
    {
      displayName: 'HTTP Method',
      name: 'httpMethod',
      type: 'options',
      default: 'POST',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ name: m, value: m })),
    },
    { displayName: 'Path', name: 'path', type: 'string', default: '', placeholder: 'orders/new' },
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None', value: 'none' },
        { name: 'Basic Auth', value: 'basicAuth' },
      ],
    },
  ],
};

const schedule: NodeTypeDescription = {
  name: 'core.scheduleTrigger',
  displayName: 'Schedule Trigger',
  description: 'Runs the workflow at fixed times or intervals',
  icon: 'lucide:calendar-clock',
  group: ['trigger', 'schedule'],
  version: 1,
  defaults: { name: 'Schedule Trigger' },
  inputs: [],
  outputs: ['main'],
  categories: ['Core', 'Triggers'],
  alias: ['cron', 'timer', 'interval'],
  properties: [
    {
      displayName: 'Rules',
      name: 'rule',
      type: 'fixedCollection',
      default: { interval: [{ field: 'hours', hoursInterval: 1 }] },
      typeOptions: { multipleValues: true, multipleValueButtonText: 'Add rule' },
      options: [
        {
          displayName: 'Interval',
          name: 'interval',
          values: [
            {
              displayName: 'Every',
              name: 'field',
              type: 'options',
              default: 'hours',
              options: [
                { name: 'Minutes', value: 'minutes' },
                { name: 'Hours', value: 'hours' },
                { name: 'Days', value: 'days' },
              ],
            },
            {
              displayName: 'Hours between runs',
              name: 'hoursInterval',
              type: 'number',
              default: 1,
              typeOptions: { minValue: 1, maxValue: 24 },
              displayOptions: { show: { field: ['hours'] } },
            },
            {
              displayName: 'Minutes between runs',
              name: 'minutesInterval',
              type: 'number',
              default: 5,
              typeOptions: { minValue: 1 },
              displayOptions: { show: { field: ['minutes'] } },
            },
            {
              displayName: 'At hour',
              name: 'triggerAtHour',
              type: 'number',
              default: 9,
              typeOptions: { minValue: 0, maxValue: 23 },
              displayOptions: { show: { field: ['days'] } },
            },
          ],
        },
      ],
    },
  ],
};

const set: NodeTypeDescription = {
  name: 'core.set',
  displayName: 'Edit Fields (Set)',
  description: 'Add, change or remove item fields',
  icon: 'lucide:pen',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Edit Fields' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Core', 'Data transformation'],
  alias: ['set', 'fields', 'map'],
  properties: [
    {
      displayName: 'Mode',
      name: 'mode',
      type: 'options',
      default: 'manual',
      noDataExpression: true,
      options: [
        { name: 'Manual Mapping', value: 'manual', description: 'Edit fields one by one' },
        { name: 'JSON', value: 'raw', description: 'Write the output as JSON' },
      ],
    },
    {
      displayName: 'Fields to Set',
      name: 'assignments',
      type: 'assignmentCollection',
      default: { assignments: [] },
      displayOptions: { show: { mode: ['manual'] } },
    },
    {
      displayName: 'JSON Output',
      name: 'jsonOutput',
      type: 'json',
      default: '{\n  "field": "value"\n}',
      typeOptions: { rows: 6 },
      displayOptions: { show: { mode: ['raw'] } },
    },
    { displayName: 'Include Other Input Fields', name: 'includeOtherFields', type: 'boolean', default: true },
  ],
};

const code: NodeTypeDescription = {
  name: 'core.code',
  displayName: 'Code',
  description: 'Run custom JavaScript in a secure sandbox',
  icon: 'lucide:code',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Code' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Core', 'Data transformation'],
  alias: ['javascript', 'script', 'function'],
  properties: [
    {
      displayName: 'Mode',
      name: 'mode',
      type: 'options',
      default: 'runOnceForAllItems',
      noDataExpression: true,
      options: [
        { name: 'Run Once for All Items', value: 'runOnceForAllItems' },
        { name: 'Run Once for Each Item', value: 'runOnceForEachItem' },
      ],
    },
    {
      displayName: 'JavaScript',
      name: 'jsCode',
      type: 'code',
      noDataExpression: true,
      typeOptions: { editor: 'codeNodeEditor', editorLanguage: 'javaScript', rows: 10 },
      default:
        "// Add a field to every item\nconsole.log('items in:', $input.all().length);\nreturn $input.all().map((item) => ({ json: { ...item.json, checked: true } }));\n",
    },
  ],
};

const ifNode: NodeTypeDescription = {
  name: 'core.if',
  displayName: 'If',
  description: 'Route items to true or false by conditions',
  icon: 'lucide:split',
  group: ['transform'],
  version: 1,
  defaults: { name: 'If' },
  inputs: ['main'],
  outputs: ['main', 'main'],
  outputNames: ['true', 'false'],
  categories: ['Core', 'Flow'],
  alias: ['condition', 'branch', 'filter'],
  properties: [{ displayName: 'Conditions', name: 'conditions', type: 'filter', default: {} }],
};

const switchNode: NodeTypeDescription = {
  name: 'core.switch',
  displayName: 'Switch',
  description: 'Route items to one of several outputs',
  icon: 'lucide:git-fork',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Switch' },
  inputs: ['main'],
  outputs:
    "={{ ($parameter.rules?.values ?? []).map((rule, i) => ({ type: 'main', displayName: rule.outputKey || ('Output ' + (i + 1)) })) }}",
  categories: ['Core', 'Flow'],
  alias: ['router', 'case'],
  properties: [
    {
      displayName: 'Routing Rules',
      name: 'rules',
      type: 'fixedCollection',
      default: { values: [{ outputKey: 'first' }] },
      typeOptions: { multipleValues: true, sortable: true, multipleValueButtonText: 'Add routing rule' },
      options: [
        {
          displayName: 'Rule',
          name: 'values',
          values: [
            { displayName: 'Output name', name: 'outputKey', type: 'string', default: '' },
            { displayName: 'Conditions', name: 'conditions', type: 'filter', default: {} },
          ],
        },
      ],
    },
  ],
};

const merge: NodeTypeDescription = {
  name: 'core.merge',
  displayName: 'Merge',
  description: 'Combine the items of two inputs',
  icon: 'lucide:merge',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Merge' },
  inputs: ['main', 'main'],
  outputs: ['main'],
  categories: ['Core', 'Flow'],
  properties: [
    {
      displayName: 'Mode',
      name: 'mode',
      type: 'options',
      default: 'append',
      options: [
        { name: 'Append', value: 'append', description: 'All items of input 1, then input 2' },
        { name: 'Combine by position', value: 'combineByPosition' },
      ],
    },
  ],
};

const noOp: NodeTypeDescription = {
  name: 'core.noOp',
  displayName: 'No Operation, do nothing',
  description: 'Passes data through unchanged',
  icon: 'lucide:arrow-right',
  group: ['organization'],
  version: 1,
  defaults: { name: 'No Operation' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Core', 'Flow'],
  properties: [],
};

const httpRequest: NodeTypeDescription = {
  name: 'core.httpRequest',
  displayName: 'HTTP Request',
  description: 'Call any HTTP API',
  icon: 'lucide:globe',
  group: ['output'],
  version: [1, 2],
  defaults: { name: 'HTTP Request' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Core', 'Developer'],
  alias: ['api', 'rest', 'fetch', 'curl'],
  subtitle: '={{ $parameter.method + " " + $parameter.url }}',
  credentials: [
    {
      name: 'httpBasicAuth',
      required: true,
      displayOptions: {
        show: { authentication: ['genericCredentialType'], genericAuthType: ['httpBasicAuth'] },
      },
    },
    {
      name: 'httpHeaderAuth',
      required: true,
      displayOptions: {
        show: { authentication: ['genericCredentialType'], genericAuthType: ['httpHeaderAuth'] },
      },
    },
  ],
  properties: [
    {
      displayName: 'Method',
      name: 'method',
      type: 'options',
      default: 'GET',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ name: m, value: m })),
    },
    {
      displayName: 'URL',
      name: 'url',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://api.example.com/orders',
    },
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None', value: 'none' },
        { name: 'Generic credential type', value: 'genericCredentialType' },
      ],
    },
    {
      displayName: 'Generic Auth Type',
      name: 'genericAuthType',
      type: 'credentialsSelect',
      default: '',
      options: [
        { name: 'Basic Auth', value: 'httpBasicAuth' },
        { name: 'Header Auth', value: 'httpHeaderAuth' },
      ],
      displayOptions: { show: { authentication: ['genericCredentialType'] } },
    },
    {
      displayName: 'Send Body',
      name: 'sendBody',
      type: 'boolean',
      default: false,
      displayOptions: { show: { method: ['POST', 'PUT', 'PATCH'] } },
    },
    {
      displayName: 'Body',
      name: 'jsonBody',
      type: 'json',
      default: '{}',
      displayOptions: { show: { sendBody: [true] } },
    },
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Timeout (ms)',
          name: 'timeout',
          type: 'number',
          default: 10000,
          typeOptions: { minValue: 1 },
        },
        { displayName: 'Ignore SSL errors', name: 'allowUnauthorizedCerts', type: 'boolean', default: false },
        { displayName: 'Full response', name: 'fullResponse', type: 'boolean', default: false },
        {
          displayName: 'Batch size',
          name: 'batchSize',
          type: 'number',
          default: 50,
          displayOptions: { show: { '@version': [2] } },
        },
      ],
    },
  ],
};

const crm: NodeTypeDescription = {
  name: 'app.crm',
  displayName: 'Acme CRM',
  description: 'Work with contacts and deals in Acme CRM',
  icon: 'simple:acmecrm',
  iconColor: '#0f8a6c',
  group: ['output'],
  version: 1,
  defaults: { name: 'Acme CRM' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Sales'],
  alias: ['customer', 'deal'],
  subtitle: '={{ $parameter.operation + ": " + $parameter.resource }}',
  credentials: [{ name: 'crmApi', required: true }],
  properties: [
    {
      displayName: 'Resource',
      name: 'resource',
      type: 'options',
      noDataExpression: true,
      default: 'contact',
      options: [
        { name: 'Contact', value: 'contact' },
        { name: 'Deal', value: 'deal' },
      ],
    },
    {
      displayName: 'Operation',
      name: 'operation',
      type: 'options',
      noDataExpression: true,
      default: 'get',
      displayOptions: { show: { resource: ['contact'] } },
      options: [
        { name: 'Get', value: 'get', action: 'Get a contact' },
        { name: 'Create', value: 'create', action: 'Create a contact' },
      ],
    },
    {
      displayName: 'Operation',
      name: 'operation',
      type: 'options',
      noDataExpression: true,
      default: 'create',
      displayOptions: { show: { resource: ['deal'] } },
      options: [{ name: 'Create', value: 'create', action: 'Create a deal' }],
    },
    {
      displayName: 'Contact',
      name: 'contactId',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      displayOptions: { show: { resource: ['contact'], operation: ['get'] } },
      modes: [
        {
          displayName: 'From list',
          name: 'list',
          type: 'list',
          typeOptions: { searchListMethod: 'searchContacts', searchable: true },
        },
        { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'c_123' },
        {
          displayName: 'By URL',
          name: 'url',
          type: 'string',
          placeholder: 'https://crm.example.com/contacts/c_123',
          extractValue: { type: 'regex', regex: 'contacts/([a-z0-9_]+)' },
        },
      ],
    },
    {
      displayName: 'Email',
      name: 'email',
      type: 'string',
      default: '',
      required: true,
      displayOptions: { show: { resource: ['contact'], operation: ['create'] } },
    },
    {
      displayName: 'Pipeline',
      name: 'pipeline',
      type: 'options',
      default: '',
      typeOptions: { loadOptionsMethod: 'getPipelines' },
      displayOptions: { show: { resource: ['deal'] } },
    },
    {
      displayName: 'Stage',
      name: 'stage',
      type: 'options',
      default: '',
      typeOptions: { loadOptionsMethod: 'getStages', loadOptionsDependsOn: ['pipeline'] },
      displayOptions: { show: { resource: ['deal'] } },
    },
    {
      displayName: 'Labels',
      name: 'labels',
      type: 'multiOptions',
      default: [],
      options: [
        { name: 'Hot', value: 'hot' },
        { name: 'Partner', value: 'partner' },
        { name: 'Renewal', value: 'renewal' },
      ],
      displayOptions: { show: { resource: ['deal'] } },
    },
  ],
};

const agent: NodeTypeDescription = {
  name: 'ai.agent',
  displayName: 'AI Agent',
  description: 'Answers with a language model that can use tools and memory',
  icon: 'lucide:bot',
  group: ['transform'],
  version: 1,
  defaults: { name: 'AI Agent' },
  inputs: [
    'main',
    { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
    { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
    { type: 'ai_tool', displayName: 'Tool' },
  ],
  outputs: ['main'],
  categories: ['AI', 'Agents'],
  properties: [
    {
      displayName: 'Prompt',
      name: 'text',
      type: 'string',
      default: '={{ $json.question }}',
      typeOptions: { rows: 3 },
    },
    {
      displayName: 'System message',
      name: 'systemMessage',
      type: 'string',
      default: 'You are a helpful assistant.',
      typeOptions: { rows: 3 },
    },
  ],
};

const chatModel: NodeTypeDescription = {
  name: 'ai.lmChatDemo',
  displayName: 'Chat Model',
  description: 'A language model for agents and chains',
  icon: 'lucide:sparkles',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Chat Model' },
  inputs: [],
  outputs: ['ai_languageModel'],
  categories: ['AI', 'Language models'],
  properties: [
    {
      displayName: 'Model',
      name: 'model',
      type: 'options',
      default: 'fast',
      options: [
        { name: 'Fast', value: 'fast' },
        { name: 'Thorough', value: 'thorough' },
      ],
    },
    {
      displayName: 'Temperature',
      name: 'temperature',
      type: 'number',
      default: 0.7,
      typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
    },
  ],
};

const memory: NodeTypeDescription = {
  name: 'ai.memoryBuffer',
  displayName: 'Window Memory',
  description: 'Remembers the last messages of a conversation',
  icon: 'lucide:brain',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Window Memory' },
  inputs: [],
  outputs: ['ai_memory'],
  categories: ['AI', 'Memory'],
  properties: [
    {
      displayName: 'Messages to keep',
      name: 'contextWindowLength',
      type: 'number',
      default: 10,
      typeOptions: { minValue: 1 },
    },
  ],
};

const calculator: NodeTypeDescription = {
  name: 'ai.toolCalculator',
  displayName: 'Calculator',
  description: 'Lets an agent do arithmetic',
  icon: 'lucide:calculator',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Calculator' },
  inputs: [],
  outputs: ['ai_tool'],
  categories: ['AI', 'Tools'],
  properties: [],
};

/** A test-only node that exercises every parameter type. Hidden from the node creator. */
export const kitchenSink: NodeTypeDescription = {
  name: 'test.kitchenSink',
  displayName: 'Kitchen Sink',
  description: 'Every parameter type',
  icon: 'lucide:box',
  group: ['transform'],
  version: [1, 2],
  defaults: { name: 'Kitchen Sink' },
  inputs: ['main'],
  outputs: ['main'],
  hidden: true,
  properties: [
    { displayName: 'Text', name: 'text', type: 'string', default: 'hello' },
    { displayName: 'Long text', name: 'longText', type: 'string', default: '', typeOptions: { rows: 4 } },
    { displayName: 'Secret', name: 'secret', type: 'string', default: '', typeOptions: { password: true } },
    {
      displayName: 'Count',
      name: 'count',
      type: 'number',
      default: 3,
      typeOptions: { minValue: 1, maxValue: 10, numberPrecision: 0 },
    },
    { displayName: 'Enabled', name: 'enabled', type: 'boolean', default: false },
    {
      displayName: 'Choice',
      name: 'choice',
      type: 'options',
      default: 'a',
      options: [
        { name: 'Option A', value: 'a' },
        { name: 'Option B', value: 'b' },
      ],
    },
    {
      displayName: 'Only for B',
      name: 'onlyB',
      type: 'string',
      default: '',
      displayOptions: { show: { choice: ['b'] } },
    },
    {
      displayName: 'Hidden for B',
      name: 'notB',
      type: 'string',
      default: '',
      displayOptions: { hide: { choice: ['b'] } },
    },
    {
      displayName: 'Version 2 only',
      name: 'v2Only',
      type: 'string',
      default: '',
      displayOptions: { show: { '@version': [2] } },
    },
    {
      displayName: 'Tags',
      name: 'tags',
      type: 'multiOptions',
      default: [],
      options: [
        { name: 'Red', value: 'red' },
        { name: 'Blue', value: 'blue' },
      ],
    },
    {
      displayName: 'Extras',
      name: 'extras',
      type: 'collection',
      default: {},
      placeholder: 'Add extra',
      options: [
        { displayName: 'Retries', name: 'retries', type: 'number', default: 2 },
        { displayName: 'Verbose', name: 'verbose', type: 'boolean', default: false },
        {
          displayName: 'Shown with root choice B',
          name: 'rootDependent',
          type: 'string',
          default: '',
          displayOptions: { show: { '/choice': ['b'] } },
        },
      ],
    },
    {
      displayName: 'Headers',
      name: 'headers',
      type: 'fixedCollection',
      default: {},
      typeOptions: { multipleValues: true, sortable: true },
      placeholder: 'Add header',
      options: [
        {
          displayName: 'Header',
          name: 'values',
          values: [
            { displayName: 'Name', name: 'name', type: 'string', default: '' },
            { displayName: 'Value', name: 'value', type: 'string', default: '' },
          ],
        },
      ],
    },
    { displayName: 'Payload', name: 'payload', type: 'json', default: '{"a":1}' },
    {
      displayName: 'Script',
      name: 'script',
      type: 'code',
      default: 'return items;',
      noDataExpression: true,
      typeOptions: { rows: 4 },
    },
    { displayName: 'Colour', name: 'colour', type: 'color', default: '#3346d3' },
    { displayName: 'When', name: 'when', type: 'dateTime', default: '' },
    { displayName: 'Read the docs before changing this node.', name: 'note', type: 'notice', default: '' },
    { displayName: 'Internal', name: 'internal', type: 'hidden', default: 'x' },
    {
      displayName: 'Auth type',
      name: 'authType',
      type: 'credentialsSelect',
      default: '',
      options: [{ name: 'Basic Auth', value: 'httpBasicAuth' }],
    },
    {
      displayName: 'Record',
      name: 'record',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'id', value: '' },
      modes: [
        {
          displayName: 'From list',
          name: 'list',
          type: 'list',
          typeOptions: { searchListMethod: 'searchContacts' },
        },
        { displayName: 'By ID', name: 'id', type: 'string' },
      ],
    },
    { displayName: 'Conditions', name: 'conditions', type: 'filter', default: {} },
    { displayName: 'Fields', name: 'fields', type: 'assignmentCollection', default: { assignments: [] } },
    { displayName: 'Fetch sample', name: 'fetchSample', type: 'button', default: '' },
    {
      displayName: 'Dynamic',
      name: 'dynamic',
      type: 'options',
      default: '',
      typeOptions: { loadOptionsMethod: 'getPipelines' },
    },
  ],
};

export const demoNodeTypes: NodeTypeDescription[] = [
  manualTrigger,
  webhook,
  schedule,
  set,
  code,
  ifNode,
  switchNode,
  merge,
  noOp,
  httpRequest,
  crm,
  agent,
  chatModel,
  memory,
  calculator,
  kitchenSink,
];

export const demoCredentialTypes: CredentialTypeDescription[] = [
  {
    name: 'httpBasicAuth',
    displayName: 'Basic Auth',
    icon: 'lucide:lock',
    properties: [
      { displayName: 'User', name: 'user', type: 'string', default: '' },
      {
        displayName: 'Password',
        name: 'password',
        type: 'string',
        default: '',
        typeOptions: { password: true },
      },
    ],
    hasAuthenticate: true,
    isOAuth2: false,
    isOAuth1: false,
    test: { request: { url: 'https://example.com' } },
  },
  {
    name: 'httpHeaderAuth',
    displayName: 'Header Auth',
    icon: 'lucide:key-round',
    properties: [
      { displayName: 'Name', name: 'name', type: 'string', default: '' },
      { displayName: 'Value', name: 'value', type: 'string', default: '', typeOptions: { password: true } },
    ],
    hasAuthenticate: true,
    isOAuth2: false,
    isOAuth1: false,
  },
  {
    name: 'crmApi',
    displayName: 'Acme CRM API',
    icon: 'simple:acmecrm',
    properties: [
      {
        displayName: 'API key',
        name: 'apiKey',
        type: 'string',
        default: '',
        typeOptions: { password: true },
      },
      {
        displayName: 'Region',
        name: 'region',
        type: 'options',
        default: 'eu',
        options: [
          { name: 'Europe', value: 'eu' },
          { name: 'United States', value: 'us' },
        ],
      },
    ],
    hasAuthenticate: true,
    isOAuth2: false,
    isOAuth1: false,
    test: { request: { url: 'https://crm.example.com/me' } },
  },
  {
    name: 'oAuth2Api',
    displayName: 'OAuth2 (generic)',
    icon: 'lucide:shield-check',
    properties: [
      { displayName: 'Client ID', name: 'clientId', type: 'string', default: '' },
      {
        displayName: 'Client Secret',
        name: 'clientSecret',
        type: 'string',
        default: '',
        typeOptions: { password: true },
      },
      { displayName: 'Authorization URL', name: 'authUrl', type: 'string', default: '' },
      { displayName: 'Scope', name: 'scope', type: 'string', default: '' },
    ],
    hasAuthenticate: false,
    isOAuth2: true,
    isOAuth1: false,
  },
  {
    name: 'oAuth1Api',
    displayName: 'OAuth1 API',
    icon: 'lucide:shield-check',
    properties: [
      { displayName: 'Consumer Key', name: 'consumerKey', type: 'string', default: '' },
      {
        displayName: 'Consumer Secret',
        name: 'consumerSecret',
        type: 'string',
        default: '',
        typeOptions: { password: true },
      },
      { displayName: 'Request Token URL', name: 'requestTokenUrl', type: 'string', default: '' },
      { displayName: 'Authorization URL', name: 'authUrl', type: 'string', default: '' },
      { displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'string', default: '' },
    ],
    hasAuthenticate: false,
    isOAuth2: false,
    isOAuth1: true,
  },
];

export const demoLoadOptions: Record<
  string,
  (params: Record<string, unknown>) => Array<{ name: string; value: string }>
> = {
  getPipelines: () => [
    { name: 'New business', value: 'new' },
    { name: 'Renewals', value: 'renewals' },
  ],
  getStages: (params) =>
    params.pipeline === 'renewals'
      ? [
          { name: 'Due', value: 'due' },
          { name: 'Renewed', value: 'renewed' },
        ]
      : [
          { name: 'Lead', value: 'lead' },
          { name: 'Qualified', value: 'qualified' },
          { name: 'Won', value: 'won' },
        ],
};

export const demoContacts = Array.from({ length: 34 }, (_, i) => ({
  name:
    ['Mara Quinn', 'Theo Lindqvist', 'Ines Okafor', 'Ravi Mendes', 'Lena Varga', 'Jonah Pike'][i % 6] +
    (i >= 6 ? ` ${Math.floor(i / 6) + 1}` : ''),
  value: `c_${100 + i}`,
  url: `https://crm.example.com/contacts/c_${100 + i}`,
}));

/** A workflow with one canvas group (P3-04): Clean up and Tag members, between a trigger and a no-op. */
export const demoGroupedWorkflow: WorkflowDefinition & { name: string } = {
  name: 'Lead cleanup',
  nodes: [
    {
      id: 'g-1',
      name: 'Try it',
      type: 'core.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: 'g-2',
      name: 'Clean up',
      type: 'core.set',
      typeVersion: 1,
      position: [280, 0],
      parameters: {
        mode: 'manual',
        includeOtherFields: true,
        assignments: {
          assignments: [{ id: 'e', name: 'email', type: 'string', value: '={{ $json.email }}' }],
        },
      },
    },
    {
      id: 'g-3',
      name: 'Tag',
      type: 'core.set',
      typeVersion: 1,
      position: [560, 0],
      parameters: {
        mode: 'manual',
        includeOtherFields: true,
        assignments: { assignments: [{ id: 't', name: 'source', type: 'string', value: 'demo' }] },
      },
    },
    {
      id: 'g-4',
      name: 'Done',
      type: 'core.noOp',
      typeVersion: 1,
      position: [840, 0],
      parameters: {},
    },
  ],
  connections: {
    'Try it': { main: [[{ node: 'Clean up', type: 'main', index: 0 }]] },
    'Clean up': { main: [[{ node: 'Tag', type: 'main', index: 0 }]] },
    Tag: { main: [[{ node: 'Done', type: 'main', index: 0 }]] },
  },
  nodeGroups: [
    { id: 'group-cleanup', name: 'Clean the lead', nodeIds: ['g-2', 'g-3'], description: 'Trim and tag.' },
  ],
};
