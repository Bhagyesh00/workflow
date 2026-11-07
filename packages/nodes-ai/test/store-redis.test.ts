/**
 * Redis Vector Store (P5-41) against the dev Redis 8 (query engine bundled). RediSearch indexes exist
 * only in database 0, so these tests use REDIS_SEARCH_CREDENTIALS with a unique index name and key
 * prefix per test; afterAll drops every index with its documents and deletes the keys.
 */
import { HttpClient } from '@workflow/core';
import type { DataObject, Item, LoadOptionsContext, WorkflowNode } from '@workflow/workflow';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { VectorStoreRedisNode } from '../src/nodes/vector-stores/redis-vector';
import { sharedResourceCount } from '../src/shared/shared-resource';
import { connect, node, REDIS_SEARCH_CREDENTIALS, run, services, VOCABULARY } from './harness';

const suffix = `${process.pid}_${Date.now()}`;
const raw = new Redis({ host: '127.0.0.1', port: 6379, db: 0, lazyConnect: true });
const indexes: string[] = [];
const prefixes: string[] = [];
let counter = 0;

/** A fresh index name and key prefix, registered for cleanup. */
function names(): { index: string; prefix: string } {
  const n = ++counter;
  const index = `p5s2_redis_${suffix}_${n}`;
  const prefix = `p5s2r:${suffix}:${n}:`;
  indexes.push(index);
  prefixes.push(prefix);
  return { index, prefix };
}

beforeAll(() => raw.connect());
afterAll(async () => {
  for (const index of indexes) await raw.call('FT.DROPINDEX', index, 'DD').catch(() => {});
  for (const prefix of prefixes) {
    const keys = await raw.keys(`${prefix}*`);
    if (keys.length) await raw.del(...keys);
  }
  await raw.quit();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const DOCS: Item[] = [
  { json: { text: 'Cats and dogs are pets', topic: 'animals', price: 5 } },
  { json: { text: 'A car has an engine and drives on the road', topic: 'vehicles', price: 50 } },
  { json: { text: 'Pizza and pasta are food', topic: 'food', price: 12 } },
  { json: { text: 'The sun and the moon are in the sky', topic: 'space', price: 90 } },
];

function store(mode: string, index: string, parameters: DataObject = {}): WorkflowNode {
  return node(
    'Store',
    'ai.vectorStoreRedis',
    { mode, redisIndex: { __rl: true, mode: 'id', value: index }, ...parameters },
    { credentials: { redis: { id: 'r', name: 'r' } } },
  );
}

const loader = () =>
  node('Loader', 'ai.documentDefaultDataLoader', {
    jsonMode: 'expressionData',
    jsonData: '={{ $json.text }}',
    options: {
      metadata: {
        metadataValues: [
          { name: 'topic', value: '={{ $json.topic }}' },
          { name: 'price', value: '={{ $json.price }}' },
        ],
      },
    },
  });

const svc = () =>
  services({
    creds: { redis: REDIS_SEARCH_CREDENTIALS },
    http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }),
  });

function insert(index: string, options: DataObject = {}, items: Item[] = DOCS) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      store('insert', index, { options }),
      loader(),
      node('Embeddings', 'test.fakeEmbeddings'),
    ],
    connect(
      ['Trigger', 'Store'],
      ['Loader', 'Store', 'ai_document'],
      ['Embeddings', 'Store', 'ai_embedding'],
    ),
    { triggerItems: items, services: svc() },
  );
}

function load(index: string, prompt: string, parameters: DataObject = {}) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      store('load', index, { prompt, ...parameters }),
      node('Embeddings', 'test.fakeEmbeddings'),
    ],
    connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
    { triggerItems: [{ json: {} }], services: svc() },
  );
}

function update(index: string, id: string, json: DataObject, parameters: DataObject = {}) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      store('update', index, { id, ...parameters }),
      node('Embeddings', 'test.fakeEmbeddings'),
    ],
    connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
    { triggerItems: [{ json }], services: svc() },
  );
}

const docCount = async (index: string): Promise<number> => {
  const reply = (await raw.call('FT.SEARCH', index, '*', 'LIMIT', '0', '0')) as unknown[];
  // Redis 8 answers with a map, older servers with [total, ...]
  const at = reply.indexOf('total_results');
  return Number(at >= 0 ? reply[at + 1] : reply[0]);
};

const messageOf = (r: { error?: DataObject & { message?: string } }) =>
  `${r.error?.message} ${(r.error as DataObject | undefined)?.description ?? ''}`;

describe('Redis Vector Store', () => {
  it('inserts, searches by similarity and updates by id (done when)', async () => {
    const { index, prefix } = names();
    const inserted = await insert(index, { keyPrefix: prefix });
    expect(inserted.status, JSON.stringify(inserted.error)).toBe('success');
    expect(inserted.output('Store')).toHaveLength(4);

    // index created with our layout: HASH on the prefix, TEXT content and metadata, FLAT cosine vector
    const info = JSON.stringify(await raw.call('FT.INFO', index));
    expect(info).toContain(prefix);
    for (const field of ['text', 'metadata', 'embedding']) expect(info).toContain(field);
    expect(info).toContain('FLAT');
    expect(info).toContain('COSINE');

    const keys = await raw.keys(`${prefix}*`);
    expect(keys).toHaveLength(4);
    const hash = await raw.hgetallBuffer(keys[0]);
    expect(hash.embedding).toHaveLength(VOCABULARY.length * 4);
    expect(Object.keys(hash).sort()).toEqual(['embedding', 'metadata', 'price', 'source', 'text', 'topic']);

    const found = await load(index, 'pizza', { topK: 2, options: { keyPrefix: prefix } });
    expect(found.status, JSON.stringify(found.error)).toBe('success');
    const rows = found.output('Store') as Array<{ document: DataObject; score: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].document.pageContent).toBe('Pizza and pasta are food');
    expect(rows[0].document.metadata).toMatchObject({ topic: 'food' });
    expect(rows[0].score).toBeCloseTo(1 / Math.sqrt(3), 4);
    expect(rows[0].score).toBeGreaterThan(rows[1].score);

    // update: HSET on the key of the given id; the index follows
    const key = `${prefix}doc-1`;
    const updated = await update(index, 'doc-1', { text: 'The moon is in the sky' }, { options: {} });
    expect(updated.status, JSON.stringify(updated.error)).toBe('success');
    expect(await raw.hget(key, 'text')).toBe('text: The moon is in the sky');
    expect(await docCount(index)).toBe(5);
    const again = await update(index, 'doc-1', { text: 'Cats and dogs and a pet cat' });
    expect(again.status).toBe('success');
    expect(await docCount(index)).toBe(5);
    expect(await raw.hget(key, 'text')).toBe('text: Cats and dogs and a pet cat');
  });

  it('puts the filter only in the query string and never the search text', async () => {
    const { index, prefix } = names();
    expect((await insert(index, { keyPrefix: prefix })).status).toBe('success');
    const call = vi.spyOn(Redis.prototype, 'call');
    const prompt = `pizza") => [KNN 1 @x $y] ; FLUSHALL`;
    const r = await load(index, prompt, { topK: 3, options: { keyPrefix: prefix } });
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const search = call.mock.calls.find((c) => c[0] === 'FT.SEARCH')!;
    const args = search.map((a) => (Buffer.isBuffer(a) ? '<buffer>' : String(a)));
    expect(args.slice(0, 3)).toEqual(['FT.SEARCH', index, '(*)=>[KNN 3 @embedding $B AS score]']);
    expect(args.join(' ')).not.toContain('FLUSHALL');
    expect(args).toEqual(
      expect.arrayContaining(['PARAMS', '2', 'B', '<buffer>', 'SORTBY', 'score', 'DIALECT', '2']),
    );
    expect(args[args.indexOf('LIMIT') + 2]).toBe('3');
    const commands = call.mock.calls.map((c) => String(c[0]).toUpperCase());
    expect(commands).not.toContain('FLUSHALL');
  });

  it('filters with a query expression over the metadata schema', async () => {
    const { index, prefix } = names();
    const schema = JSON.stringify([
      { name: 'topic', type: 'tag' },
      { name: 'price', type: 'numeric', options: { sortable: true } },
    ]);
    const inserted = await insert(index, { keyPrefix: prefix, metadataSchema: schema });
    expect(inserted.status, JSON.stringify(inserted.error)).toBe('success');

    const tag = await load(index, 'pizza', {
      topK: 4,
      options: { keyPrefix: prefix, metadataFilter: '@topic:{animals|vehicles}' },
    });
    expect(tag.status, JSON.stringify(tag.error)).toBe('success');
    const topics = (tag.output('Store') as Array<{ document: { metadata: DataObject } }>).map(
      (row) => row.document.metadata.topic,
    );
    expect(topics.sort()).toEqual(['animals', 'vehicles']);

    const range = await load(index, 'pizza', {
      topK: 4,
      options: { keyPrefix: prefix, metadataFilter: '@topic:{food|space} @price:[0 20]' },
    });
    expect(
      range.output('Store').map((row) => (row as { document: DataObject }).document.pageContent),
    ).toEqual(['Pizza and pasta are food']);

    // a filter the server cannot parse is an error, not a silent empty result
    const bad = await load(index, 'pizza', { options: { keyPrefix: prefix, metadataFilter: '@topic:{' } });
    expect(bad.status).toBe('error');
    expect(bad.error?.message).toMatch(/search|query|syntax/i);
  });

  it('infers the metadata schema from the documents when none is given', async () => {
    const { index, prefix } = names();
    expect((await insert(index, { keyPrefix: prefix })).status).toBe('success');
    const attributes = JSON.stringify(await raw.call('FT.INFO', index));
    expect(attributes).toContain('topic');
    expect(attributes).toContain('NUMERIC');
    const r = await load(index, 'pizza', {
      topK: 4,
      options: { keyPrefix: prefix, metadataFilter: '@price:[10 60]' },
    });
    expect(r.output('Store')).toHaveLength(2);
  });

  it('sets a time-to-live on inserted documents', async () => {
    const { index, prefix } = names();
    expect((await insert(index, { keyPrefix: prefix, ttl: 120 })).status).toBe('success');
    for (const key of await raw.keys(`${prefix}*`)) {
      const ttl = await raw.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);
    }
    const plain = names();
    expect((await insert(plain.index, { keyPrefix: plain.prefix })).status).toBe('success');
    for (const key of await raw.keys(`${plain.prefix}*`)) expect(await raw.ttl(key)).toBe(-1);
    const bad = await insert(plain.index, { keyPrefix: plain.prefix, ttl: -5 });
    expect(bad.status).toBe('error');
    expect(bad.error?.message).toMatch(/Time-To-Live/);
  });

  it('adds to an index, or drops it with its documents when Overwrite Documents is on', async () => {
    const { index, prefix } = names();
    expect((await insert(index, { keyPrefix: prefix })).status).toBe('success');
    expect((await insert(index, { keyPrefix: prefix })).status).toBe('success');
    expect(await docCount(index)).toBe(8);
    const over = await insert(index, { keyPrefix: prefix, overwriteDocuments: true }, DOCS.slice(0, 1));
    expect(over.status, JSON.stringify(over.error)).toBe('success');
    expect(await docCount(index)).toBe(1);
    expect(await raw.keys(`${prefix}*`)).toHaveLength(1);
  });

  it('refuses a vector of another size than the index holds', async () => {
    const { index, prefix } = names();
    await raw.call(
      'FT.CREATE',
      index,
      'ON',
      'HASH',
      'PREFIX',
      '1',
      prefix,
      'SCHEMA',
      'text',
      'TEXT',
      'metadata',
      'TEXT',
      'embedding',
      'VECTOR',
      'FLAT',
      '6',
      'TYPE',
      'FLOAT32',
      'DIM',
      '3',
      'DISTANCE_METRIC',
      'COSINE',
    );
    const r = await insert(index, { keyPrefix: prefix });
    expect(r.status).toBe('error');
    expect(messageOf(r)).toMatch(/3 dimensions/);
    expect(messageOf(r)).toMatch(new RegExp(`${VOCABULARY.length}`));
  });

  it('reports a missing index', async () => {
    const { index } = names();
    const searched = await load(index, 'pizza');
    expect(searched.status).toBe('error');
    expect(searched.error?.message).toBe(`Index ${index} not found`);
    expect(messageOf(searched)).toMatch(/check that the index exists/);
    const updated = await update(index, 'x', { text: 'hello' });
    expect(updated.status).toBe('error');
    expect(updated.error?.message).toBe(`Index ${index} not found`);
  });

  it('refuses bad index, prefix and field names before any command', async () => {
    const call = vi.spyOn(Redis.prototype, 'call');
    const cases: Array<[string, DataObject, RegExp]> = [
      ['bad index', {}, /index name/i],
      ['p5s2 x', {}, /index name/i],
      ['*', {}, /index name/i],
    ];
    for (const [index, options, message] of cases) {
      const r = await insert(index, options);
      expect(r.status).toBe('error');
      expect(r.error?.message).toMatch(message);
    }
    const { index } = names();
    for (const [options, message] of [
      [{ keyPrefix: 'doc* ' }, /Key Prefix/],
      [{ contentKey: 'a b' }, /Content Key/],
      [{ metadataKey: '@meta' }, /Metadata Key/],
      [{ embeddingKey: 'v"' }, /Embedding Key/],
      [{ contentKey: 'same', metadataKey: 'same' }, /different/],
    ] as Array<[DataObject, RegExp]>) {
      const r = await insert(index, options);
      expect(r.status).toBe('error');
      expect(r.error?.message).toMatch(message);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('gives n8n texts for a bad metadata schema', async () => {
    const { index, prefix } = names();
    const json = await insert(index, { keyPrefix: prefix, metadataSchema: '[{' });
    expect(json.error?.message).toMatch(/^Invalid metadata schema JSON: /);
    const notArray = await insert(index, { keyPrefix: prefix, metadataSchema: '{"name":"a"}' });
    expect(notArray.error?.message).toBe('Invalid metadata schema: must be a JSON array');
    const type = await insert(index, {
      keyPrefix: prefix,
      metadataSchema: '[{"name":"topic","type":"vector"}]',
    });
    expect(type.error?.message).toBe(
      'Invalid metadata schema: field type "vector" is not valid. Must be one of: tag, text, numeric, geo',
    );
    const name = await insert(index, {
      keyPrefix: prefix,
      metadataSchema: '[{"name":"text","type":"tag"}]',
    });
    expect(name.status).toBe('error');
    expect(name.error?.message).toMatch(/Invalid metadata schema/);
    expect(await raw.call('FT._LIST')).not.toContain(index);
  });

  it('lists the indexes of the database', async () => {
    const { index, prefix } = names();
    expect((await insert(index, { keyPrefix: prefix })).status).toBe('success');
    const http = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });
    const ctx = {
      getCredentials: async () => REDIS_SEARCH_CREDENTIALS,
      helpers: { resolveAllowedHost: (host: string) => http.resolveAllowedHost(host) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getTenantId: () => 't1',
      getExecutionId: () => `list-${suffix}`,
      getNode: () => store('load', index),
    } as unknown as LoadOptionsContext;
    const search = VectorStoreRedisNode.methods!.listSearch!.redisIndexSearch;
    const all = await search(ctx);
    expect(all.results.map((r) => r.value)).toEqual(expect.arrayContaining([index]));
    const filtered = await search(ctx, index.toUpperCase());
    expect(filtered.results).toEqual([{ name: index, value: index }]);
    expect(sharedResourceCount()).toBe(0);
  });

  it('has the n8n shape: credential, modes, no filter list', () => {
    const description = VectorStoreRedisNode.description;
    expect(description.credentials).toEqual([{ name: 'redis', required: true }]);
    const mode = description.properties.find((p) => p.name === 'mode');
    expect(JSON.stringify(mode)).toContain('update');
    expect(description.properties.some((p) => p.name === 'redisIndex')).toBe(true);
  });
});
