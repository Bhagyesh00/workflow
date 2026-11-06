/**
 * Redis: delete, get, increment, info, keys, list length, pop, publish, push and set.
 * The connection goes through openRedis (SSRF guard, first checked address, TLS server name).
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import type { Redis } from 'ioredis';
import { openRedis, type RedisCredentials, redisCredentialTest } from '../../../utils/redis-connect';

const OPERATIONS = [
  { name: 'Delete', value: 'delete', description: 'Delete a key from Redis', action: 'Delete a key' },
  {
    name: 'Get',
    value: 'get',
    description: 'Get the value of a key from Redis',
    action: 'Get the value of a key',
  },
  {
    name: 'Increment',
    value: 'incr',
    description: 'Atomically increment a key by 1; a missing key starts at 0',
    action: 'Increment a key',
  },
  {
    name: 'Info',
    value: 'info',
    description: 'Return generic information about the Redis instance',
    action: 'Get instance info',
  },
  { name: 'Keys', value: 'keys', description: 'Return all keys matching a pattern', action: 'List keys' },
  {
    name: 'List Length',
    value: 'llen',
    description: 'Return the length of a list',
    action: 'Get the length of a list',
  },
  { name: 'Pop', value: 'pop', description: 'Pop data from a list', action: 'Pop data from a list' },
  {
    name: 'Publish',
    value: 'publish',
    description: 'Publish a message to a channel',
    action: 'Publish a message to a channel',
  },
  { name: 'Push', value: 'push', description: 'Push data to a list', action: 'Push data to a list' },
  {
    name: 'Set',
    value: 'set',
    description: 'Set the value of a key in Redis',
    action: 'Set the value of a key',
  },
];

const op = (...values: string[]) => ({ show: { operation: values } });

const properties: NodeProperty[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    default: 'get',
    options: OPERATIONS,
  },
  {
    displayName: 'Name',
    name: 'propertyName',
    type: 'string',
    default: 'propertyName',
    required: true,
    displayOptions: op('get', 'pop'),
    description: 'Name of the property that gets the value in the output item. Dots make a nested path',
  },
  {
    displayName: 'Key',
    name: 'key',
    type: 'string',
    default: '',
    required: true,
    displayOptions: op('delete', 'get', 'incr', 'set'),
    description: 'The key to use',
  },
  {
    displayName: 'Key Type',
    name: 'keyType',
    type: 'options',
    default: 'automatic',
    options: [
      { name: 'Automatic', value: 'automatic', description: 'Find the type automatically from the key' },
      { name: 'Hash', value: 'hash' },
      { name: 'List', value: 'list' },
      { name: 'Sets', value: 'sets' },
      { name: 'String', value: 'string' },
    ],
    displayOptions: op('get'),
    description: 'The type of the key to read',
  },
  {
    displayName: 'Key Pattern',
    name: 'keyPattern',
    type: 'string',
    default: '',
    required: true,
    displayOptions: op('keys'),
    description: 'The pattern to match. * matches any run of characters',
  },
  {
    displayName: 'Get Values',
    name: 'getValues',
    type: 'boolean',
    default: true,
    displayOptions: op('keys'),
    description: 'Whether to read the value of every key found, not only its name',
  },
  {
    displayName: 'List',
    name: 'list',
    type: 'string',
    default: '',
    required: true,
    displayOptions: op('llen', 'pop', 'push'),
    description: 'The name of the list',
  },
  {
    displayName: 'Tail',
    name: 'tail',
    type: 'boolean',
    default: false,
    displayOptions: op('pop', 'push'),
    description: 'Whether to use the end of the list (pop from the tail, push to the tail) and not the start',
  },
  {
    displayName: 'Data',
    name: 'messageData',
    type: 'string',
    default: '',
    required: true,
    displayOptions: op('push', 'publish'),
    description: 'The data to write',
  },
  {
    displayName: 'Channel',
    name: 'channel',
    type: 'string',
    default: '',
    required: true,
    displayOptions: op('publish'),
    description: 'The channel to publish to',
  },
  {
    displayName: 'Value',
    name: 'value',
    type: 'string',
    default: '',
    displayOptions: op('set'),
    description: 'The value to write',
  },
  {
    displayName: 'Value Type',
    name: 'valueType',
    type: 'options',
    default: 'automatic',
    options: [
      {
        name: 'Automatic',
        value: 'automatic',
        description: 'Text is stored as a string, an array as a list and an object as a hash',
      },
      { name: 'Hash', value: 'hash', description: 'Value is a JSON object whose fields become hash fields' },
      { name: 'List', value: 'list', description: 'Value is a JSON array pushed to a list' },
      { name: 'Sets', value: 'sets', description: 'Value is a JSON array added to a set' },
      { name: 'String', value: 'string' },
    ],
    displayOptions: op('set'),
    description: 'The type to store the value as',
  },
  {
    displayName: 'Value Is JSON',
    name: 'valueIsJSON',
    type: 'boolean',
    default: true,
    displayOptions: { show: { operation: ['set'], valueType: ['hash'] } },
    description:
      'Whether the value is a JSON object whose fields become hash fields. Off: the value is field and value pairs separated by spaces',
  },
  {
    displayName: 'Expire',
    name: 'expire',
    type: 'boolean',
    default: false,
    displayOptions: op('incr', 'set'),
    description: 'Whether to set a time to live on the key',
  },
  {
    displayName: 'TTL',
    name: 'ttl',
    type: 'number',
    default: 60,
    typeOptions: { minValue: 1 },
    displayOptions: { show: { operation: ['incr', 'set'], expire: [true] } },
    description: 'Seconds until the key expires',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: op('get', 'pop'),
    options: [
      {
        displayName: 'Dot Notation',
        name: 'dotNotation',
        type: 'boolean',
        default: true,
        description: 'Whether dots in Name make a nested path. Turn off to use the name as is',
      },
    ],
  },
];

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** write value at a dotted path, refusing names that would reach the prototype */
function setPath(target: DataObject, path: string, value: unknown, dotNotation: boolean): void {
  const parts = dotNotation ? path.split('.') : [path];
  if (parts.some((part) => UNSAFE.has(part))) return;
  let cursor = target as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = Object.prototype.hasOwnProperty.call(cursor, part) ? cursor[part] : undefined;
    if (next === null || typeof next !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/** a stored text that is JSON comes back as JSON, anything else stays text */
function parseMaybeJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readKey(client: Redis, key: string, keyType: string): Promise<unknown> {
  const type = keyType === 'automatic' ? await client.type(key) : keyType === 'sets' ? 'set' : keyType;
  switch (type) {
    case 'string':
      return client.get(key);
    case 'hash':
      return client.hgetall(key);
    case 'list':
      return client.lrange(key, 0, -1);
    case 'set':
      return client.smembers(key);
    default:
      return null;
  }
}

/** INFO text to an object: section lines dropped, `key:value` lines kept, numbers turned into numbers */
function parseInfo(text: string): DataObject {
  const out: DataObject = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 1) continue;
    const key = line.slice(0, at);
    if (UNSAFE.has(key)) continue;
    const raw = line.slice(at + 1);
    out[key] = raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return out;
}

const asJson = (value: unknown) => (value ?? null) as DataObject[string];

async function runOperation(
  ctx: ExecuteContext,
  client: Redis,
  operation: string,
  index: number,
  item: Item,
): Promise<Item[]> {
  const param = (name: string, fallback: unknown = '') => ctx.getNodeParameter(name, index, fallback);
  const keepInput = (): Item[] => [{ json: { ...item.json }, pairedItem: { item: index } }];
  const paired = (json: DataObject): Item[] => [{ json, pairedItem: { item: index } }];
  /** one property named after a key or list, as n8n answers Increment and List Length */
  const named = (name: string, value: unknown): Item[] => {
    const json: DataObject = {};
    if (!UNSAFE.has(name)) json[name] = asJson(value);
    return paired(json);
  };
  const dotNotation = param('options.dotNotation', true) !== false;
  const propertyName = () => String(param('propertyName', 'propertyName'));

  switch (operation) {
    case 'delete': {
      await client.del(String(param('key')));
      return keepInput();
    }
    case 'get': {
      const value = await readKey(client, String(param('key')), String(param('keyType', 'automatic')));
      // like n8n, the output item holds only the value
      const json: DataObject = {};
      setPath(json, propertyName(), asJson(value), dotNotation);
      return paired(json);
    }
    case 'incr': {
      const key = String(param('key'));
      const value = await client.incr(key);
      // a TTL of 0 or less would delete the key, so only a positive one is applied
      const ttl = Number(param('ttl', 60));
      if (param('expire', false) === true && ttl > 0) await client.expire(key, ttl);
      return named(key, value);
    }
    case 'keys': {
      const keys = await client.keys(String(param('keyPattern')));
      if (param('getValues', true) !== true) return paired({ keys });
      const json: DataObject = {};
      for (const key of keys) {
        if (UNSAFE.has(key)) continue;
        json[key] = asJson(await readKey(client, key, 'automatic'));
      }
      return paired(json);
    }
    case 'llen':
      return named(String(param('list')), await client.llen(String(param('list'))));
    case 'pop': {
      const list = String(param('list'));
      const text = param('tail', false) === true ? await client.rpop(list) : await client.lpop(list);
      const json: DataObject = {};
      setPath(json, propertyName(), asJson(parseMaybeJson(text)), dotNotation);
      return paired(json);
    }
    case 'publish': {
      await client.publish(String(param('channel')), String(param('messageData')));
      return keepInput();
    }
    case 'push': {
      const list = String(param('list'));
      const data = String(param('messageData'));
      if (param('tail', false) === true) await client.rpush(list, data);
      else await client.lpush(list, data);
      return keepInput();
    }
    case 'set': {
      const key = String(param('key'));
      const value = param('value');
      let type = String(param('valueType', 'automatic'));
      if (type === 'automatic') {
        // like n8n: text is a string key, an array a list and an object a hash
        type = Array.isArray(value)
          ? 'list'
          : value !== null && typeof value === 'object'
            ? 'hash'
            : 'string';
      }
      const valueIsJson = type !== 'hash' || param('valueIsJSON', true) !== false;
      const parsed = typeof value === 'string' && valueIsJson ? parseMaybeJson(value) : value;
      const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
      if (type === 'string') {
        await client.set(key, text(value));
      } else if (type === 'hash' && !valueIsJson) {
        // field and value pairs separated by spaces
        const words = String(value ?? '')
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (words.length === 0 || words.length % 2 !== 0) {
          throw new NodeOperationError(
            ctx.getNode(),
            'Value must be field and value pairs separated by spaces to store as a hash',
            { itemIndex: index },
          );
        }
        await client.hset(key, ...words);
      } else if (type === 'hash') {
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new NodeOperationError(ctx.getNode(), 'Value must be a JSON object to store as a hash', {
            itemIndex: index,
          });
        }
        const flat = Object.entries(parsed).flatMap(([field, fieldValue]) => [field, text(fieldValue)]);
        if (flat.length > 0) await client.hset(key, ...flat);
      } else {
        if (!Array.isArray(parsed)) {
          throw new NodeOperationError(
            ctx.getNode(),
            `Value must be a JSON array to store as a ${type === 'sets' ? 'set' : 'list'}`,
            { itemIndex: index },
          );
        }
        const members = parsed.map(text);
        if (members.length > 0) {
          if (type === 'list') await client.rpush(key, ...members);
          else await client.sadd(key, ...members);
        }
      }
      const ttl = Number(param('ttl', 60));
      if (param('expire', false) === true && ttl > 0) await client.expire(key, ttl);
      return keepInput();
    }
    default:
      throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not supported`, {
        itemIndex: index,
      });
  }
}

export const RedisNode: NodeType = {
  description: {
    name: 'app.redis',
    displayName: 'Redis',
    description: 'Delete, get, increment, info, keys, list length, pop, publish, push and set in Redis',
    icon: 'simple:redis',
    iconColor: '#dc382d',
    group: ['input'],
    version: 1,
    defaults: { name: 'Redis' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Data & Storage', 'Developer tools'],
    alias: ['redis', 'cache', 'key value', 'pubsub', 'list'],
    credentials: [{ name: 'redis', required: true, testedBy: 'redisCredentialTest' }],
    properties,
  },

  methods: {
    credentialTest: { redisCredentialTest },
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    if (items.length === 0) return [[]];
    const creds = (await ctx.getCredentials('redis')) as RedisCredentials;
    const client = await openRedis(ctx, creds);
    const results: Item[] = [];
    try {
      // Info describes the instance, so like n8n it runs once however many items come in
      if (String(ctx.getNodeParameter('operation', 0, 'get')) === 'info') {
        try {
          return [[{ json: parseInfo(await client.info()) }]];
        } catch (error) {
          if (ctx.continueOnFail()) return [[{ json: { error: (error as Error).message } }]];
          throw new NodeOperationError(
            ctx.getNode(),
            `Couldn't run the Redis command: ${(error as Error).message}`,
          );
        }
      }
      for (let index = 0; index < items.length; index++) {
        try {
          const operation = String(ctx.getNodeParameter('operation', index, 'get'));
          results.push(...(await runOperation(ctx, client, operation, index, items[index]!)));
        } catch (error) {
          if (ctx.continueOnFail()) {
            results.push({ json: { error: (error as Error).message }, pairedItem: { item: index } });
            continue;
          }
          if (error instanceof NodeOperationError) throw error;
          throw new NodeOperationError(
            ctx.getNode(),
            `Couldn't run the Redis command: ${(error as Error).message}`,
            { itemIndex: index },
          );
        }
      }
    } finally {
      client.disconnect();
    }
    return [results];
  },
};
