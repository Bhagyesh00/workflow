/**
 * Agent tools: Calculator, Code, HTTP Request, Call Workflow, Think and Vector Store.
 * Tool arguments come from the model and are treated as untrusted data: the calculator accepts
 * only arithmetic, code runs in the isolate with the arguments passed as JSON, and the HTTP tool
 * never lets the model pick the host of a request that carries credentials.
 */
import {
  type DataObject,
  evaluateSimple,
  getByPath,
  type HttpMethod,
  type HttpRequestOptions,
  type Item,
  type JsonSchema,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  type NodeTypeDescription,
  type SupplyDataContext,
} from '@workflow/workflow';
import { documentsToContext, getChatModel, getVectorStore } from '../../shared/ai-inputs';
import { parseJsonParameter } from '../../shared/json-schema';
import {
  createTool,
  inputSchemaProperties,
  QUERY_SCHEMA,
  toolDescriptionProperty,
  toolInputSchema,
  toolNameOf,
} from '../../shared/tools';
import {
  collectionList,
  errorMessage,
  fillTemplate,
  messageText,
  stringifyResult,
  truncate,
} from '../../shared/utils';
import { QA_PROMPT } from '../chains/rag-chains.nodes';

function toolDescriptionOf(
  base: Pick<NodeTypeDescription, 'name' | 'displayName' | 'description' | 'icon' | 'properties'> & {
    inputs?: NodeTypeDescription['inputs'];
    credentials?: NodeTypeDescription['credentials'];
    alias?: string[];
  },
): NodeTypeDescription {
  return {
    ...base,
    group: ['transform'],
    version: 1,
    defaults: { name: base.displayName },
    inputs: base.inputs ?? [],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    categories: ['AI', 'Tools'],
  };
}

function describe(ctx: SupplyDataContext, itemIndex: number, fallback: string): string {
  const value = String(ctx.getNodeParameter('toolDescription', itemIndex, '') ?? '').trim();
  return value || fallback;
}

// ---------------------------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------------------------

const MATH_NAMES = [
  'abs',
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'ceil',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'floor',
  'hypot',
  'log',
  'log10',
  'log1p',
  'log2',
  'max',
  'min',
  'pow',
  'round',
  'sign',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc',
] as const;
const MATH_CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  pi: Math.PI,
  E: Math.E,
  e: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  SQRT2: Math.SQRT2,
};
const MATH_SCOPE: Record<string, unknown> = {
  ...Object.fromEntries(MATH_NAMES.map((n) => [n, Math[n]])),
  ...MATH_CONSTANTS,
};
const NUMBER_LITERAL = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** Evaluate arithmetic only: numbers, + - * / % ^ **, parentheses and Math functions/constants. */
export function calculate(expression: string): number {
  const input = expression.trim();
  if (!input) throw new Error('The expression is empty');
  if (input.length > 1000) throw new Error('The expression is too long');
  if (!/^[0-9a-zA-Z_+\-*/%^().,\s]+$/.test(input)) {
    throw new Error('Only numbers, + - * / % ^, parentheses and math functions such as sqrt() are allowed');
  }
  const withoutNumbers = input.replace(NUMBER_LITERAL, ' ');
  for (const identifier of withoutNumbers.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/g) ??
    []) {
    const name = identifier.startsWith('Math.') ? identifier.slice(5) : identifier;
    if (!(name in MATH_SCOPE)) throw new Error(`Unknown name "${identifier}" in the expression`);
  }
  if (/\.\s*[A-Za-z_]/.test(withoutNumbers.replace(/Math\.[A-Za-z_]+/g, ' '))) {
    throw new Error('Property access is not allowed in the expression');
  }
  const source = input.replace(/Math\./g, '').replace(/\^/g, '**');
  // `0 + (...)`: a fully parenthesized top-level expression is mis-parsed by the expression
  // parser (it reports the closing parenthesis as unexpected), so keep the parentheses inner
  const result = evaluateSimple(`={{ 0 + (${source}) }}`, MATH_SCOPE, { maxSteps: 50_000, timeoutMs: 250 });
  if (typeof result !== 'number' || Number.isNaN(result))
    throw new Error('The expression did not produce a number');
  return result;
}

export const ToolCalculatorNode: NodeType = {
  description: toolDescriptionOf({
    name: 'ai.toolCalculator',
    displayName: 'Calculator',
    description: 'Lets the agent do exact arithmetic',
    icon: 'lucide:calculator',
    alias: ['math', 'arithmetic'],
    properties: [],
  }),
  async supplyData(ctx) {
    return {
      response: createTool(
        ctx,
        {
          name: toolNameOf(ctx),
          description:
            'Useful for getting the result of a math expression. The input must be a valid mathematical expression, e.g. "(12.5 * 4) / 3" or "sqrt(16) + 2^3".',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'The math expression to evaluate' } },
            required: ['input'],
          },
        },
        async (args) => String(calculate(String(args.input ?? args.query ?? ''))),
      ),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------------------------

const DEFAULT_TOOL_CODE =
  "// The model's input is available as `query` (a string, or an object when an input schema is set).\n// Return a string or any JSON value.\nreturn query.toUpperCase();\n";

/** Wrap tool code so the model's input is data (a parsed JSON string), never source code. */
export function wrapToolCode(code: string, input: unknown): string {
  const literal = JSON.stringify(JSON.stringify(input ?? null));
  return `const query = JSON.parse(${literal});\nconst __toolResult = await (async () => {\n${code}\n})();\nreturn { json: { result: __toolResult === undefined ? null : __toolResult } };`;
}

export const ToolCodeNode: NodeType = {
  description: toolDescriptionOf({
    name: 'ai.toolCode',
    displayName: 'Code Tool',
    description: 'Lets the agent run JavaScript you write, in the secure sandbox',
    icon: 'lucide:square-terminal',
    alias: ['javascript', 'function', 'custom tool'],
    properties: [
      toolDescriptionProperty('Call this tool to ...'),
      {
        displayName: 'JavaScript',
        name: 'jsCode',
        type: 'code',
        default: DEFAULT_TOOL_CODE,
        noDataExpression: true,
        typeOptions: { editor: 'codeNodeEditor', editorLanguage: 'javaScript', rows: 10 },
      },
      ...inputSchemaProperties,
    ],
  }),
  async supplyData(ctx, itemIndex) {
    const code = String(
      ctx.getNodeParameter('jsCode', itemIndex, DEFAULT_TOOL_CODE, { rawExpressions: true }),
    );
    const structured = Boolean(ctx.getNodeParameter('specifyInputSchema', itemIndex, false));
    let parameters: JsonSchema;
    try {
      parameters = toolInputSchema(ctx, itemIndex);
    } catch (error) {
      throw new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex });
    }
    return {
      response: createTool(
        ctx,
        { name: toolNameOf(ctx), description: describe(ctx, itemIndex, 'Runs custom code'), parameters },
        async (args) => {
          const input = structured ? args : args.query;
          const items = (await ctx.runCode({
            code: wrapToolCode(code, input),
            mode: 'runOnceForAllItems',
          })) as Item[];
          return items[0]?.json.result ?? null;
        },
      ),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP Request
// ---------------------------------------------------------------------------------------------

interface Placeholder {
  name: string;
  description?: string;
  type?: 'string' | 'number' | 'boolean' | 'json';
}

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export function findPlaceholders(...texts: unknown[]): string[] {
  const names = new Set<string>();
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const m of t.matchAll(PLACEHOLDER)) names.add(m[1]);
  }
  return [...names];
}

/** placeholders that occur in the scheme/host/port part of a URL template */
export function originPlaceholders(url: string): string[] {
  const schemeEnd = url.indexOf('://');
  const hostStart = schemeEnd >= 0 ? schemeEnd + 3 : 0;
  const pathStart = url.slice(hostStart).search(/[/?#]/);
  const origin = pathStart >= 0 ? url.slice(0, hostStart + pathStart) : url;
  return findPlaceholders(origin);
}

function substitute(template: string, values: DataObject, encode: (v: unknown) => string): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    name in values ? encode(values[name]) : match,
  );
}

export function fillUrl(template: string, values: DataObject): string {
  const origin = new Set(originPlaceholders(template));
  return template.replace(PLACEHOLDER, (match, name: string) => {
    if (!(name in values)) return match;
    const value = String(values[name] ?? '');
    return origin.has(name) ? value : encodeURIComponent(value);
  });
}

/** Fill a JSON body template: `"{x}"` becomes the typed JSON value, `{x}` inside a string its escaped text. */
export function fillJsonBody(template: string, values: DataObject): unknown {
  let text = template.replace(/"\{([a-zA-Z_][a-zA-Z0-9_]*)\}"/g, (match, name: string) =>
    name in values ? JSON.stringify(values[name] ?? null) : match,
  );
  text = substitute(text, values, (v) =>
    typeof v === 'string' ? JSON.stringify(v).slice(1, -1) : JSON.stringify(v ?? null),
  );
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The request body is not valid JSON after filling placeholders: ${errorMessage(error)}`);
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function pickFields(value: unknown, mode: string, fields: string[]): unknown {
  if (mode === 'all' || !fields.length) return value;
  const apply = (obj: unknown): unknown => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    if (mode === 'selected') {
      const out: DataObject = {};
      for (const f of fields) {
        const v = getByPath(obj, f);
        if (v !== undefined) out[f] = v;
      }
      return out;
    }
    const out: DataObject = { ...(obj as DataObject) };
    for (const f of fields) delete out[f];
    return out;
  };
  return Array.isArray(value) ? value.map(apply) : apply(value);
}

export function optimizeResponse(body: unknown, options: DataObject): string {
  const maxLength = Math.max(100, Number(options.maxLength ?? 10_000));
  const type = String(options.responseType ?? 'json');
  if (type === 'html' && typeof body === 'string') return truncate(htmlToText(body), maxLength);
  if (type === 'text') return truncate(typeof body === 'string' ? body : stringifyResult(body), maxLength);
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return truncate(value as string, maxLength);
    }
  }
  const fields = String(options.fields ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  return truncate(
    stringifyResult(pickFields(value, String(options.fieldsToInclude ?? 'all'), fields)),
    maxLength,
  );
}

const keyValueCollection = (
  displayName: string,
  name: string,
  show: Record<string, unknown[]>,
): NodeProperty => ({
  displayName,
  name,
  type: 'fixedCollection',
  default: {},
  typeOptions: { multipleValues: true },
  displayOptions: { show },
  description: 'Values may contain {placeholders} that the model fills',
  options: [
    {
      displayName: 'Parameter',
      name: 'parameters',
      values: [
        { displayName: 'Name', name: 'name', type: 'string', default: '' },
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
      ],
    },
  ],
});

const GENERIC_AUTH = ['httpBasicAuth', 'httpHeaderAuth', 'httpBearerAuth'];

export const ToolHttpRequestNode: NodeType = {
  description: toolDescriptionOf({
    name: 'ai.toolHttpRequest',
    displayName: 'HTTP Request Tool',
    description: 'Lets the agent call an API; the model fills the {placeholders} you define',
    icon: 'lucide:globe',
    alias: ['api', 'rest', 'fetch', 'web'],
    credentials: GENERIC_AUTH.map((name) => ({
      name,
      required: true,
      displayOptions: { show: { authentication: ['genericCredentialType'], genericAuthType: [name] } },
    })),
    properties: [
      toolDescriptionProperty('e.g. Get the current weather for a city'),
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
        placeholder: 'https://api.example.com/cities/{city}/weather',
        description: 'Use {name} for values the model provides',
      },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        options: [
          { name: 'None', value: 'none' },
          {
            name: 'Generic Credential Type',
            value: 'genericCredentialType',
            description: 'Basic, header or bearer auth',
          },
          {
            name: 'Predefined Credential Type',
            value: 'predefinedCredentialType',
            description: 'Credentials of an app integration',
          },
        ],
      },
      {
        displayName: 'Generic Auth Type',
        name: 'genericAuthType',
        type: 'options',
        default: 'httpHeaderAuth',
        displayOptions: { show: { authentication: ['genericCredentialType'] } },
        options: [
          { name: 'Basic Auth', value: 'httpBasicAuth' },
          { name: 'Header Auth', value: 'httpHeaderAuth' },
          { name: 'Bearer Auth', value: 'httpBearerAuth' },
        ],
      },
      {
        displayName: 'Credential Type',
        name: 'nodeCredentialType',
        type: 'string',
        default: '',
        placeholder: 'e.g. openAiApi',
        displayOptions: { show: { authentication: ['predefinedCredentialType'] } },
      },
      { displayName: 'Send Query Parameters', name: 'sendQuery', type: 'boolean', default: false },
      keyValueCollection('Query Parameters', 'queryParameters', { sendQuery: [true] }),
      { displayName: 'Send Headers', name: 'sendHeaders', type: 'boolean', default: false },
      keyValueCollection('Headers', 'headerParameters', { sendHeaders: [true] }),
      {
        displayName: 'Send Body',
        name: 'sendBody',
        type: 'boolean',
        default: false,
        displayOptions: { show: { method: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
      },
      {
        displayName: 'Body Content Type',
        name: 'bodyContentType',
        type: 'options',
        default: 'json',
        displayOptions: { show: { sendBody: [true] } },
        options: [
          { name: 'JSON', value: 'json' },
          { name: 'Form URL-Encoded', value: 'form' },
        ],
      },
      {
        displayName: 'JSON Body',
        name: 'jsonBody',
        type: 'json',
        default: '{\n  "query": "{query}"\n}',
        displayOptions: { show: { sendBody: [true], bodyContentType: ['json'] } },
        description: '"{name}" in quotes is replaced by the typed value',
      },
      keyValueCollection('Body Parameters', 'bodyParameters', {
        sendBody: [true],
        bodyContentType: ['form'],
      }),
      {
        displayName: 'Placeholder Definitions',
        name: 'placeholderDefinitions',
        type: 'fixedCollection',
        default: {},
        typeOptions: { multipleValues: true },
        description: 'Describe each placeholder so the model fills it correctly',
        options: [
          {
            displayName: 'Placeholder',
            name: 'values',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Description', name: 'description', type: 'string', default: '' },
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                default: 'string',
                options: ['string', 'number', 'boolean', 'json'].map((t) => ({ name: t, value: t })),
              },
            ],
          },
        ],
      },
      {
        displayName: 'Optimize Response',
        name: 'optimizeResponse',
        type: 'boolean',
        default: false,
        description: 'Whether to shrink the response before the model reads it (saves tokens)',
      },
      {
        displayName: 'Response Optimization',
        name: 'optimizeOptions',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { optimizeResponse: [true] } },
        options: [
          {
            displayName: 'Expected Response Type',
            name: 'responseType',
            type: 'options',
            default: 'json',
            options: [
              { name: 'JSON', value: 'json' },
              { name: 'HTML (Extract Text)', value: 'html' },
              { name: 'Text', value: 'text' },
            ],
          },
          {
            displayName: 'Include Fields',
            name: 'fieldsToInclude',
            type: 'options',
            default: 'all',
            options: [
              { name: 'All', value: 'all' },
              { name: 'Selected', value: 'selected' },
              { name: 'All Except', value: 'except' },
            ],
          },
          {
            displayName: 'Fields',
            name: 'fields',
            type: 'string',
            default: '',
            placeholder: 'id, name, address.city',
          },
          { displayName: 'Max Length', name: 'maxLength', type: 'number', default: 10_000 },
        ],
      },
    ],
  }),
  async supplyData(ctx, itemIndex) {
    const node = ctx.getNode();
    const fail = (message: string) => new NodeOperationError(node, message, { itemIndex });
    const url = String(ctx.getNodeParameter('url', itemIndex, '') ?? '').trim();
    if (!url) throw fail('Enter the URL');
    const method = String(ctx.getNodeParameter('method', itemIndex, 'GET')) as HttpMethod;
    const authentication = String(ctx.getNodeParameter('authentication', itemIndex, 'none'));
    const pairs = (name: string, enabled: string) =>
      ctx.getNodeParameter(enabled, itemIndex, false)
        ? collectionList<{ name: string; value: string }>(
            ctx.getNodeParameter(name, itemIndex, {}),
            'parameters',
          ).filter((p) => p.name)
        : [];
    const query = pairs('queryParameters', 'sendQuery');
    const headers = pairs('headerParameters', 'sendHeaders');
    const sendBody = method !== 'GET' && Boolean(ctx.getNodeParameter('sendBody', itemIndex, false));
    const bodyType = String(ctx.getNodeParameter('bodyContentType', itemIndex, 'json'));
    const bodyValue =
      sendBody && bodyType === 'json' ? ctx.getNodeParameter('jsonBody', itemIndex, '{}') : undefined;
    const jsonBody =
      bodyValue === undefined
        ? undefined
        : typeof bodyValue === 'string'
          ? bodyValue
          : JSON.stringify(bodyValue);
    const form = sendBody && bodyType === 'form' ? pairs('bodyParameters', 'sendBody') : [];

    const names = findPlaceholders(
      url,
      ...query.map((p) => p.value),
      ...headers.map((p) => p.value),
      jsonBody,
      ...form.map((p) => p.value),
    );
    if (authentication !== 'none' && originPlaceholders(url).length) {
      throw fail(
        'The model cannot choose the host of a request that sends credentials. Remove placeholders from the scheme, host and port of the URL.',
      );
    }
    const definitions = new Map(
      collectionList<Placeholder>(
        ctx.getNodeParameter('placeholderDefinitions', itemIndex, {}),
        'values',
      ).map((p) => [p.name, p]),
    );
    const typeMap: Record<string, JsonSchema> = {
      string: { type: 'string' },
      number: { type: 'number' },
      boolean: { type: 'boolean' },
      json: {},
    };
    const parameters: JsonSchema = {
      type: 'object',
      properties: Object.fromEntries(
        names.map((n) => {
          const def = definitions.get(n);
          return [
            n,
            {
              ...typeMap[def?.type ?? 'string'],
              ...(def?.description ? { description: def.description } : {}),
            },
          ];
        }),
      ),
      required: names,
    };
    const optimize = Boolean(ctx.getNodeParameter('optimizeResponse', itemIndex, false));
    const optimizeOptions = ctx.getNodeParameter('optimizeOptions', itemIndex, {}) as DataObject;
    const credentialType =
      authentication === 'genericCredentialType'
        ? String(ctx.getNodeParameter('genericAuthType', itemIndex, 'httpHeaderAuth'))
        : authentication === 'predefinedCredentialType'
          ? String(ctx.getNodeParameter('nodeCredentialType', itemIndex, ''))
          : undefined;
    if (authentication === 'predefinedCredentialType' && !credentialType)
      throw fail('Enter the credential type');

    const send = async (request: HttpRequestOptions): Promise<unknown> => {
      if (!credentialType) return ctx.helpers.httpRequest(request);
      if (authentication === 'genericCredentialType')
        return ctx.helpers.httpRequest(await withGenericAuth(ctx, credentialType, request, itemIndex));
      return ctx.helpers.httpRequestWithAuthentication(credentialType, request, itemIndex);
    };

    return {
      response: createTool(
        ctx,
        {
          name: toolNameOf(ctx),
          description: describe(ctx, itemIndex, `Sends a ${method} request to ${url}`),
          parameters,
        },
        async (args) => {
          const values = args as DataObject;
          const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
          const finalUrl = fillUrl(url, values);
          if (!/^https?:\/\//i.test(finalUrl)) throw new Error('The URL must start with http:// or https://');
          const request: HttpRequestOptions = {
            url: finalUrl,
            method,
            qs: Object.fromEntries(query.map((p) => [p.name, substitute(p.value, values, asText)])),
            headers: Object.fromEntries(
              headers.map((p) => [
                p.name.toLowerCase(),
                substitute(p.value, values, asText).replace(/[\r\n]/g, ' '),
              ]),
            ),
            responseType: 'auto',
          };
          if (jsonBody !== undefined) request.body = fillJsonBody(jsonBody, values);
          if (form.length) {
            request.body = Object.fromEntries(form.map((p) => [p.name, substitute(p.value, values, asText)]));
            request.bodyType = 'form-urlencoded';
          }
          const body = await send(request);
          return optimize ? optimizeResponse(body, optimizeOptions) : body;
        },
      ),
    };
  },
};

/** Generic auth credentials (basic / header / bearer) applied without needing the types registered here. */
export async function withGenericAuth(
  ctx: SupplyDataContext,
  type: string,
  request: HttpRequestOptions,
  itemIndex: number,
): Promise<HttpRequestOptions> {
  const creds = await ctx.getCredentials(type, itemIndex);
  const headers = { ...(request.headers ?? {}) };
  if (type === 'httpBasicAuth') {
    return {
      ...request,
      auth: { username: String(creds.user ?? creds.username ?? ''), password: String(creds.password ?? '') },
    };
  }
  if (type === 'httpHeaderAuth') {
    if (!creds.name) throw new Error('The header auth credential has no header name');
    headers[String(creds.name).toLowerCase()] = String(creds.value ?? '');
  } else if (type === 'httpBearerAuth') {
    headers.authorization = `Bearer ${String(creds.token ?? '')}`;
  } else {
    throw new Error(`Unsupported generic auth type "${type}"`);
  }
  return { ...request, headers };
}

// ---------------------------------------------------------------------------------------------
// Call Workflow
// ---------------------------------------------------------------------------------------------

export const ToolWorkflowNode: NodeType = {
  description: toolDescriptionOf({
    name: 'ai.toolWorkflow',
    displayName: 'Call Workflow Tool',
    description: 'Lets the agent run another workflow with the arguments it chooses',
    icon: 'lucide:workflow',
    alias: ['sub-workflow', 'execute workflow'],
    properties: [
      toolDescriptionProperty('Call this tool to ...'),
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        default: 'database',
        options: [
          { name: 'Workflow From This Workspace', value: 'database' },
          { name: 'Define Below (JSON)', value: 'parameter' },
        ],
      },
      {
        displayName: 'Workflow ID',
        name: 'workflowId',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { source: ['database'] } },
      },
      {
        displayName: 'Workflow JSON',
        name: 'workflowJson',
        type: 'json',
        default: '{\n  "name": "Tool workflow",\n  "nodes": [],\n  "connections": {}\n}',
        typeOptions: { rows: 10 },
        displayOptions: { show: { source: ['parameter'] } },
      },
      {
        displayName: 'Field to Return',
        name: 'responsePropertyName',
        type: 'string',
        default: 'response',
        description:
          'Field of the last node output returned to the model; when missing, the whole output is returned',
      },
      ...inputSchemaProperties,
    ],
  }),
  async supplyData(ctx, itemIndex) {
    const source = String(ctx.getNodeParameter('source', itemIndex, 'database'));
    const structured = Boolean(ctx.getNodeParameter('specifyInputSchema', itemIndex, false));
    let parameters: JsonSchema;
    let workflow: DataObject | undefined;
    try {
      parameters = toolInputSchema(ctx, itemIndex);
      if (source === 'parameter')
        workflow = parseJsonParameter(
          ctx.getNodeParameter('workflowJson', itemIndex, '{}'),
          'Workflow JSON',
        ) as DataObject;
    } catch (error) {
      throw new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex });
    }
    const workflowId = String(ctx.getNodeParameter('workflowId', itemIndex, '') ?? '').trim();
    if (source === 'database' && !workflowId)
      throw new NodeOperationError(ctx.getNode(), 'Enter the workflow ID', { itemIndex });
    const field = String(ctx.getNodeParameter('responsePropertyName', itemIndex, 'response') ?? '');
    return {
      response: createTool(
        ctx,
        { name: toolNameOf(ctx), description: describe(ctx, itemIndex, 'Runs a workflow'), parameters },
        async (args) => {
          const json = structured ? args : { query: args.query };
          const result = await ctx.executeWorkflow(
            source === 'parameter'
              ? { source: 'parameter', workflow: workflow as never }
              : { source: 'database', workflowId },
            [{ json }],
          );
          const items = result.data?.[0] ?? [];
          if (!items.length) return 'The workflow finished without returning data';
          const outputs = items.map((i) => (field && field in i.json ? i.json[field] : i.json));
          return outputs.length === 1 ? outputs[0] : outputs;
        },
      ),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Think
// ---------------------------------------------------------------------------------------------

const THINK_DESCRIPTION =
  'Use the tool to think about something. It will not obtain new information or change anything; it only records the thought. Use it when complex reasoning or a scratchpad is needed.';

export const ToolThinkNode: NodeType = {
  description: toolDescriptionOf({
    name: 'ai.toolThink',
    displayName: 'Think Tool',
    description: 'Gives the agent a scratchpad to reason before acting',
    icon: 'lucide:lightbulb',
    alias: ['reason', 'scratchpad', 'plan'],
    properties: [{ ...toolDescriptionProperty(''), default: THINK_DESCRIPTION, required: false }],
  }),
  async supplyData(ctx, itemIndex) {
    return {
      response: createTool(
        ctx,
        {
          name: toolNameOf(ctx),
          description: describe(ctx, itemIndex, THINK_DESCRIPTION),
          parameters: {
            type: 'object',
            properties: { thought: { type: 'string', description: 'Your thought' } },
            required: ['thought'],
          },
        },
        async (args) => String(args.thought ?? ''),
      ),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Vector Store Q&A
// ---------------------------------------------------------------------------------------------

export const ToolVectorStoreNode: NodeType = {
  description: toolDescriptionOf({
    name: 'ai.toolVectorStore',
    displayName: 'Vector Store Question Answer Tool',
    description: 'Lets the agent answer questions from a vector store',
    icon: 'lucide:database-search',
    alias: ['rag', 'knowledge base', 'retrieval'],
    inputs: [
      { type: 'ai_vectorStore', displayName: 'Vector Store', required: true, maxConnections: 1 },
      { type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 },
    ],
    properties: [
      toolDescriptionProperty('e.g. Answers questions about our product documentation'),
      {
        displayName: 'Limit',
        name: 'topK',
        type: 'number',
        default: 4,
        typeOptions: { minValue: 1, maxValue: 100 },
        description: 'Number of documents used to answer',
      },
    ],
  }),
  async supplyData(ctx, itemIndex) {
    const store = (await getVectorStore(ctx, itemIndex))!;
    const model = await getChatModel(ctx, itemIndex);
    const topK = Number(ctx.getNodeParameter('topK', itemIndex, 4));
    return {
      response: createTool(
        ctx,
        {
          name: toolNameOf(ctx),
          description: describe(ctx, itemIndex, 'Answers questions from a knowledge base'),
          parameters: QUERY_SCHEMA,
        },
        async (args) => {
          const question = String(args.query ?? '');
          const documents = (await store.similaritySearch(question, topK)).map((r) => r.document);
          const response = await model.chat({
            messages: [
              {
                role: 'system',
                content: fillTemplate(QA_PROMPT, { context: documentsToContext(documents) }),
              },
              { role: 'user', content: question },
            ],
            signal: ctx.signal,
          });
          return messageText(response.message.content);
        },
      ),
    };
  },
};

export const toolNodes: NodeType[] = [
  ToolCalculatorNode,
  ToolCodeNode,
  ToolHttpRequestNode,
  ToolWorkflowNode,
  ToolThinkNode,
  ToolVectorStoreNode,
];
