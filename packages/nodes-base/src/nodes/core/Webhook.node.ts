import { timingSafeEqual } from 'node:crypto';
import type { DataObject, Item, NodeType, WebhookContext, WebhookResponseData } from '@workflow/workflow';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function header(ctx: WebhookContext, name: string): string | undefined {
  const v = ctx.getHeaderData()[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

const unauthorized = (message: string, code = 401): WebhookResponseData => ({
  webhookResponse: {
    statusCode: code,
    headers: code === 401 ? { 'www-authenticate': 'Basic realm="Webhook"' } : {},
    body: { message },
  },
});

export const WebhookNode: NodeType = {
  description: {
    name: 'core.webhook',
    displayName: 'Webhook',
    description: 'Start the workflow when an HTTP request is received',
    icon: 'lucide:webhook',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Webhook' },
    inputs: [],
    outputs: ['main'],
    categories: ['Core', 'Triggers'],
    alias: ['http', 'api', 'endpoint', 'callback'],
    credentials: [
      { name: 'httpBasicAuth', required: true, displayOptions: { show: { authentication: ['basicAuth'] } } },
      {
        name: 'httpHeaderAuth',
        required: true,
        displayOptions: { show: { authentication: ['headerAuth'] } },
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: '={{$parameter["httpMethod"]}}',
        path: '={{$parameter["path"]}}',
        responseMode: '={{$parameter["responseMode"]}}',
        responseData: '={{$parameter["responseData"]}}',
      },
    ],
    eventTriggerDescription: 'Waiting for you to call the Test URL',
    activationMessage: 'You can now make calls to your production webhook URL.',
    properties: [
      {
        displayName: 'HTTP Method',
        name: 'httpMethod',
        type: 'options',
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m })),
      },
      {
        displayName: 'Path',
        name: 'path',
        type: 'string',
        default: '',
        placeholder: 'orders/new or users/:id',
        description: 'Leave empty to use a generated path. Supports route parameters like :id.',
      },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        options: [
          { name: 'None', value: 'none' },
          { name: 'Basic Auth', value: 'basicAuth' },
          { name: 'Header Auth', value: 'headerAuth' },
        ],
      },
      {
        displayName: 'Respond',
        name: 'responseMode',
        type: 'options',
        default: 'onReceived',
        options: [
          { name: 'Immediately', value: 'onReceived', description: 'As soon as the request is received' },
          {
            name: 'When Last Node Finishes',
            value: 'lastNode',
            description: 'Returns data of the last executed node',
          },
          {
            name: "Using 'Respond to Webhook' Node",
            value: 'responseNode',
            description: 'Response defined in that node',
          },
        ],
      },
      {
        displayName: 'Response Code',
        name: 'responseCode',
        type: 'number',
        default: 200,
        typeOptions: { minValue: 100, maxValue: 599 },
        displayOptions: { hide: { responseMode: ['responseNode'] } },
      },
      {
        displayName: 'Response Data',
        name: 'responseData',
        type: 'options',
        default: 'firstEntryJson',
        displayOptions: { show: { responseMode: ['lastNode'] } },
        options: [
          { name: 'All Entries', value: 'allEntries' },
          { name: 'First Entry JSON', value: 'firstEntryJson' },
          { name: 'First Entry Binary', value: 'firstEntryBinary' },
          { name: 'No Response Body', value: 'noData' },
        ],
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
            description: 'Comma-separated list of origins, or * for any',
          },
          {
            displayName: 'IP Allowlist',
            name: 'ipWhitelist',
            type: 'string',
            default: '',
            description: 'Comma-separated IPs allowed to call this webhook. Empty allows all.',
          },
          { displayName: 'Ignore Bots', name: 'ignoreBots', type: 'boolean', default: false },
          { displayName: 'Raw Body', name: 'rawBody', type: 'boolean', default: false },
          {
            displayName: 'Binary Property Prefix',
            name: 'binaryPropertyName',
            type: 'string',
            default: 'data',
            description: 'Prefix for uploaded files (data0, data1, ...)',
          },
          {
            displayName: 'Response Headers',
            name: 'responseHeaders',
            type: 'json',
            default: '{}',
          },
        ],
      },
    ],
  },

  async webhook(ctx: WebhookContext): Promise<WebhookResponseData> {
    const req = ctx.getRequestObject();
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const authentication = ctx.getNodeParameter('authentication', 0) as string;

    const allowList = String(options.ipWhitelist ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowList.length && (!req.ip || !allowList.includes(req.ip)))
      return unauthorized('IP is not allowed', 403);

    if (options.ignoreBots && /bot|crawler|spider|preview/i.test(header(ctx, 'user-agent') ?? '')) {
      return unauthorized('Bots are ignored', 403);
    }

    if (authentication === 'basicAuth') {
      const creds = await ctx.getCredentials<{ user: string; password: string }>('httpBasicAuth');
      const auth = header(ctx, 'authorization') ?? '';
      const decoded = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
      const sep = decoded.indexOf(':');
      if (
        sep < 0 ||
        !safeEqual(decoded.slice(0, sep), creds.user) ||
        !safeEqual(decoded.slice(sep + 1), creds.password)
      ) {
        return unauthorized('Authorization is required');
      }
    } else if (authentication === 'headerAuth') {
      const creds = await ctx.getCredentials<{ name: string; value: string }>('httpHeaderAuth');
      const got = header(ctx, creds.name) ?? '';
      if (!safeEqual(got, creds.value)) return unauthorized('Authorization data is wrong', 403);
    }

    const item: Item = {
      json: {
        headers: req.headers as DataObject,
        params: req.params,
        query: req.query,
        body: (req.body ?? {}) as DataObject,
        webhookUrl: `${ctx.getInstanceBaseUrl()}`,
        executionMode: ctx.getMode() === 'manual' ? 'test' : 'production',
      },
    };
    if (options.rawBody && req.rawBody) {
      item.binary = {
        data: await ctx.helpers.prepareBinaryData(
          req.rawBody,
          'body',
          header(ctx, 'content-type') ?? 'application/octet-stream',
        ),
      };
    }
    if (req.files?.length) {
      const prefix = String(options.binaryPropertyName ?? 'data');
      item.binary ??= {};
      for (const [i, file] of req.files.entries()) {
        item.binary[req.files.length === 1 ? prefix : `${prefix}${i}`] = await ctx.helpers.prepareBinaryData(
          file.data,
          file.fileName,
          file.mimeType,
        );
      }
    }
    return { workflowData: [[item]] };
  },
};
