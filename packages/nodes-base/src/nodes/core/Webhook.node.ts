import { timingSafeEqual } from 'node:crypto';
import type {
  DataObject,
  FormUser,
  Item,
  NodeType,
  WebhookContext,
  WebhookResponseData,
} from '@workflow/workflow';
import { isBotUserAgent } from '../../utils/bots';
import { type SignaturePreset, verifyWebhookSignature } from '../../utils/webhook-signature';
import { checkWebhookSignIn, type WebhookOAuthClient } from '../../utils/workspace-signin';

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
      {
        name: 'webhookSigningSecret',
        required: true,
        displayOptions: { show: { authentication: ['signature'] } },
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
          {
            name: 'Signature (HMAC)',
            value: 'signature',
            description: 'Verify the HMAC signature the sending service puts on every delivery',
          },
          {
            name: 'Workspace sign-in (OAuth2)',
            value: 'n8nOAuth2',
            description:
              'Only signed-in workspace members get through, with a token of the workspace or, in a browser, a sign-in',
          },
        ],
      },
      {
        displayName: 'Client',
        name: 'oauthClient',
        type: 'options',
        default: 'bearer',
        noDataExpression: true,
        description: 'Who calls this webhook',
        options: [
          {
            name: 'Token Only',
            value: 'bearer',
            description: 'An access token of the workspace for this webhook, in the Authorization header',
          },
          {
            name: 'Token or Browser',
            value: 'auto',
            description: 'A token, or a visitor in a browser who signs in to the workspace first',
          },
        ],
        displayOptions: { show: { authentication: ['n8nOAuth2'] } },
      },
      {
        displayName: 'Require Workflow Execute Permission',
        name: 'requireExecuteAccess',
        type: 'boolean',
        default: true,
        description: 'Whether only members who may run this workflow, editors and above, can call it',
        displayOptions: { show: { authentication: ['n8nOAuth2'] } },
      },
      {
        displayName: 'Include User in Output',
        name: 'includeUserInOutput',
        type: 'boolean',
        default: true,
        description: 'Whether the signed-in user (id, email, first and last name) is added to the output',
        displayOptions: { show: { authentication: ['n8nOAuth2'] } },
      },
      {
        displayName: 'Signature Format',
        name: 'signaturePreset',
        type: 'options',
        default: 'generic',
        displayOptions: { show: { authentication: ['signature'] } },
        options: [
          { name: 'GitHub (X-Hub-Signature-256)', value: 'github' },
          { name: 'Stripe (Stripe-Signature)', value: 'stripe' },
          { name: 'Slack (X-Slack-Signature)', value: 'slack' },
          { name: 'Shopify (X-Shopify-Hmac-Sha256)', value: 'shopify' },
          {
            name: 'Custom Header',
            value: 'generic',
            description: 'HMAC of the raw body in a header you name',
          },
        ],
      },
      {
        displayName: 'Signature Header',
        name: 'signatureHeader',
        type: 'string',
        default: 'X-Signature',
        displayOptions: { show: { authentication: ['signature'], signaturePreset: ['generic'] } },
      },
      {
        displayName: 'Algorithm',
        name: 'signatureAlgorithm',
        type: 'options',
        default: 'sha256',
        displayOptions: { show: { authentication: ['signature'], signaturePreset: ['generic'] } },
        options: [
          { name: 'HMAC-SHA256', value: 'sha256' },
          { name: 'HMAC-SHA512', value: 'sha512' },
          { name: 'HMAC-SHA1', value: 'sha1' },
        ],
      },
      {
        displayName: 'Encoding',
        name: 'signatureEncoding',
        type: 'options',
        default: 'hex',
        displayOptions: { show: { authentication: ['signature'], signaturePreset: ['generic'] } },
        options: [
          { name: 'Hex', value: 'hex' },
          { name: 'Base64', value: 'base64' },
        ],
      },
      {
        displayName: 'Signature Prefix',
        name: 'signaturePrefix',
        type: 'string',
        default: '',
        placeholder: 'sha256=',
        description: 'Text in front of the signature in the header, if any',
        displayOptions: { show: { authentication: ['signature'], signaturePreset: ['generic'] } },
      },
      {
        displayName: 'Max Age (Seconds)',
        name: 'signatureTolerance',
        type: 'number',
        default: 300,
        description: 'Deliveries with an older signed timestamp are rejected to stop replays',
        displayOptions: { show: { authentication: ['signature'], signaturePreset: ['stripe', 'slack'] } },
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

    if (options.ignoreBots && isBotUserAgent(header(ctx, 'user-agent'))) {
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
    } else if (authentication === 'signature') {
      const creds = await ctx.getCredentials<{ secret: string }>('webhookSigningSecret');
      const result = verifyWebhookSignature({
        preset: ctx.getNodeParameter('signaturePreset', 0, 'generic') as SignaturePreset,
        secret: String(creds.secret ?? ''),
        headers: ctx.getHeaderData(),
        rawBody: req.rawBody,
        toleranceSeconds: Number(ctx.getNodeParameter('signatureTolerance', 0, 300)),
        header: ctx.getNodeParameter('signatureHeader', 0, 'X-Signature') as string,
        algorithm: ctx.getNodeParameter('signatureAlgorithm', 0, 'sha256') as 'sha256',
        encoding: ctx.getNodeParameter('signatureEncoding', 0, 'hex') as 'hex',
        prefix: ctx.getNodeParameter('signaturePrefix', 0, '') as string,
      });
      if (!result.ok) {
        return { webhookResponse: { statusCode: 401, headers: {}, body: { message: result.reason } } };
      }
    }

    let user: DataObject | undefined;
    let signedIn: FormUser | undefined;
    // the sign-in page's one-time code is not a parameter of the caller
    const query = { ...req.query } as DataObject;
    if (authentication === 'n8nOAuth2') {
      const oauthClient = ctx.getNodeParameter('oauthClient', 0, 'bearer') as WebhookOAuthClient;
      const signIn = await checkWebhookSignIn(ctx, {
        oauthClient: oauthClient === 'auto' ? 'auto' : 'bearer',
        requireExecuteAccess: ctx.getNodeParameter('requireExecuteAccess', 0, true) !== false,
      });
      if (!signIn.allowed) return { webhookResponse: signIn.response };
      signedIn = signIn.user;
      if (oauthClient === 'auto') delete query.code;
      if (ctx.getNodeParameter('includeUserInOutput', 0, true) !== false) {
        user = {
          id: signIn.user.id,
          email: signIn.user.email,
          firstName: signIn.user.firstName,
          lastName: signIn.user.lastName,
        };
      }
    }

    const item: Item = {
      json: {
        headers: req.headers as DataObject,
        params: req.params,
        query,
        body: (req.body ?? {}) as DataObject,
        webhookUrl: `${ctx.getInstanceBaseUrl()}`,
        executionMode: ctx.getMode() === 'manual' ? 'test' : 'production',
        ...(user ? { user } : {}),
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
    // the person the sign-in identified: the run starts as them, whether or not Include User is on (P6-87)
    return { workflowData: [[item]], ...(signedIn ? { triggerUserId: signedIn.id } : {}) };
  },
};
