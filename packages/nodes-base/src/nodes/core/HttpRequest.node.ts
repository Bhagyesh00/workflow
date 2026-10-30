/**
 * HTTP Request: call any API. All traffic goes through the SSRF-guarded helpers.
 *
 * Pagination parameters may reference `$response` (the last response: body, headers,
 * statusCode), `$pageCount` (pages fetched so far), `$request` and `$json`. They are evaluated
 * with the sandboxed expression interpreter against those values only; response data is passed
 * as values and never parsed as an expression.
 */
import { createHash } from 'node:crypto';
import {
  type DataObject,
  type ExecuteContext,
  evaluateSimple,
  type HttpFullResponse,
  type HttpMethod,
  type HttpRequestOptions,
  type Item,
  isExpression,
  isPlainObject,
  NodeApiError,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  sleep,
} from '@workflow/workflow';
import { authCredentialDescriptions, authenticatedRequest, authProperties } from '../../utils/http';
import {
  chunk,
  errorItem,
  keyValuePairs,
  parseJsonObject,
  parseJsonParameter,
  stableStringify,
  withItemIndex,
} from '../../utils/utilities';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
/** hard stop for pagination without a page limit */
export const MAX_PAGES = 10_000;

function nameValueCollection(
  name: string,
  displayName: string,
  show: Record<string, unknown[]>,
): NodeProperty {
  return {
    displayName,
    name,
    type: 'fixedCollection',
    default: { parameters: [{ name: '', value: '' }] },
    placeholder: 'Add parameter',
    typeOptions: { multipleValues: true },
    displayOptions: { show },
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
  };
}

const specifyOptions = (what: string): NodeProperty['options'] => [
  { name: 'Using Fields Below', value: 'keypair' },
  { name: 'Using JSON', value: 'json', description: `Write the ${what} as a JSON object` },
];

export const HttpRequestNode: NodeType = {
  description: {
    name: 'core.httpRequest',
    displayName: 'HTTP Request',
    description: 'Call any REST API or web page',
    icon: 'lucide:globe',
    iconColor: '#0004f5',
    group: ['output'],
    version: 1,
    defaults: { name: 'HTTP Request' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['api', 'rest', 'fetch', 'curl', 'request', 'webhook', 'url', 'http', 'call'],
    subtitle: '={{ ($parameter.method || "GET") + ": " + ($parameter.url || "") }}',
    usableAsTool: true,
    credentials: authCredentialDescriptions,
    properties: [
      {
        displayName: 'Method',
        name: 'method',
        type: 'options',
        default: 'GET',
        options: METHODS.map((m) => ({ name: m, value: m })),
      },
      {
        displayName: 'URL',
        name: 'url',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://api.example.com/v1/orders',
      },
      ...authProperties,
      {
        displayName: 'Send Query Parameters',
        name: 'sendQuery',
        type: 'boolean',
        default: false,
        noDataExpression: true,
      },
      {
        displayName: 'Specify Query Parameters',
        name: 'specifyQuery',
        type: 'options',
        default: 'keypair',
        options: specifyOptions('query'),
        displayOptions: { show: { sendQuery: [true] } },
      },
      nameValueCollection('queryParameters', 'Query Parameters', {
        sendQuery: [true],
        specifyQuery: ['keypair'],
      }),
      {
        displayName: 'JSON',
        name: 'jsonQuery',
        type: 'json',
        default: '{}',
        displayOptions: { show: { sendQuery: [true], specifyQuery: ['json'] } },
      },
      {
        displayName: 'Send Headers',
        name: 'sendHeaders',
        type: 'boolean',
        default: false,
        noDataExpression: true,
      },
      {
        displayName: 'Specify Headers',
        name: 'specifyHeaders',
        type: 'options',
        default: 'keypair',
        options: specifyOptions('headers'),
        displayOptions: { show: { sendHeaders: [true] } },
      },
      nameValueCollection('headerParameters', 'Header Parameters', {
        sendHeaders: [true],
        specifyHeaders: ['keypair'],
      }),
      {
        displayName: 'JSON',
        name: 'jsonHeaders',
        type: 'json',
        default: '{}',
        displayOptions: { show: { sendHeaders: [true], specifyHeaders: ['json'] } },
      },
      {
        displayName: 'Send Body',
        name: 'sendBody',
        type: 'boolean',
        default: false,
        noDataExpression: true,
      },
      {
        displayName: 'Body Content Type',
        name: 'contentType',
        type: 'options',
        default: 'json',
        displayOptions: { show: { sendBody: [true] } },
        options: [
          { name: 'JSON', value: 'json' },
          { name: 'Form Urlencoded', value: 'form-urlencoded' },
          {
            name: 'Form-Data (Multipart)',
            value: 'multipart-form-data',
            description: 'Fields and file uploads',
          },
          { name: 'Raw', value: 'raw', description: 'Text with a content type of your choice' },
          { name: 'Binary File', value: 'binaryData', description: 'Send a file of the item as the body' },
        ],
      },
      {
        displayName: 'Specify Body',
        name: 'specifyBody',
        type: 'options',
        default: 'keypair',
        options: specifyOptions('body'),
        displayOptions: { show: { sendBody: [true], contentType: ['json', 'form-urlencoded'] } },
      },
      {
        displayName: 'Body Parameters',
        name: 'bodyParameters',
        type: 'fixedCollection',
        default: { parameters: [{ name: '', value: '' }] },
        placeholder: 'Add parameter',
        typeOptions: { multipleValues: true },
        displayOptions: {
          show: { sendBody: [true], contentType: ['json', 'form-urlencoded', 'multipart-form-data'] },
          hide: { specifyBody: ['json'] },
        },
        options: [
          {
            displayName: 'Parameter',
            name: 'parameters',
            values: [
              {
                displayName: 'Parameter Type',
                name: 'parameterType',
                type: 'options',
                default: 'formData',
                displayOptions: { show: { '/contentType': ['multipart-form-data'] } },
                options: [
                  { name: 'Form Data', value: 'formData' },
                  { name: 'File (Binary)', value: 'formBinaryData' },
                ],
              },
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                displayOptions: { hide: { parameterType: ['formBinaryData'] } },
              },
              {
                displayName: 'Input Binary Field',
                name: 'inputDataFieldName',
                type: 'string',
                default: 'data',
                displayOptions: { show: { parameterType: ['formBinaryData'] } },
              },
            ],
          },
        ],
      },
      {
        displayName: 'JSON',
        name: 'jsonBody',
        type: 'json',
        default: '{}',
        typeOptions: { rows: 6 },
        displayOptions: {
          show: { sendBody: [true], contentType: ['json', 'form-urlencoded'], specifyBody: ['json'] },
        },
      },
      {
        displayName: 'Content Type',
        name: 'rawContentType',
        type: 'string',
        default: 'text/plain',
        placeholder: 'text/xml',
        displayOptions: { show: { sendBody: [true], contentType: ['raw'] } },
      },
      {
        displayName: 'Body',
        name: 'body',
        type: 'string',
        default: '',
        typeOptions: { rows: 6 },
        displayOptions: { show: { sendBody: [true], contentType: ['raw'] } },
      },
      {
        displayName: 'Input Binary Field',
        name: 'inputDataFieldName',
        type: 'string',
        default: 'data',
        displayOptions: { show: { sendBody: [true], contentType: ['binaryData'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Batching',
            name: 'batching',
            type: 'fixedCollection',
            default: { batch: { batchSize: 50, batchInterval: 1000 } },
            placeholder: 'Add batching',
            options: [
              {
                displayName: 'Batching',
                name: 'batch',
                values: [
                  {
                    displayName: 'Items per Batch',
                    name: 'batchSize',
                    type: 'number',
                    default: 50,
                    typeOptions: { minValue: 1 },
                    description: 'Requests of one batch are sent in parallel',
                  },
                  {
                    displayName: 'Batch Interval (Ms)',
                    name: 'batchInterval',
                    type: 'number',
                    default: 1000,
                    typeOptions: { minValue: 0 },
                    description: 'Pause between batches',
                  },
                ],
              },
            ],
          },
          {
            displayName: 'Ignore SSL Issues (Insecure)',
            name: 'allowUnauthorizedCerts',
            type: 'boolean',
            default: false,
            description: 'Whether to accept invalid or self-signed certificates',
          },
          {
            displayName: 'Send Idempotency Key',
            name: 'idempotencyKey',
            type: 'boolean',
            default: false,
            description:
              'Whether to add an Idempotency-Key header that stays the same when this request is retried (retry on fail or retry from the failed node), so APIs that support it never apply the same request twice',
          },
          {
            displayName: 'Pagination',
            name: 'pagination',
            type: 'fixedCollection',
            default: { pagination: { paginationMode: 'updateAParameterInEachRequest' } },
            placeholder: 'Add pagination',
            options: [
              {
                displayName: 'Pagination',
                name: 'pagination',
                values: [
                  {
                    displayName: 'Pagination Mode',
                    name: 'paginationMode',
                    type: 'options',
                    default: 'updateAParameterInEachRequest',
                    options: [
                      { name: 'Off', value: 'off' },
                      { name: 'Update a Parameter in Each Request', value: 'updateAParameterInEachRequest' },
                      { name: 'Response Contains Next URL', value: 'responseContainsNextURL' },
                    ],
                  },
                  {
                    displayName: 'Next URL',
                    name: 'nextURL',
                    type: 'string',
                    default: '',
                    placeholder: '={{ $response.body.next }}',
                    description: 'Expression using $response, e.g. {{ $response.body.links.next }}',
                    displayOptions: { show: { paginationMode: ['responseContainsNextURL'] } },
                  },
                  {
                    displayName: 'Parameters',
                    name: 'parameters',
                    type: 'fixedCollection',
                    default: { parameters: [{ type: 'qs', name: '', value: '' }] },
                    placeholder: 'Add parameter',
                    typeOptions: { multipleValues: true },
                    displayOptions: { show: { paginationMode: ['updateAParameterInEachRequest'] } },
                    options: [
                      {
                        displayName: 'Parameter',
                        name: 'parameters',
                        values: [
                          {
                            displayName: 'Type',
                            name: 'type',
                            type: 'options',
                            default: 'qs',
                            options: [
                              { name: 'Query', value: 'qs' },
                              { name: 'Body', value: 'body' },
                              { name: 'Headers', value: 'headers' },
                            ],
                          },
                          {
                            displayName: 'Name',
                            name: 'name',
                            type: 'string',
                            default: '',
                            placeholder: 'page',
                          },
                          {
                            displayName: 'Value',
                            name: 'value',
                            type: 'string',
                            default: '',
                            placeholder: '={{ $pageCount + 1 }}',
                            description: 'Expression using $pageCount and $response',
                          },
                        ],
                      },
                    ],
                  },
                  {
                    displayName: 'Pagination Complete When',
                    name: 'paginationCompleteWhen',
                    type: 'options',
                    default: 'responseIsEmpty',
                    options: [
                      { name: 'Response Is Empty', value: 'responseIsEmpty' },
                      { name: 'Receive Specific Status Codes', value: 'receiveSpecificStatusCodes' },
                      { name: 'Other', value: 'other', description: 'An expression returns true' },
                    ],
                  },
                  {
                    displayName: 'Status Code(s) When Complete',
                    name: 'statusCodesWhenComplete',
                    type: 'string',
                    default: '',
                    placeholder: '404, 410',
                    displayOptions: { show: { paginationCompleteWhen: ['receiveSpecificStatusCodes'] } },
                  },
                  {
                    displayName: 'Complete Expression',
                    name: 'completeExpression',
                    type: 'string',
                    default: '',
                    placeholder: '={{ !$response.body.has_more }}',
                    displayOptions: { show: { paginationCompleteWhen: ['other'] } },
                  },
                  {
                    displayName: 'Limit Pages Fetched',
                    name: 'limitPagesFetched',
                    type: 'boolean',
                    default: false,
                  },
                  {
                    displayName: 'Max Pages',
                    name: 'maxRequests',
                    type: 'number',
                    default: 100,
                    typeOptions: { minValue: 1 },
                    displayOptions: { show: { limitPagesFetched: [true] } },
                  },
                  {
                    displayName: 'Interval Between Requests (Ms)',
                    name: 'requestInterval',
                    type: 'number',
                    default: 0,
                    typeOptions: { minValue: 0 },
                  },
                ],
              },
            ],
          },
          {
            displayName: 'Redirects',
            name: 'redirect',
            type: 'fixedCollection',
            default: { redirect: { followRedirects: true } },
            options: [
              {
                displayName: 'Redirect',
                name: 'redirect',
                values: [
                  {
                    displayName: 'Follow Redirects',
                    name: 'followRedirects',
                    type: 'boolean',
                    default: true,
                    description:
                      'Whether to follow 3xx redirects (every hop is checked against the SSRF policy)',
                  },
                ],
              },
            ],
          },
          {
            displayName: 'Response',
            name: 'response',
            type: 'fixedCollection',
            default: { response: { responseFormat: 'autodetect' } },
            options: [
              {
                displayName: 'Response',
                name: 'response',
                values: [
                  {
                    displayName: 'Include Response Headers and Status',
                    name: 'fullResponse',
                    type: 'boolean',
                    default: false,
                  },
                  {
                    displayName: 'Never Error',
                    name: 'neverError',
                    type: 'boolean',
                    default: false,
                    description: 'Whether to succeed even when the status code is not 2xx',
                  },
                  {
                    displayName: 'Response Format',
                    name: 'responseFormat',
                    type: 'options',
                    default: 'autodetect',
                    options: [
                      { name: 'Autodetect', value: 'autodetect' },
                      { name: 'JSON', value: 'json' },
                      { name: 'Text', value: 'text' },
                      { name: 'File', value: 'file' },
                    ],
                  },
                  {
                    displayName: 'Put Output in Field',
                    name: 'outputPropertyName',
                    type: 'string',
                    default: 'data',
                    description: 'Field (text) or binary property (file) that receives the response',
                  },
                ],
              },
            ],
          },
          {
            displayName: 'Timeout',
            name: 'timeout',
            type: 'number',
            default: 10000,
            typeOptions: { minValue: 1 },
            description: 'Milliseconds to wait for the server before aborting',
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const batch = ctx.getNodeParameter('options.batching.batch', 0, {}) as DataObject;
    const batchSize = Number(batch.batchSize ?? 0) > 0 ? Math.floor(Number(batch.batchSize)) : 1;
    const batchInterval = Math.max(0, Number(batch.batchInterval ?? 0));
    const batched = Object.keys(batch).length > 0;

    const results: Item[][] = new Array(items.length);
    const indices = items.map((_, i) => i);
    const groups = chunk(indices, batchSize);
    for (let g = 0; g < groups.length; g++) {
      if (g > 0 && batched && batchInterval) await sleep(batchInterval, ctx.signal);
      await Promise.all(
        groups[g].map(async (i) => {
          try {
            results[i] = await requestForItem(ctx, i, items[i]);
          } catch (error) {
            if (!ctx.continueOnFail()) throw withItemIndex(ctx, error, i);
            results[i] = [errorItem(error, i)];
          }
        }),
      );
    }
    return [results.flat()];
  },
};

// ---------------------------------------------------------------------------------------------

interface ResponseOptions {
  fullResponse: boolean;
  neverError: boolean;
  format: 'autodetect' | 'json' | 'text' | 'file';
  property: string;
}

interface PaginationConfig {
  paginationMode?: unknown;
  nextURL?: unknown;
  parameters?: { parameters?: Array<{ type?: unknown; name?: unknown; value?: unknown }> };
  paginationCompleteWhen?: unknown;
  statusCodesWhenComplete?: unknown;
  completeExpression?: unknown;
  limitPagesFetched?: unknown;
  maxRequests?: unknown;
  requestInterval?: unknown;
}

function buildRequest(ctx: ExecuteContext, i: number): HttpRequestOptions & { bodyIsBinary?: boolean } {
  const method = String(ctx.getNodeParameter('method', i, 'GET')).toUpperCase() as HttpMethod;
  if (!METHODS.includes(method)) {
    throw new NodeOperationError(ctx.getNode(), `Unsupported HTTP method "${method}"`, { itemIndex: i });
  }
  const url = String(ctx.getNodeParameter('url', i, '') ?? '').trim();
  if (!url)
    throw new NodeOperationError(ctx.getNode(), 'The URL is empty', { itemIndex: i, parameter: 'url' });
  if (!/^https?:\/\//i.test(url)) {
    throw new NodeOperationError(
      ctx.getNode(),
      `Invalid URL "${url}": it must start with http:// or https://`,
      {
        itemIndex: i,
        parameter: 'url',
      },
    );
  }
  const request: HttpRequestOptions = { method, url };

  if (ctx.getNodeParameter('sendQuery', i, false)) {
    request.qs =
      ctx.getNodeParameter('specifyQuery', i, 'keypair') === 'json'
        ? parseJsonObject(ctx, ctx.getNodeParameter('jsonQuery', i, '{}'), 'Query Parameters JSON', i)
        : keyValuePairs((ctx.getNodeParameter('queryParameters', i, {}) as DataObject).parameters);
  }
  if (ctx.getNodeParameter('sendHeaders', i, false)) {
    const headers =
      ctx.getNodeParameter('specifyHeaders', i, 'keypair') === 'json'
        ? parseJsonObject(ctx, ctx.getNodeParameter('jsonHeaders', i, '{}'), 'Headers JSON', i)
        : keyValuePairs((ctx.getNodeParameter('headerParameters', i, {}) as DataObject).parameters);
    request.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v ?? '')]));
  }
  return request;
}

async function addBody(ctx: ExecuteContext, i: number, request: HttpRequestOptions): Promise<void> {
  if (!ctx.getNodeParameter('sendBody', i, false)) return;
  const contentType = ctx.getNodeParameter('contentType', i, 'json') as string;
  const params = () =>
    ((ctx.getNodeParameter('bodyParameters', i, {}) as DataObject).parameters ?? []) as Array<{
      parameterType?: string;
      name?: string;
      value?: unknown;
      inputDataFieldName?: string;
    }>;
  switch (contentType) {
    case 'json':
    case 'form-urlencoded': {
      const useJson = ctx.getNodeParameter('specifyBody', i, 'keypair') === 'json';
      let body: unknown;
      if (useJson) {
        const raw = ctx.getNodeParameter('jsonBody', i, '{}');
        body =
          contentType === 'json'
            ? parseJsonParameter(ctx, raw, 'JSON Body', i)
            : parseJsonObject(ctx, raw, 'Body JSON', i);
      } else {
        body = keyValuePairs(params());
      }
      request.body = body;
      request.bodyType = contentType === 'json' ? 'json' : 'form-urlencoded';
      return;
    }
    case 'multipart-form-data': {
      const form: DataObject = {};
      for (const p of params()) {
        if (!p.name) continue;
        if (p.parameterType === 'formBinaryData') {
          const field = p.inputDataFieldName || 'data';
          const meta = ctx.helpers.assertBinaryData(i, field);
          form[p.name] = {
            data: await ctx.helpers.getBinaryDataBuffer(i, field),
            fileName: meta.fileName ?? field,
            mimeType: meta.mimeType,
          };
        } else form[p.name] = p.value ?? '';
      }
      request.body = form;
      request.bodyType = 'multipart';
      return;
    }
    case 'raw': {
      request.body = String(ctx.getNodeParameter('body', i, '') ?? '');
      request.bodyType = 'raw';
      request.headers = {
        'content-type': String(ctx.getNodeParameter('rawContentType', i, 'text/plain') || 'text/plain'),
        ...(request.headers ?? {}),
      };
      return;
    }
    case 'binaryData': {
      const field = String(ctx.getNodeParameter('inputDataFieldName', i, 'data') || 'data');
      const meta = ctx.helpers.assertBinaryData(i, field);
      request.body = await ctx.helpers.getBinaryDataBuffer(i, field);
      request.bodyType = 'raw';
      request.headers = { 'content-type': meta.mimeType, ...(request.headers ?? {}) };
      return;
    }
    default:
      throw new NodeOperationError(ctx.getNode(), `Unknown body content type "${contentType}"`, {
        itemIndex: i,
      });
  }
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some((k) => k.toLowerCase() === name.toLowerCase());
}

/** Hash of what a request does (method, URL, query, body), ignoring headers and auth. */
function requestFingerprint(req: HttpRequestOptions): string {
  const hash = createHash('sha256');
  hash.update(`${req.method ?? 'GET'} ${req.url}\n${stableStringify(req.qs ?? {})}\n`);
  const addBody = (value: unknown) => {
    if (value instanceof Uint8Array) hash.update(value);
    else
      hash.update(
        stableStringify(value, (_k, v) =>
          v instanceof Uint8Array ? createHash('sha256').update(v).digest('hex') : v,
        ),
      );
  };
  addBody(req.body ?? null);
  return hash.digest('hex');
}

/**
 * Idempotency-Key for one logical request: stable when the same execution re-sends it (retry on
 * fail, retry from the failed node), different for other items, pages or request contents (for
 * example later rounds of a loop).
 */
function idempotencyKey(ctx: ExecuteContext, i: number, page: number, req: HttpRequestOptions): string {
  return createHash('sha256')
    .update(
      `${ctx.getTenantId()}:${ctx.getExecutionId()}:${ctx.getNode().id}:${i}:${page}:${requestFingerprint(req)}`,
    )
    .digest('hex')
    .slice(0, 40);
}

const TEXT_TYPES =
  /^text\/|[+/](json|xml|javascript|ecmascript|x-www-form-urlencoded|csv|yaml)\b|\+json|\+xml/i;

function decodeBody(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('utf8');
  return raw === undefined || raw === null ? '' : JSON.stringify(raw);
}

function fileNameFrom(headers: Record<string, string>, url: string): string | undefined {
  const disposition = headers['content-disposition'] ?? '';
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  if (plain) return plain[1].trim();
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

/** Turn one HTTP response into output items according to the response options. */
async function responseToItems(
  ctx: ExecuteContext,
  i: number,
  response: HttpFullResponse<unknown>,
  url: string,
  opts: ResponseOptions,
): Promise<{ items: Item[]; parsed: unknown }> {
  const contentType = (response.headers['content-type'] ?? '').toLowerCase();
  let kind: 'json' | 'text' | 'file';
  if (opts.format === 'file') kind = 'file';
  else if (opts.format === 'json') kind = 'json';
  else if (opts.format === 'text') kind = 'text';
  else if (/json/.test(contentType)) kind = 'json';
  else if (TEXT_TYPES.test(contentType)) kind = 'text';
  else if (!contentType) {
    const raw = response.body instanceof Uint8Array ? response.body : new Uint8Array();
    kind = raw.byteLength === 0 || !raw.subarray(0, 1024).some((b) => b === 0) ? 'text' : 'file';
  } else kind = 'file';

  let parsed: unknown;
  let item: Item;
  if (kind === 'file') {
    const data = response.body instanceof Uint8Array ? response.body : Buffer.from(decodeBody(response.body));
    const binary = await ctx.helpers.prepareBinaryData(
      data,
      fileNameFrom(response.headers, url),
      contentType.split(';')[0] || 'application/octet-stream',
    );
    parsed = undefined;
    item = {
      json: opts.fullResponse
        ? {
            headers: response.headers,
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
          }
        : {},
      binary: { [opts.property]: binary },
      pairedItem: { item: i },
    };
    return { items: [item], parsed };
  }

  const text = decodeBody(response.body);
  if (kind === 'json') {
    if (!text.trim()) parsed = {};
    else {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (opts.format === 'json') {
          throw new NodeOperationError(ctx.getNode(), 'The response is not valid JSON', {
            itemIndex: i,
            description: "Set 'Response Format' to Text to receive it as text",
          });
        }
        parsed = text;
      }
    }
  } else parsed = text;

  if (opts.fullResponse) {
    return {
      parsed,
      items: [
        {
          json: {
            body: parsed as never,
            headers: response.headers,
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
          },
          pairedItem: { item: i },
        },
      ],
    };
  }
  const wrap = (value: unknown): Item => ({
    json: isPlainObject(value) ? value : { [opts.property]: value },
    pairedItem: { item: i },
  });
  if (Array.isArray(parsed)) return { parsed, items: parsed.map(wrap) };
  if (typeof parsed === 'string') {
    return { parsed, items: [{ json: parsed ? { [opts.property]: parsed } : {}, pairedItem: { item: i } }] };
  }
  return { parsed, items: [wrap(parsed)] };
}

function apiMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() ? body.slice(0, 500) : undefined;
  if (!isPlainObject(body)) return undefined;
  const b = body as Record<string, any>;
  const message = b.error?.message ?? b.message ?? b.error_description ?? b.error;
  return typeof message === 'string' ? message : undefined;
}

/** Errors from arraybuffer requests carry raw bytes: decode them for a readable message. */
function readableApiError(error: unknown): unknown {
  if (!(error instanceof NodeApiError) || !(error.responseBody instanceof Uint8Array)) return error;
  const text = Buffer.from(error.responseBody).toString('utf8');
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  const better = new NodeApiError(error.node, apiMessage(body) ?? error.message, {
    httpCode: error.httpCode,
    description: error.description,
    responseBody: body,
    itemIndex: error.itemIndex,
    request: error.request,
    retryAfterMs: error.retryAfterMs,
    cause: error.cause,
  });
  return better;
}

function isEmptyBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') return body.trim() === '';
  if (Array.isArray(body)) return body.length === 0;
  if (isPlainObject(body)) return Object.keys(body).length === 0;
  if (body instanceof Uint8Array) return body.byteLength === 0;
  return false;
}

async function requestForItem(ctx: ExecuteContext, i: number, item: Item): Promise<Item[]> {
  const request = buildRequest(ctx, i);
  await addBody(ctx, i, request);

  const timeout = Number(ctx.getNodeParameter('options.timeout', i, 0));
  if (timeout > 0) request.timeout = timeout;
  if (ctx.getNodeParameter('options.allowUnauthorizedCerts', i, false))
    request.skipSslCertificateValidation = true;
  const redirect = ctx.getNodeParameter('options.redirect.redirect', i, {}) as DataObject;
  if (redirect.followRedirects === false) request.followRedirects = false;
  const response = ctx.getNodeParameter('options.response.response', i, {}) as DataObject;
  const opts: ResponseOptions = {
    fullResponse: Boolean(response.fullResponse),
    neverError: Boolean(response.neverError),
    format: (response.responseFormat as ResponseOptions['format']) ?? 'autodetect',
    property: String(response.outputPropertyName || 'data'),
  };
  const sendIdempotencyKey = Boolean(ctx.getNodeParameter('options.idempotencyKey', i, false));

  // read pagination unresolved: its expressions need $response / $pageCount
  const pagination = (ctx.getNodeParameter(
    'options.pagination.pagination',
    i,
    {},
    { rawExpressions: true },
  ) ?? {}) as PaginationConfig;

  const send = async (req: HttpRequestOptions, page: number, ignoreStatus: boolean) => {
    const final: HttpRequestOptions = {
      ...req,
      responseType: 'arraybuffer',
      returnFullResponse: true,
      ignoreHttpStatusErrors: opts.neverError || ignoreStatus,
    };
    if (sendIdempotencyKey && !hasHeader(final.headers, 'idempotency-key')) {
      final.headers = { ...(final.headers ?? {}), 'Idempotency-Key': idempotencyKey(ctx, i, page, final) };
    }
    try {
      return (await authenticatedRequest(ctx, i, final)) as HttpFullResponse<unknown>;
    } catch (error) {
      throw readableApiError(error);
    }
  };

  const vars = (extra: DataObject) => ({ $json: item.json, ...extra });
  const evaluate = (value: unknown, variables: DataObject): unknown => {
    if (!isExpression(value)) return value;
    try {
      return evaluateSimple(value, variables, { timeoutMs: 1000, maxSteps: 1_000_000 });
    } catch (error) {
      throw new NodeOperationError(
        ctx.getNode(),
        `Pagination expression failed: ${(error as Error).message}`,
        {
          itemIndex: i,
          parameter: 'options.pagination',
        },
      );
    }
  };

  const mode = String(evaluate(pagination.paginationMode ?? 'off', vars({})) ?? 'off');
  if (!Object.keys(pagination).length || mode === 'off') {
    const res = await send(request, 0, false);
    return (await responseToItems(ctx, i, res, request.url, opts)).items;
  }

  const completeWhen = String(evaluate(pagination.paginationCompleteWhen ?? 'responseIsEmpty', vars({})));
  const completeCodes = String(evaluate(pagination.statusCodesWhenComplete ?? '', vars({})) ?? '')
    .split(',')
    .map((c) => Number(c.trim()))
    .filter((c) => Number.isInteger(c));
  const limitPages = Boolean(evaluate(pagination.limitPagesFetched ?? false, vars({})));
  const maxPages = limitPages
    ? Math.max(1, Number(evaluate(pagination.maxRequests ?? 100, vars({}))))
    : MAX_PAGES;
  const interval = Math.max(0, Number(evaluate(pagination.requestInterval ?? 0, vars({}))) || 0);

  const out: Item[] = [];
  let current: HttpRequestOptions = { ...request, qs: request.qs ? { ...request.qs } : undefined };
  const signatureOf = (req: HttpRequestOptions) =>
    JSON.stringify([req.url, req.qs, req.headers, req.body instanceof Uint8Array ? '' : req.body]);
  let previousSignature = signatureOf(current);
  for (let pageCount = 0; ; ) {
    if (pageCount > 0 && interval) await sleep(interval, ctx.signal);
    const res = await send(current, pageCount, completeWhen === 'receiveSpecificStatusCodes');
    pageCount++;
    if (completeWhen === 'receiveSpecificStatusCodes' && completeCodes.includes(res.statusCode)) break;
    if (!opts.neverError && (res.statusCode < 200 || res.statusCode >= 300)) {
      throw readableApiError(
        new NodeApiError(ctx.getNode(), `Request failed with status code ${res.statusCode}`, {
          httpCode: res.statusCode,
          itemIndex: i,
          responseBody: res.body,
          request: { method: current.method ?? 'GET', url: current.url.split('?')[0] },
        }),
      );
    }
    const { items, parsed } = await responseToItems(ctx, i, res, current.url, opts);
    const $response = {
      body: parsed,
      headers: res.headers,
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
    };
    const variables = vars({
      $response,
      $pageCount: pageCount,
      $request: {
        url: current.url,
        method: current.method,
        qs: current.qs ?? {},
        headers: current.headers ?? {},
        body: current.body,
      },
    });
    if (completeWhen === 'responseIsEmpty' && isEmptyBody(parsed ?? res.body)) break;
    out.push(...items);
    if (completeWhen === 'other' && evaluate(pagination.completeExpression ?? '', variables)) break;
    if (pageCount >= maxPages) {
      if (!limitPages) {
        throw new NodeOperationError(ctx.getNode(), `Pagination stopped after ${MAX_PAGES} pages`, {
          itemIndex: i,
          description: "Check the 'Pagination Complete When' setting, or turn on 'Limit Pages Fetched'",
        });
      }
      break;
    }

    // next request
    if (mode === 'responseContainsNextURL') {
      const next = evaluate(pagination.nextURL ?? '', variables);
      if (next === undefined || next === null || next === '') break;
      const nextUrl = new URL(String(next), current.url).toString();
      current = { ...current, url: nextUrl, qs: nextUrl.includes('?') ? undefined : current.qs };
    } else {
      const params = pagination.parameters?.parameters ?? [];
      if (!params.length) {
        throw new NodeOperationError(ctx.getNode(), 'Add at least one pagination parameter', {
          itemIndex: i,
        });
      }
      const next: HttpRequestOptions = {
        ...current,
        qs: { ...(current.qs ?? {}) },
        headers: { ...(current.headers ?? {}) },
        body: isPlainObject(current.body) ? { ...current.body } : current.body,
      };
      for (const p of params) {
        const name = String(evaluate(p.name ?? '', variables) ?? '');
        if (!name) continue;
        const value = evaluate(p.value ?? '', variables);
        const type = String(p.type ?? 'qs');
        if (type === 'headers') next.headers![name] = String(value ?? '');
        else if (type === 'body') {
          if (next.body !== undefined && !isPlainObject(next.body)) {
            throw new NodeOperationError(
              ctx.getNode(),
              'Body pagination parameters need a JSON or form body',
              {
                itemIndex: i,
              },
            );
          }
          next.body = { ...((next.body as DataObject | undefined) ?? {}), [name]: value };
          next.bodyType ??= 'json';
        } else next.qs![name] = value;
      }
      current = next;
    }
    const signature = signatureOf(current);
    if (signature === previousSignature) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Pagination is not advancing: the next request is the same as the previous one',
        {
          itemIndex: i,
          description: 'Make the pagination parameter depend on $pageCount or $response',
        },
      );
    }
    previousSignature = signature;
  }
  return out;
}
