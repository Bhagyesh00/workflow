/** Generic HTTP credentials usable from the HTTP Request and GraphQL nodes. */
import { type CredentialType, type DataObject, isPlainObject } from '@workflow/workflow';

export const httpBasicAuth: CredentialType = {
  name: 'httpBasicAuth',
  displayName: 'Basic Auth',
  icon: 'lucide:key-round',
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
  authenticate: {
    type: 'generic',
    properties: { auth: { username: '={{$credentials.user}}', password: '={{$credentials.password}}' } },
  },
};

export const httpHeaderAuth: CredentialType = {
  name: 'httpHeaderAuth',
  displayName: 'Header Auth',
  icon: 'lucide:key-round',
  properties: [
    { displayName: 'Name', name: 'name', type: 'string', default: '', placeholder: 'X-API-Key' },
    { displayName: 'Value', name: 'value', type: 'string', default: '', typeOptions: { password: true } },
  ],
  authenticate: {
    type: 'generic',
    properties: { headers: { '={{$credentials.name}}': '={{$credentials.value}}' } },
  },
};

/** the `{ name, value }` rows of a Multiple Headers Auth credential (`headers.values`) */
export function multipleHeadersOf(credentials: DataObject): Record<string, string> {
  const collection = credentials.headers;
  const rows = isPlainObject(collection) && Array.isArray(collection.values) ? collection.values : [];
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const name = String(row.name ?? '')
      .trim()
      .toLowerCase();
    if (!name) continue;
    out[name] = row.value === undefined || row.value === null ? '' : String(row.value);
  }
  return out;
}

/** several headers sent on every request (the MCP Client Tool's "Multiple Headers Auth") */
export const httpMultipleHeadersAuth: CredentialType = {
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
  async authenticate(credentials, request) {
    const headers = multipleHeadersOf(credentials);
    if (Object.keys(headers).length === 0) return request;
    const kept = Object.fromEntries(
      Object.entries(request.headers ?? {}).filter(([key]) => !(key.toLowerCase() in headers)),
    );
    return { ...request, headers: { ...kept, ...headers } };
  },
};

export const httpQueryAuth: CredentialType = {
  name: 'httpQueryAuth',
  displayName: 'Query Auth',
  icon: 'lucide:key-round',
  properties: [
    { displayName: 'Name', name: 'name', type: 'string', default: '', placeholder: 'api_key' },
    { displayName: 'Value', name: 'value', type: 'string', default: '', typeOptions: { password: true } },
  ],
  authenticate: {
    type: 'generic',
    properties: { qs: { '={{$credentials.name}}': '={{$credentials.value}}' } },
  },
};

export const httpBearerAuth: CredentialType = {
  name: 'httpBearerAuth',
  displayName: 'Bearer Auth',
  icon: 'lucide:key-round',
  properties: [
    {
      displayName: 'Bearer Token',
      name: 'token',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description: 'Sent as "Authorization: Bearer <token>"',
    },
  ],
  authenticate: {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.token}}' } },
  },
};

const CUSTOM_AUTH_KEYS = ['headers', 'qs', 'body'] as const;

/** Parse the JSON of a Custom Auth credential, refusing anything but string maps. */
export function parseCustomAuth(
  json: unknown,
): Partial<Record<(typeof CUSTOM_AUTH_KEYS)[number], DataObject>> {
  let parsed: unknown = json;
  if (typeof json === 'string') {
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('The Custom Auth credential does not contain valid JSON');
    }
  }
  if (!isPlainObject(parsed)) throw new Error('The Custom Auth credential must be a JSON object');
  const out: Partial<Record<(typeof CUSTOM_AUTH_KEYS)[number], DataObject>> = {};
  for (const key of Object.keys(parsed)) {
    if (!CUSTOM_AUTH_KEYS.includes(key as never)) {
      throw new Error(`Custom Auth supports only "headers", "qs" and "body", not "${key}"`);
    }
    const section = parsed[key];
    if (!isPlainObject(section)) throw new Error(`Custom Auth "${key}" must be an object`);
    out[key as (typeof CUSTOM_AUTH_KEYS)[number]] = section;
  }
  return out;
}

export const httpCustomAuth: CredentialType = {
  name: 'httpCustomAuth',
  displayName: 'Custom Auth',
  icon: 'lucide:key-round',
  properties: [
    {
      displayName: 'JSON',
      name: 'json',
      type: 'json',
      default: '{\n  "headers": {\n    "X-Api-Key": "..."\n  },\n  "qs": {},\n  "body": {}\n}',
      required: true,
      typeOptions: { rows: 8, password: true },
      description: 'Headers, query parameters and body fields added to every request',
    },
  ],
  async authenticate(credentials, request) {
    const custom = parseCustomAuth(credentials.json);
    const next = { ...request };
    if (custom.headers) {
      next.headers = {
        ...(request.headers ?? {}),
        ...Object.fromEntries(Object.entries(custom.headers).map(([k, v]) => [k, String(v)])),
      };
    }
    if (custom.qs) next.qs = { ...(request.qs ?? {}), ...custom.qs };
    if (custom.body) {
      next.body = isPlainObject(request.body)
        ? { ...request.body, ...custom.body }
        : (request.body ?? custom.body);
    }
    return next;
  },
};

/** Shared secret used to verify HMAC signatures on incoming webhook deliveries. */
export const webhookSigningSecret: CredentialType = {
  name: 'webhookSigningSecret',
  displayName: 'Webhook Signing Secret',
  icon: 'lucide:shield-check',
  properties: [
    {
      displayName: 'Signing Secret',
      name: 'secret',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      description: 'The secret the sending service uses to sign its webhook deliveries',
    },
  ],
};
