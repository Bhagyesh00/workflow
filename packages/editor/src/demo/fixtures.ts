/**
 * Node and credential type descriptions served by the in-browser demo backend and by the test
 * suite's mock server. They mirror the shape the real server sends (GET /rest/node-types) and
 * between them use every parameter type the editor supports.
 */
import type {
  CredentialTypeDescription,
  NodeProperty,
  NodeTypeDescription,
  ResourceMapperField,
  ResourceMapperFields,
  WorkflowDefinition,
} from '@workflow/workflow';
import type { AvailableType, ProjectIcon } from '../api/types';

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
  description: 'Run custom JavaScript or Python in a secure sandbox',
  icon: 'lucide:code',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Code' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Core', 'Data transformation'],
  alias: ['javascript', 'python', 'script', 'function'],
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
      displayName: 'Language',
      name: 'language',
      type: 'options',
      default: 'javaScript',
      noDataExpression: true,
      options: [
        { name: 'JavaScript', value: 'javaScript' },
        { name: 'Python', value: 'pythonNative' },
      ],
    },
    {
      displayName: 'Python',
      name: 'pythonCode',
      type: 'code',
      noDataExpression: true,
      // `python` is the older stored value of the same language
      displayOptions: { show: { language: ['pythonNative', 'python'] } },
      typeOptions: { editor: 'codeNodeEditor', editorLanguage: 'python', rows: 10 },
      default:
        "# Add a field to every item\nfor item in _items:\n    item['json']['checked'] = True\nreturn _items\n",
    },
    {
      displayName: 'JavaScript',
      name: 'jsCode',
      type: 'code',
      noDataExpression: true,
      displayOptions: { show: { language: ['javaScript'] } },
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

const formFields: NodeProperty = {
  displayName: 'Form Fields',
  name: 'formFields',
  type: 'fixedCollection',
  default: {},
  typeOptions: { multipleValues: true, sortable: true },
  options: [
    {
      displayName: 'Values',
      name: 'values',
      values: [
        { displayName: 'Field Label', name: 'fieldLabel', type: 'string', default: '', required: true },
        {
          displayName: 'Field Type',
          name: 'fieldType',
          type: 'options',
          default: 'text',
          options: ['text', 'email', 'number', 'textarea', 'date', 'dropdown'].map((value) => ({
            name: value[0].toUpperCase() + value.slice(1),
            value,
          })),
        },
        { displayName: 'Required Field', name: 'requiredField', type: 'boolean', default: false },
      ],
    },
  ],
};

const formTrigger: NodeTypeDescription = {
  name: 'core.formTrigger',
  displayName: 'Form Trigger',
  description: 'Starts the workflow when someone submits a form',
  icon: 'lucide:file-input',
  group: ['trigger'],
  version: 1,
  defaults: { name: 'On form submission' },
  inputs: [],
  outputs: ['main'],
  categories: ['Core', 'Triggers'],
  alias: ['form', 'survey', 'questionnaire'],
  webhooks: [
    {
      name: 'setup',
      httpMethod: 'GET',
      path: '={{$parameter["path"] || $parameter["options"]?.path || ""}}',
      isFullPath: true,
      ndvHideUrl: true,
      nodeType: 'form',
    },
    {
      name: 'default',
      httpMethod: 'POST',
      path: '={{$parameter["path"] || $parameter["options"]?.path || ""}}',
      isFullPath: true,
      nodeType: 'form',
    },
  ],
  eventTriggerDescription: 'Waiting for you to submit the test form',
  properties: [
    { displayName: 'Form Title', name: 'formTitle', type: 'string', default: '', required: true },
    { displayName: 'Form Description', name: 'formDescription', type: 'string', default: '' },
    formFields,
    {
      displayName: 'Respond When',
      name: 'responseMode',
      type: 'options',
      default: 'onReceived',
      options: [
        { name: 'Form Is Submitted', value: 'onReceived' },
        { name: 'Workflow Finishes', value: 'lastNode' },
      ],
    },
  ],
};

const form: NodeTypeDescription = {
  name: 'core.form',
  displayName: 'Form',
  description: 'Shows the next page of a form, or how the form ends',
  icon: 'lucide:file-text',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Form' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Core', 'Flow'],
  alias: ['page', 'survey'],
  properties: [
    {
      displayName: 'Page Type',
      name: 'operation',
      type: 'options',
      default: 'page',
      noDataExpression: true,
      options: [
        { name: 'Next Form Page', value: 'page' },
        { name: 'Form Ending', value: 'completion' },
      ],
    },
    { ...formFields, displayOptions: { show: { operation: ['page'] } } },
    {
      displayName: 'Completion Title',
      name: 'completionTitle',
      type: 'string',
      default: '',
      displayOptions: { show: { operation: ['completion'] } },
    },
    {
      displayName: 'Completion Message',
      name: 'completionMessage',
      type: 'string',
      default: '',
      displayOptions: { show: { operation: ['completion'] } },
    },
  ],
};

/** the row operations that pick rows by conditions */
const dataTableFilterOperations = ['get', 'update', 'upsert', 'deleteRows', 'rowExists', 'rowNotExists'];

const dataTable: NodeTypeDescription = {
  name: 'core.dataTable',
  displayName: 'Data Table',
  description: 'Reads and writes the tables of this workspace',
  icon: 'lucide:table-2',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Data Table' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Core', 'Data transformation'],
  alias: ['table', 'database', 'store', 'rows'],
  properties: [
    {
      displayName: 'Operation',
      name: 'operation',
      type: 'options',
      default: 'insert',
      noDataExpression: true,
      options: [
        { name: 'Insert', value: 'insert', action: 'Insert row' },
        { name: 'Get', value: 'get', action: 'Get rows' },
        { name: 'Update', value: 'update', action: 'Update rows' },
        { name: 'Upsert', value: 'upsert', action: 'Upsert row' },
        { name: 'Delete', value: 'deleteRows', action: 'Delete rows' },
        { name: 'If Row Exists', value: 'rowExists', action: 'If row exists' },
        { name: 'If Row Does Not Exist', value: 'rowNotExists', action: 'If row does not exist' },
      ],
    },
    {
      displayName: 'Data Table',
      name: 'dataTableId',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      modes: [
        {
          displayName: 'From list',
          name: 'list',
          type: 'list',
          typeOptions: {
            searchListMethod: 'tableSearch',
            searchable: true,
            allowNewResource: { label: 'Create a new data table', url: '/data-tables' },
          },
        },
        { displayName: 'By name', name: 'name', type: 'string' },
        { displayName: 'By ID', name: 'id', type: 'string' },
      ],
    },
    {
      displayName: 'Mapping Mode',
      name: 'dataMode',
      type: 'options',
      default: 'defineBelow',
      displayOptions: { show: { operation: ['insert', 'update', 'upsert'] } },
      options: [
        { name: 'Map Each Column Manually', value: 'defineBelow' },
        { name: 'Map Automatically', value: 'autoMapInputData' },
      ],
    },
    {
      displayName: 'Fields',
      name: 'fieldsUi',
      type: 'fixedCollection',
      default: {},
      typeOptions: { multipleValues: true },
      displayOptions: { show: { operation: ['insert', 'update', 'upsert'], dataMode: ['defineBelow'] } },
      options: [
        {
          displayName: 'Field',
          name: 'fieldValues',
          values: [
            { displayName: 'Column', name: 'columnName', type: 'string', default: '' },
            { displayName: 'Value', name: 'value', type: 'string', default: '' },
          ],
        },
      ],
    },
    {
      displayName: 'Match Type',
      name: 'matchType',
      type: 'options',
      default: 'anyCondition',
      displayOptions: { show: { operation: dataTableFilterOperations } },
      options: [
        { name: 'Any Condition', value: 'anyCondition' },
        { name: 'All Conditions', value: 'allConditions' },
      ],
    },
    {
      displayName: 'Conditions',
      name: 'filters',
      type: 'fixedCollection',
      default: {},
      placeholder: 'Add condition',
      typeOptions: { multipleValues: true },
      description: 'Update, upsert, delete and the exists checks need at least one condition',
      displayOptions: { show: { operation: dataTableFilterOperations } },
      options: [
        {
          displayName: 'Condition',
          name: 'conditions',
          values: [
            { displayName: 'Column', name: 'keyName', type: 'string', default: '' },
            {
              displayName: 'Condition',
              name: 'condition',
              type: 'options',
              default: 'eq',
              options: [
                { name: 'Equals', value: 'eq' },
                { name: 'Not Equal', value: 'neq' },
                { name: 'Contains (Case-Sensitive)', value: 'like' },
                { name: 'Contains (Case-Insensitive)', value: 'ilike' },
                { name: 'Greater Than', value: 'gt' },
                { name: 'Greater Than or Equal', value: 'gte' },
                { name: 'Less Than', value: 'lt' },
                { name: 'Less Than or Equal', value: 'lte' },
                { name: 'Is Empty', value: 'isEmpty' },
                { name: 'Is Not Empty', value: 'isNotEmpty' },
              ],
            },
            { displayName: 'Value', name: 'keyValue', type: 'string', default: '' },
          ],
        },
      ],
    },
    {
      displayName: 'Return All',
      name: 'returnAll',
      type: 'boolean',
      default: false,
      displayOptions: { show: { operation: ['get'] } },
    },
    {
      displayName: 'Limit Per Input Row',
      name: 'limit',
      type: 'number',
      default: 50,
      displayOptions: { show: { operation: ['get'], returnAll: [false] } },
    },
    {
      displayName: 'Order by Column',
      name: 'orderBy',
      type: 'boolean',
      default: false,
      displayOptions: { show: { operation: ['get'] } },
    },
    {
      displayName: 'Order By',
      name: 'orderByColumn',
      type: 'string',
      default: 'createdAt',
      displayOptions: { show: { operation: ['get'], orderBy: [true] } },
    },
    {
      displayName: 'Direction',
      name: 'orderByDirection',
      type: 'options',
      default: 'DESC',
      options: [
        { name: 'Ascending', value: 'ASC' },
        { name: 'Descending', value: 'DESC' },
      ],
      displayOptions: { show: { operation: ['get'], orderBy: [true] } },
    },
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      displayOptions: { show: { operation: ['update', 'upsert', 'deleteRows'] } },
      options: [
        {
          displayName: 'Dry Run',
          name: 'dryRun',
          type: 'boolean',
          default: false,
          description:
            'Whether to return the rows before and after the change (marked in dryRunState) without changing anything',
        },
      ],
    },
  ],
};

const redisTrigger: NodeTypeDescription = {
  name: 'app.redisTrigger',
  displayName: 'Redis Trigger',
  description: 'Starts the workflow when a message arrives on a Redis channel',
  icon: 'simple:redis',
  iconColor: '#d82c20',
  group: ['trigger'],
  version: 1,
  defaults: { name: 'Redis Trigger' },
  inputs: [],
  outputs: ['main'],
  categories: ['Data & Storage', 'Triggers'],
  eventTriggerDescription: 'Waiting for a message on the channels',
  credentials: [{ name: 'redis', required: true }],
  properties: [
    {
      displayName: 'Channels',
      name: 'channels',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'orders, invoices',
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
  version: [1, 2],
  defaults: { name: 'AI Agent' },
  // both options exist on version 2 only, so a demo Agent of version 1 keeps the four ports it always had
  inputs:
    "={{ ['main', { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 }, ...($parameter.needsFallback === true ? [{ type: 'ai_languageModel', displayName: 'Fallback Model', required: true, maxConnections: 1 }] : []), { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }, { type: 'ai_tool', displayName: 'Tool' }, ...($parameter.hasOutputParser === true ? [{ type: 'ai_outputParser', displayName: 'Output Parser', maxConnections: 1 }] : [])] }}",
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
      displayName: 'Require Specific Output Format',
      name: 'hasOutputParser',
      type: 'boolean',
      default: false,
      displayOptions: { show: { '@version': [2] } },
    },
    {
      displayName: 'Enable Fallback Model',
      name: 'needsFallback',
      type: 'boolean',
      default: false,
      displayOptions: { show: { '@version': [2] } },
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

/** P5-10: what the tool variant of `core.httpRequest` looks like after `withToolVariants` on a real server. */
const httpRequestTool: NodeTypeDescription = {
  ...httpRequest,
  name: 'core.httpRequestTool',
  displayName: 'HTTP Request Tool',
  inputs: [],
  outputs: ['ai_tool'],
  categories: ['AI', 'Tools', 'Other Tools'],
  properties: [
    {
      displayName: 'Description',
      name: 'toolDescription',
      type: 'string',
      required: true,
      default: httpRequest.description,
      typeOptions: { rows: 2 },
      description:
        'Explain to the LLM what this tool does, a good, specific description would allow LLMs to produce expected results much more often',
    },
    ...httpRequest.properties,
  ],
};

/**
 * P5-77: the Human review variant of a Slack node, by n8n's rule (webhooks plus a `sendAndWait` operation).
 * The demo has no Slack credential type, so this one lists no credentials.
 */
const slackHitlTool: NodeTypeDescription = {
  name: 'app.slackHitlTool',
  displayName: 'Slack',
  description: 'Request human approval for tools',
  icon: 'simple:slack',
  group: ['output'],
  version: 1,
  defaults: { name: 'Slack' },
  subtitle: 'Send and wait',
  inputs: [{ type: 'ai_tool', displayName: 'Tool', required: true }],
  outputs: [
    { type: 'ai_tool', displayName: 'Human review', filter: { nodes: ['ai.agent', 'ai.agentTool'] } },
  ],
  categories: ['AI', 'Tools', 'Human in the Loop'],
  webhooks: (['GET', 'POST'] as const).map((httpMethod) => ({
    name: 'default',
    httpMethod,
    path: 'answer',
    isFullPath: false,
    restartWebhook: true,
    responseMode: 'onReceived',
  })),
  properties: [
    { displayName: 'Resource', name: 'resource', type: 'hidden', default: 'message' },
    { displayName: 'Operation', name: 'operation', type: 'hidden', default: 'sendAndWait' },
    { displayName: 'Response Type', name: 'responseType', type: 'hidden', default: 'approval' },
    { displayName: 'Channel', name: 'channel', type: 'string', required: true, default: '' },
    {
      displayName: 'Message',
      name: 'message',
      type: 'string',
      required: true,
      default: '=The agent wants to run this tool: {{ $tool.name }}\n\nInput:\n{{ $tool.parameters }}',
      typeOptions: { rows: 4 },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Phase 5 S3: chat (P5-56..59) and evaluations (P5-02, P5-61). They mirror the shape of the real
// nodes (nodes-base core.evaluationTrigger, core.evaluation, core.executionData; nodes-ai
// ai.chatTrigger, ai.chat); simulator.ts gives them demo behaviour.
// ---------------------------------------------------------------------------------------------

/** the Data table picker of the evaluation nodes (the same list search as the Data Table node) */
const evaluationTableLocator = (show: Record<string, unknown[]>): NodeProperty => ({
  displayName: 'Data Table',
  name: 'dataTableId',
  type: 'resourceLocator',
  default: { __rl: true, mode: 'list', value: '' },
  required: true,
  displayOptions: { show },
  modes: [
    {
      displayName: 'From list',
      name: 'list',
      type: 'list',
      typeOptions: { searchListMethod: 'tableSearch', searchable: true },
    },
    { displayName: 'By ID', name: 'id', type: 'string' },
  ],
});

const evaluationSourceOptions = [
  { name: 'Data Table', value: 'dataTable' },
  { name: 'Google Sheets', value: 'googleSheets' },
];

const evaluationTrigger: NodeTypeDescription = {
  name: 'core.evaluationTrigger',
  displayName: 'Evaluation Trigger',
  description: 'Runs the workflow once per row of a test dataset',
  icon: 'lucide:flask-conical',
  group: ['trigger'],
  version: 1,
  defaults: { name: 'When fetching a dataset row' },
  inputs: [],
  outputs: ['main'],
  categories: ['Core', 'Triggers'],
  alias: ['evaluation', 'eval', 'dataset', 'test cases'],
  credentials: [
    {
      name: 'googleApi',
      required: true,
      displayOptions: { show: { source: ['googleSheets'], authentication: ['serviceAccount'] } },
    },
    {
      name: 'googleSheetsOAuth2Api',
      required: true,
      displayOptions: { show: { source: ['googleSheets'], authentication: ['oAuth2'] } },
    },
  ],
  properties: [
    {
      displayName:
        'A manual run reads the first row. Run the whole dataset from the Evaluations tab of this workflow.',
      name: 'notice',
      type: 'notice',
      default: '',
    },
    {
      displayName: 'Source',
      name: 'source',
      type: 'options',
      default: 'dataTable',
      options: evaluationSourceOptions,
    },
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'oAuth2',
      displayOptions: { show: { source: ['googleSheets'] } },
      options: [
        { name: 'OAuth2 (recommended)', value: 'oAuth2' },
        { name: 'Service Account', value: 'serviceAccount' },
      ],
    },
    evaluationTableLocator({ source: ['dataTable'] }),
    {
      displayName: 'Document ID',
      name: 'documentId',
      type: 'string',
      default: '',
      required: true,
      displayOptions: { show: { source: ['googleSheets'] } },
    },
    {
      displayName: 'Sheet',
      name: 'sheetName',
      type: 'string',
      default: '',
      required: true,
      displayOptions: { show: { source: ['googleSheets'] } },
    },
    { displayName: 'Limit Rows', name: 'limitRows', type: 'boolean', default: false },
    {
      displayName: 'Max Rows to Process',
      name: 'maxRows',
      type: 'number',
      default: 10,
      typeOptions: { minValue: 1, maxValue: 1000 },
      displayOptions: { show: { limitRows: [true] } },
    },
    { displayName: 'Filter Rows', name: 'filterRows', type: 'boolean', default: false },
    {
      displayName: 'Conditions',
      name: 'filters',
      type: 'filter',
      default: {},
      displayOptions: { show: { filterRows: [true], source: ['dataTable'] } },
    },
  ],
};

const evaluation: NodeTypeDescription = {
  name: 'core.evaluation',
  displayName: 'Evaluation',
  description: 'Records the inputs, outputs and metrics of an evaluation run',
  icon: 'lucide:check-check',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Evaluation' },
  // a model input only for the AI-based metrics, two outputs only for Check If Evaluating
  inputs:
    "={{ ['main', ...($parameter.operation === 'setMetrics' && ['correctness', 'helpfulness'].includes($parameter.metric) ? [{ type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 }] : [])] }}",
  outputs:
    "={{ $parameter.operation === 'checkIfEvaluating' ? [{ type: 'main', displayName: 'Evaluation' }, { type: 'main', displayName: 'Normal' }] : ['main'] }}",
  categories: ['Core', 'Evaluation'],
  alias: ['eval', 'metrics', 'score', 'test'],
  properties: [
    {
      displayName: 'Operation',
      name: 'operation',
      type: 'options',
      default: 'setOutputs',
      noDataExpression: true,
      options: [
        { name: 'Set Inputs', value: 'setInputs', action: 'Set inputs' },
        { name: 'Set Outputs', value: 'setOutputs', action: 'Set outputs' },
        { name: 'Set Metrics', value: 'setMetrics', action: 'Set metrics' },
        { name: 'Check If Evaluating', value: 'checkIfEvaluating', action: 'Check if evaluating' },
      ],
    },
    {
      displayName: 'Source',
      name: 'source',
      type: 'options',
      default: 'dataTable',
      displayOptions: { show: { operation: ['setOutputs'] } },
      options: evaluationSourceOptions,
    },
    evaluationTableLocator({ operation: ['setOutputs'], source: ['dataTable'] }),
    ...(['inputs', 'outputs'] as const).map(
      (name): NodeProperty => ({
        displayName: name === 'inputs' ? 'Inputs' : 'Outputs',
        name,
        type: 'fixedCollection',
        default: {},
        typeOptions: {
          multipleValues: true,
          multipleValueButtonText: name === 'inputs' ? 'Add input' : 'Add output',
        },
        displayOptions: { show: { operation: [name === 'inputs' ? 'setInputs' : 'setOutputs'] } },
        options: [
          {
            displayName: 'Value',
            name: 'values',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      }),
    ),
    {
      displayName: 'Metric',
      name: 'metric',
      type: 'options',
      default: 'customMetrics',
      displayOptions: { show: { operation: ['setMetrics'] } },
      options: [
        { name: 'Custom Metrics', value: 'customMetrics' },
        { name: 'Correctness (AI-based)', value: 'correctness' },
        { name: 'Helpfulness (AI-based)', value: 'helpfulness' },
        { name: 'String Similarity', value: 'stringSimilarity' },
        { name: 'Categorization', value: 'categorization' },
        { name: 'Tools Used', value: 'toolsUsed' },
      ],
    },
    {
      displayName: 'Metrics to Return',
      name: 'metrics',
      type: 'assignmentCollection',
      default: { assignments: [] },
      displayOptions: { show: { operation: ['setMetrics'], metric: ['customMetrics'] } },
    },
    {
      displayName: 'Expected Answer',
      name: 'expectedAnswer',
      type: 'string',
      default: '',
      displayOptions: {
        show: { operation: ['setMetrics'], metric: ['correctness', 'stringSimilarity', 'categorization'] },
      },
    },
    {
      displayName: 'Actual Answer',
      name: 'actualAnswer',
      type: 'string',
      default: '',
      displayOptions: {
        show: {
          operation: ['setMetrics'],
          metric: ['correctness', 'helpfulness', 'stringSimilarity', 'categorization'],
        },
      },
    },
  ],
};

const executionData: NodeTypeDescription = {
  name: 'core.executionData',
  displayName: 'Execution Data',
  description: 'Saves data on the execution, so you can filter executions by it',
  icon: 'lucide:tag',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Execution Data' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Core', 'Helpers'],
  alias: ['highlight', 'custom data', 'metadata', 'filter executions'],
  properties: [
    {
      displayName: 'Operation',
      name: 'operation',
      type: 'options',
      default: 'save',
      noDataExpression: true,
      options: [
        { name: 'Save Highlighted Data (for Search/review)', value: 'save', action: 'Save highlighted data' },
      ],
    },
    {
      displayName: 'Data to Save',
      name: 'dataToSave',
      type: 'fixedCollection',
      default: {},
      typeOptions: { multipleValues: true, multipleValueButtonText: 'Add saved field' },
      displayOptions: { show: { operation: ['save'] } },
      options: [
        {
          displayName: 'Values',
          name: 'values',
          values: [
            { displayName: 'Key', name: 'key', type: 'string', default: '', placeholder: 'e.g. myKey' },
            { displayName: 'Value', name: 'value', type: 'string', default: '', placeholder: 'e.g. myValue' },
          ],
        },
      ],
    },
  ],
};

// P6-56 (C0): nodes-base core.timeSaved, the same description (the demo's simulator passes its input through)
const timeSaved: NodeTypeDescription = {
  name: 'core.timeSaved',
  displayName: 'Track Time Saved',
  description: 'Adds the minutes this path saves to the time saved shown in Insights',
  icon: 'lucide:timer',
  group: ['organization'],
  version: 1,
  defaults: { name: 'Time Saved' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Core', 'Flow'],
  alias: ['time saved', 'insights', 'minutes saved', 'roi', 'track time'],
  properties: [
    {
      displayName: 'Calculation Mode',
      name: 'mode',
      type: 'options',
      default: 'once',
      noDataExpression: true,
      options: [
        {
          name: 'Once For All Items',
          value: 'once',
          description: 'Counts the minutes once, whatever the item count',
        },
        { name: 'Per Item', value: 'perItem', description: 'Counts the minutes once for each input item' },
      ],
    },
    {
      displayName: 'Minutes Saved',
      name: 'minutesSaved',
      type: 'number',
      default: 0,
      required: true,
      description: 'Minutes of manual work this path saves',
      typeOptions: { minValue: 0, numberPrecision: 0 },
    },
  ],
};

const chatTrigger: NodeTypeDescription = {
  name: 'ai.chatTrigger',
  displayName: 'Chat Trigger',
  description: 'Starts the workflow when a chat message is received',
  icon: 'lucide:message-circle',
  group: ['trigger'],
  version: 1,
  defaults: { name: 'When chat message received' },
  inputs: [],
  outputs: ['main'],
  categories: ['AI', 'Triggers'],
  alias: ['chat', 'chatbot', 'message', 'conversation'],
  eventTriggerDescription: 'Waiting for you to send a chat message',
  activationMessage: 'You can now send messages to the chat URL.',
  credentials: [
    {
      name: 'httpBasicAuth',
      required: true,
      displayOptions: { show: { public: [true], authentication: ['basicAuth'] } },
    },
  ],
  webhooks: [
    {
      name: 'default',
      httpMethod: 'POST',
      path: 'chat',
      responseMode: "={{ $parameter.options?.responseMode ?? 'lastNode' }}",
      responseData: 'firstEntryJson',
    },
    { name: 'setup', httpMethod: 'GET', path: 'chat', ndvHideUrl: true },
  ],
  properties: [
    {
      displayName: 'Make Chat Publicly Available',
      name: 'public',
      type: 'boolean',
      default: false,
      description:
        'Whether the chat URL works outside the editor. When off, only test messages from the editor are accepted.',
    },
    {
      displayName: 'Mode',
      name: 'mode',
      type: 'options',
      default: 'hostedChat',
      displayOptions: { show: { public: [true] } },
      options: [
        { name: 'Hosted Chat', value: 'hostedChat', description: 'Chat on a page this server hosts' },
        { name: 'Embedded Chat', value: 'webhook', description: 'Chat through the widget on your own site' },
      ],
    },
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'none',
      displayOptions: { show: { public: [true] } },
      options: [
        { name: 'None', value: 'none', description: 'Anyone with the URL can chat' },
        { name: 'Basic Auth', value: 'basicAuth' },
      ],
    },
    {
      displayName: 'Initial Message(s)',
      name: 'initialMessages',
      type: 'string',
      default: 'Hi there!\nHow can I help you today?',
      typeOptions: { rows: 3 },
      description: 'Shown when a chat opens; one message per line',
      displayOptions: { show: { public: [true] } },
    },
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Allowed Origins (CORS)',
          name: 'allowedOrigins',
          type: 'string',
          default: '*',
          description: 'Comma-separated origins allowed to call the chat from a browser, or * for any',
        },
        {
          displayName: 'Response Mode',
          name: 'responseMode',
          type: 'options',
          default: 'lastNode',
          options: [
            { name: 'When Last Node Finishes', value: 'lastNode' },
            { name: 'Streaming', value: 'streaming' },
            { name: "Using 'Respond to Webhook' Node", value: 'responseNode' },
            { name: 'Using Response Nodes', value: 'responseNodes' },
          ],
        },
        { displayName: 'Allow File Uploads', name: 'allowFileUploads', type: 'boolean', default: false },
        {
          displayName: 'Allowed File MIME Types',
          name: 'allowedFilesMimeTypes',
          type: 'string',
          default: '*',
          placeholder: 'image/*, text/plain',
        },
        { displayName: 'Title', name: 'title', type: 'string', default: 'Hi there!' },
        {
          displayName: 'Subtitle',
          name: 'subtitle',
          type: 'string',
          default: "Start a chat. We're here to help you 24/7.",
        },
        {
          displayName: 'Input Placeholder',
          name: 'inputPlaceholder',
          type: 'string',
          default: 'Type your question…',
        },
      ],
    },
  ],
};

const chat: NodeTypeDescription = {
  name: 'ai.chat',
  displayName: 'Respond to Chat',
  description: 'Sends a message to the chat, and can wait for the reply',
  icon: 'lucide:message-square-reply',
  group: ['output'],
  version: 1,
  defaults: { name: 'Respond to Chat' },
  inputs:
    "={{ ['main', ...($parameter.options?.memoryConnection === true ? [{ type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }] : [])] }}",
  outputs: ['main'],
  categories: ['AI', 'Human in the Loop'],
  alias: ['reply', 'respond', 'chat message'],
  usableAsTool: true,
  webhooks: [
    ...(['GET', 'POST'] as const).map((httpMethod) => ({
      name: 'default',
      httpMethod,
      path: 'answer',
      isFullPath: false,
      restartWebhook: true,
      responseMode: 'onReceived',
    })),
    {
      name: 'chatReply',
      httpMethod: 'POST',
      path: 'chat-reply',
      restartWebhook: true,
      responseMode: 'responseNodes',
    },
  ],
  properties: [
    {
      displayName: 'Operation',
      name: 'operation',
      type: 'options',
      default: 'send',
      noDataExpression: true,
      options: [
        { name: 'Send Message', value: 'send', action: 'Send a chat message' },
        {
          name: 'Send and Wait for Response',
          value: 'sendAndWait',
          action: 'Send a message and wait for the reply',
        },
      ],
    },
    {
      displayName: 'Message',
      name: 'message',
      type: 'string',
      required: true,
      default: '',
      typeOptions: { rows: 4 },
    },
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Add Memory Input Connection',
          name: 'memoryConnection',
          type: 'boolean',
          default: false,
        },
      ],
    },
  ],
};

/** the webhook path of every MCP Server Trigger hook: the node's `path` parameter, served verbatim */
const MCP_TRIGGER_PATH = '={{$parameter["path"]}}';

/**
 * P5-03: the MCP Server Trigger as nodes-ai serves it (McpTrigger.node.ts): a trigger with a Tools input
 * and no output; its hooks are the `mcp` URL family (`/mcp/<slug>/<path>`, `/mcp-test/<slug>/<path>`).
 */
const mcpTrigger: NodeTypeDescription = {
  name: 'ai.mcpTrigger',
  displayName: 'MCP Server Trigger',
  description: 'Expose workflow tools as an MCP Server endpoint',
  icon: 'lucide:server',
  group: ['trigger'],
  version: 1,
  defaults: { name: 'MCP Server Trigger' },
  inputs: [{ type: 'ai_tool', displayName: 'Tools' }],
  outputs: [],
  categories: ['AI', 'Triggers'],
  alias: ['mcp', 'model context protocol', 'mcp server', 'tools server'],
  activationMessage:
    'You can now connect your MCP Clients to the URL, using SSE or Streamable HTTP transports.',
  credentials: [
    { name: 'httpBearerAuth', required: true, displayOptions: { show: { authentication: ['bearerAuth'] } } },
    { name: 'httpHeaderAuth', required: true, displayOptions: { show: { authentication: ['headerAuth'] } } },
  ],
  webhooks: (
    [
      ['setup', 'GET'],
      ['default', 'POST'],
      ['sessionEnd', 'DELETE'],
    ] as const
  ).map(([name, httpMethod]) => ({
    name,
    httpMethod,
    path: MCP_TRIGGER_PATH,
    responseMode: 'onReceived',
    isFullPath: true,
    nodeType: 'mcp' as const,
  })),
  properties: [
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'none',
      description: 'How MCP clients prove who they are',
      options: [
        { name: 'None', value: 'none' },
        {
          name: 'Workspace sign-in',
          value: 'n8nOAuth2',
          description: 'MCP clients sign in with a workspace account (OAuth)',
        },
        { name: 'Bearer Auth', value: 'bearerAuth' },
        { name: 'Header Auth', value: 'headerAuth' },
      ],
    },
    {
      displayName: 'Require Workflow Execute Permission',
      name: 'requireExecuteAccess',
      type: 'boolean',
      default: true,
      description: 'Whether the signed-in user must be allowed to run this workflow',
      displayOptions: { show: { authentication: ['n8nOAuth2'] } },
    },
    {
      displayName: 'Include User in Output',
      name: 'includeUserInOutput',
      type: 'boolean',
      default: true,
      description: 'Whether the output item carries the signed-in user (id, email, first and last name)',
      displayOptions: { show: { authentication: ['n8nOAuth2'] } },
    },
    {
      displayName: 'Path',
      name: 'path',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'my-tools',
      description: 'The path of this MCP server, after /mcp/',
    },
    {
      displayName: 'Instructions',
      name: 'instructions',
      type: 'string',
      default: '',
      typeOptions: { rows: 4 },
      description: 'Sent to MCP clients when they connect: how and when to use these tools',
    },
  ],
};

/**
 * P5-16: the MCP Client node (main in, main out) as nodes-ai serves it in C0 (McpClient.node.ts). Its
 * properties come with lanes L12 and L13; it has no tool variant (`ai.mcpClientTool` is the sub-node).
 */
const mcpClient: NodeTypeDescription = {
  name: 'ai.mcpClient',
  displayName: 'MCP Client',
  description: 'Call a tool of a Model Context Protocol server',
  icon: 'lucide:plug',
  group: ['transform'],
  version: 1,
  defaults: { name: 'MCP Client' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['AI', 'Tools'],
  alias: ['mcp', 'model context protocol', 'call tool'],
  properties: [],
};

/** P5-02 demo dataset: the rows the Evaluation Trigger reads in the demo (a manual run gets the first) */
export const demoEvaluationRows: Array<Record<string, string>> = [
  { question: 'Where is my order 1042?', expected: 'Order 1042 shipped on Monday and arrives on Thursday.' },
  { question: 'Can I change my delivery address?', expected: 'Yes, until the order ships.' },
  { question: 'How do I return an item?', expected: 'Start a return from the orders page within 30 days.' },
];

/** The demo mapper starts with the required fields and lets the user add the rest (`addAllFields: false`). */
const demoMapperOptions: NonNullable<NonNullable<NodeProperty['typeOptions']>['resourceMapper']> = {
  resourceMapperMethod: 'getMappingFields',
  mode: 'upsert',
  valuesLabel: 'Values to send',
  fieldWords: { singular: 'column', plural: 'columns' },
  addAllFields: false,
  multiKeyMatch: true,
  supportAutoMap: true,
  noFieldsError: 'This table has no columns',
  showTypeConversionOptions: true,
};

/** P5-80: the resource mapper control's demo. `demoResourceMapping` answers its method. */
const resourceMapperDemo: NodeTypeDescription = {
  name: 'demo.resourceMapper',
  displayName: 'Resource Mapper Demo',
  description: 'Maps input values to the columns of a demo table',
  icon: 'lucide:columns-3',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Resource Mapper Demo' },
  inputs: ['main'],
  outputs: ['main'],
  categories: ['Demo'],
  properties: [
    {
      displayName: 'Table',
      name: 'table',
      type: 'options',
      default: 'contacts',
      options: [
        { name: 'Contacts', value: 'contacts' },
        { name: 'Deals', value: 'deals' },
        { name: 'Empty table', value: 'empty' },
      ],
    },
    {
      displayName: 'Columns',
      name: 'columns',
      type: 'resourceMapper',
      default: {
        mappingMode: 'defineBelow',
        value: null,
        matchingColumns: [],
        schema: [],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      typeOptions: {
        loadOptionsDependsOn: ['table'],
        resourceMapper: demoMapperOptions,
      },
    },
  ],
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
  formTrigger,
  form,
  dataTable,
  redisTrigger,
  crm,
  agent,
  chatModel,
  memory,
  calculator,
  httpRequestTool,
  slackHitlTool,
  evaluationTrigger,
  evaluation,
  executionData,
  timeSaved,
  chatTrigger,
  chat,
  mcpTrigger,
  mcpClient,
  resourceMapperDemo,
  kitchenSink,
];

/**
 * P6-50 (C0): the demo's `/projects/:projectId/available-types` rows that differ from "every type is available":
 * empty, so no type is blocked. mock-type-policies.ts (L5) answers from the policies it keeps.
 */
export const demoAvailableTypes: readonly AvailableType[] = [];

export const demoCredentialTypes: CredentialTypeDescription[] = [
  {
    name: 'redis',
    displayName: 'Redis',
    icon: 'simple:redis',
    properties: [
      { displayName: 'Host', name: 'host', type: 'string', default: 'localhost' },
      { displayName: 'Port', name: 'port', type: 'number', default: 6379 },
      {
        displayName: 'Password',
        name: 'password',
        type: 'string',
        default: '',
        typeOptions: { password: true },
      },
    ],
    hasAuthenticate: false,
    isOAuth2: false,
    isOAuth1: false,
  },
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
  {
    // P5-17: nodes-base http.credentials.ts; every row's value is a secret
    name: 'httpMultipleHeadersAuth',
    displayName: 'Multiple Headers Auth',
    icon: 'lucide:key-round',
    properties: [
      {
        displayName: 'Headers',
        name: 'headers',
        type: 'fixedCollection',
        default: { values: [] },
        placeholder: 'Add header',
        typeOptions: { multipleValues: true },
        options: [
          {
            displayName: 'Header',
            name: 'values',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '', placeholder: 'X-API-Key' },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                typeOptions: { password: true },
              },
            ],
          },
        ],
      },
    ],
    hasAuthenticate: true,
    isOAuth2: false,
    isOAuth1: false,
  },
  {
    // P5-18: nodes-ai ai.credentials.ts, resolved as GET /credential-types sends it (parent fields first)
    name: 'mcpOAuth2Api',
    displayName: 'MCP OAuth2 API',
    icon: 'lucide:key-square',
    extends: ['oAuth2Api'],
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
      {
        displayName: 'Register Client Automatically',
        name: 'useDynamicClientRegistration',
        type: 'boolean',
        default: true,
        description:
          'Whether to find the authorization server from the MCP server and register this app with it, instead of entering a client ID and URLs',
      },
      {
        displayName: 'Resource URL',
        name: 'resourceUrl',
        type: 'string',
        default: '',
        placeholder: 'https://mcp.example.com/mcp',
        description: 'The MCP server endpoint the token is for. Sent as the resource of every token request.',
      },
      { displayName: 'grantType', name: 'grantType', type: 'hidden', default: 'pkce' },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'body',
        options: [
          { name: 'Send as Basic Auth Header', value: 'header' },
          { name: 'Send Client Credentials in Body', value: 'body' },
        ],
      },
    ],
    hasAuthenticate: false,
    isOAuth2: true,
    isOAuth1: false,
  },
  {
    // P5-73: nodes-ai ai.credentials.ts, the Assistant's web search key (header X-Subscription-Token)
    name: 'braveSearchApi',
    displayName: 'Brave Search API',
    icon: 'lucide:search',
    documentationUrl: 'https://api-dashboard.search.brave.com/app/documentation/web-search/get-started',
    properties: [
      {
        displayName: 'API Key',
        name: 'apiKey',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { password: true },
      },
    ],
    hasAuthenticate: true,
    isOAuth2: false,
    isOAuth1: false,
    test: { request: { url: 'https://api.search.brave.com/res/v1/web/search', qs: { q: 'test' } } },
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

type ResourceMappingLoader = (params: Record<string, unknown>) => ResourceMapperFields;

const mapperField = (
  id: string,
  displayName: string,
  type: ResourceMapperField['type'],
  extra: Partial<ResourceMapperField> = {},
): ResourceMapperField => ({
  id,
  displayName,
  type,
  required: false,
  defaultMatch: false,
  display: true,
  ...extra,
});

/** POST /node-types/options, kind `resourceMapping`: the fields follow the node's `table` */
export const demoResourceMapping: Record<string, ResourceMappingLoader> = {
  getMappingFields: (params) => {
    if (params.table === 'empty') return { fields: [], emptyFieldsNotice: 'This table has no columns yet' };
    if (params.table === 'deals') {
      return {
        fields: [
          mapperField('id', 'ID', 'number', { defaultMatch: true, canBeUsedToMatch: true, readOnly: true }),
          mapperField('title', 'Title', 'string', { required: true }),
          mapperField('stage', 'Stage', 'options', {
            options: [
              { name: 'Lead', value: 'lead' },
              { name: 'Won', value: 'won' },
            ],
          }),
          mapperField('closesAt', 'Closes at', 'dateTime'),
        ],
      };
    }
    return {
      fields: [
        mapperField('email', 'Email', 'string', {
          required: true,
          defaultMatch: true,
          canBeUsedToMatch: true,
        }),
        mapperField('name', 'Name', 'string'),
        mapperField('age', 'Age', 'number'),
        mapperField('active', 'Active', 'boolean'),
        mapperField('notes', 'Notes', 'string', { display: false }),
      ],
    };
  },
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

/**
 * P6-03: the demo seed's projects (demo/install.ts). The workspace's team project is named after the workspace
 * (as migration 0022 backfills); every member has a personal project named after them. Seeded workflows and
 * credentials go to the team project.
 */
export const demoProjects = {
  team: {
    icon: { type: 'icon', value: 'layers' },
    description: 'Shared workflows and credentials of the operations team',
  },
  personal: { icon: null },
} as const satisfies Record<'team' | 'personal', { icon: ProjectIcon | null; description?: string }>;
