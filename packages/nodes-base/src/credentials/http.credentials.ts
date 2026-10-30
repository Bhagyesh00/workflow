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
