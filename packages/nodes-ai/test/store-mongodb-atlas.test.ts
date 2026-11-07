/**
 * MongoDB Atlas Vector Store against the atlas-local test server (MONGO_TEST_URL), database
 * p5s2_atlas, dropped after the run. The search index builds asynchronously and new documents reach
 * it a moment after the write, so the setup and the searches poll with a timeout. Run with
 * `--testTimeout=180000`.
 */
import net from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject, Item, LoadOptionsContext, WorkflowNode } from '@workflow/workflow';
import { Collection, type Document, MongoClient } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { VectorStoreMongoDBAtlasNode } from '../src/nodes/vector-stores/mongodb-atlas';
import { sharedResourceCount } from '../src/shared/shared-resource';
import { connect, MONGO_TEST_URL, node, run, services, VOCABULARY } from './harness';

const DATABASE = 'p5s2_atlas';
const suffix = `${process.pid}_${Date.now()}`;
const COLLECTION = `docs_${suffix}`;
const FRESH = `fresh_${suffix}`;
const INDEX = `vi_${suffix}`;
const USER = `atlas_${suffix}`;
const PASSWORD = `Pw-${suffix}-s3cret`;
const SETUP_MS = 150_000;

/** a database user, so every error can be checked for the password */
const CREDENTIALS: DataObject = {
  configurationType: 'connectionString',
  connectionString: `mongodb://${USER}:${encodeURIComponent(PASSWORD)}@127.0.0.1:27017/${DATABASE}?directConnection=true&authSource=${DATABASE}`,
  database: DATABASE,
};

const raw = new MongoClient(MONGO_TEST_URL, { serverSelectionTimeoutMS: 10_000 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitQueryable(collection: Collection, name: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const [index] = await collection.listSearchIndexes(name).toArray();
    if ((index as { queryable?: boolean } | undefined)?.queryable === true) return;
    if (Date.now() > end) throw new Error(`search index ${name} not queryable after ${ms} ms`);
    await sleep(1000);
  }
}

beforeAll(async () => {
  await raw.connect();
  const db = raw.db(DATABASE);
  await db.command({ createUser: USER, pwd: PASSWORD, roles: [{ role: 'readWrite', db: DATABASE }] });
  await db.createCollection(COLLECTION);
  await db.collection(COLLECTION).createSearchIndex({
    name: INDEX,
    type: 'vectorSearch',
    definition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: VOCABULARY.length, similarity: 'cosine' },
        { type: 'filter', path: 'metadata.namespace' },
        { type: 'filter', path: 'topic' },
      ],
    },
  });
  await waitQueryable(db.collection(COLLECTION), INDEX);
}, SETUP_MS);

afterAll(async () => {
  const db = raw.db(DATABASE);
  await db.command({ dropAllUsersFromDatabase: 1 }).catch(() => {});
  await db.dropDatabase();
  await raw.close();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

const DOCS: Item[] = [
  { json: { text: 'Cats and dogs are pets', topic: 'animals' } },
  { json: { text: 'A car has an engine and drives on the road', topic: 'vehicles' } },
  { json: { text: 'Pizza and pasta are food', topic: 'food' } },
  { json: { text: 'The sun and the moon are in the sky', topic: 'space' } },
];

function store(mode: string, parameters: DataObject = {}): WorkflowNode {
  return node(
    'Store',
    'ai.vectorStoreMongoDBAtlas',
    {
      mode,
      mongoCollection: { __rl: true, mode: 'list', value: COLLECTION },
      embedding: 'embedding',
      metadata_field: 'text',
      vectorIndexName: INDEX,
      ...parameters,
    },
    { credentials: { mongoDb: { id: 'm', name: 'm' } } },
  );
}

const loader = () =>
  node('Loader', 'ai.documentDefaultDataLoader', {
    jsonMode: 'expressionData',
    jsonData: '={{ $json.text }}',
    options: { metadata: { metadataValues: [{ name: 'topic', value: '={{ $json.topic }}' }] } },
  });

const svc = (creds: DataObject = CREDENTIALS) =>
  services({ creds: { mongoDb: creds }, http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) });

function insert(parameters: DataObject, items: Item[] = DOCS, creds?: DataObject) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      store('insert', parameters),
      loader(),
      node('Embeddings', 'test.fakeEmbeddings'),
    ],
    connect(
      ['Trigger', 'Store'],
      ['Loader', 'Store', 'ai_document'],
      ['Embeddings', 'Store', 'ai_embedding'],
    ),
    { triggerItems: items, services: svc(creds) },
  );
}

function load(prompt: string, parameters: DataObject = {}, creds?: DataObject) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      store('load', { prompt, ...parameters }),
      node('Embeddings', 'test.fakeEmbeddings'),
    ],
    connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
    { triggerItems: [{ json: {} }], services: svc(creds) },
  );
}

function update(id: string, json: DataObject, parameters: DataObject = {}) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      store('update', { id, ...parameters }),
      node('Embeddings', 'test.fakeEmbeddings'),
    ],
    connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
    { triggerItems: [{ json }], services: svc() },
  );
}

interface Found {
  document: { pageContent: string; metadata: DataObject };
  score: number;
}

/** the search results once `ready` holds for them (new writes reach the search index a moment later) */
async function searchUntil(
  prompt: string,
  parameters: DataObject,
  ready: (found: Found[]) => boolean,
  ms = 60_000,
): Promise<Found[]> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await load(prompt, parameters);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const found = r.output('Store') as unknown as Found[];
    if (ready(found)) return found;
    if (Date.now() > end) throw new Error(`search results not ready: ${JSON.stringify(found)}`);
    await sleep(500);
  }
}

const texts = (found: Found[]) => found.map((f) => f.document.pageContent);
const namespaceOption = (namespace: string, extra: DataObject = {}) => ({ options: { namespace, ...extra } });

describe('description', () => {
  it("has n8n's parameters and options, with the index rule in the filter descriptions", () => {
    const { properties } = VectorStoreMongoDBAtlasNode.description;
    const top = properties.map((p) => [p.name, p.default]);
    expect(top).toEqual(
      expect.arrayContaining([
        ['mongoCollection', { __rl: true, mode: 'list', value: '' }],
        ['embedding', 'embedding'],
        ['metadata_field', 'text'],
        ['vectorIndexName', ''],
      ]),
    );
    const options = properties.filter((p) => p.name === 'options');
    const searchOptions = options.find((p) => p.displayOptions?.show?.mode?.includes('load'))!;
    const insertOptions = options.find((p) => p.displayOptions?.show?.mode?.includes('insert'))!;
    const names = (p: typeof searchOptions) => (p.options as Array<{ name: string }>).map((o) => o.name);
    expect(names(searchOptions)).toEqual(
      expect.arrayContaining(['metadata', 'namespace', 'preFilter', 'postFilterPipeline']),
    );
    expect(names(insertOptions)).toEqual(expect.arrayContaining(['clearNamespace', 'namespace']));
    const option = (p: typeof searchOptions, name: string) =>
      (p.options as Array<{ name: string; description?: string }>).find((o) => o.name === name)!;
    expect(option(searchOptions, 'namespace').description).toMatch(/metadata\.namespace.*filter/);
    expect(option(searchOptions, 'preFilter').description).toMatch(/index.*filter/);
    expect(VectorStoreMongoDBAtlasNode.methods?.listSearch?.mongoCollectionSearch).toBeTypeOf('function');
    expect(VectorStoreMongoDBAtlasNode.methods?.credentialTest?.mongoDbConnectionTest).toBeTypeOf('function');
  });
});

describe('MongoDB Atlas Vector Store on the test server', () => {
  it('inserts, updates and searches (done when)', async () => {
    const aggregate = vi.spyOn(Collection.prototype, 'aggregate');
    const ns = `main_${suffix}`;
    const inserted = await insert(namespaceOption(ns));
    expect(inserted.status, JSON.stringify(inserted.error)).toBe('success');
    expect(inserted.output('Store')).toHaveLength(4);

    // n8n's layout: text field, embedding field, metadata at the top level; namespace in metadata.namespace
    const stored = await raw
      .db(DATABASE)
      .collection(COLLECTION)
      .findOne({ text: 'Pizza and pasta are food' });
    expect(stored).toMatchObject({ topic: 'food', source: 'json', metadata: { namespace: ns } });
    expect(stored!.embedding).toHaveLength(VOCABULARY.length);

    const found = await searchUntil('pizza', { topK: 2, ...namespaceOption(ns) }, (f) => f.length === 2);
    expect(found[0].document.pageContent).toBe('Pizza and pasta are food');
    expect(found[0].document.metadata).toMatchObject({
      topic: 'food',
      source: 'json',
      _id: String(stored!._id),
    });
    expect(found[0].document.metadata).not.toHaveProperty('embedding');
    expect(found[0].document.metadata).not.toHaveProperty('text');
    expect(found[0].score).toBeGreaterThan(found[1].score);

    // the pipeline: $vectorSearch with 10 x limit candidates, the score, nothing else
    const pipeline = aggregate.mock.calls.at(-1)![0] as Document[];
    expect(pipeline).toEqual([
      {
        $vectorSearch: {
          index: INDEX,
          path: 'embedding',
          queryVector: expect.any(Array),
          numCandidates: 20,
          limit: 2,
          filter: { 'metadata.namespace': { $eq: ns } },
        },
      },
      { $set: { score: { $meta: 'vectorSearchScore' } } },
    ]);

    // update replaces the document by its id and keeps its namespace
    const updated = await update(String(stored!._id), { text: 'The moon is in the sky' });
    expect(updated.status, JSON.stringify(updated.error)).toBe('success');
    const replaced = await raw.db(DATABASE).collection(COLLECTION).findOne({ _id: stored!._id });
    expect(replaced).toMatchObject({ text: 'text: The moon is in the sky', metadata: { namespace: ns } });
    expect(replaced).not.toHaveProperty('topic');
    const afterUpdate = await searchUntil('moon', { topK: 1, ...namespaceOption(ns) }, (f) =>
      f[0]?.document.pageContent.includes('The moon is in the sky'),
    );
    expect(afterUpdate[0].document.metadata._id).toBe(String(stored!._id));
    expect(
      await raw.db(DATABASE).collection(COLLECTION).countDocuments({ text: 'Pizza and pasta are food' }),
    ).toBe(0);

    // an id that does not exist yet is inserted (upsert)
    const fresh = await update(`doc-${suffix}`, { text: 'A new pet' });
    expect(fresh.status, JSON.stringify(fresh.error)).toBe('success');
    expect(
      await raw
        .db(DATABASE)
        .collection(COLLECTION)
        .findOne({ _id: `doc-${suffix}` as never }),
    ).toMatchObject({
      text: 'text: A new pet',
    });
    expect(sharedResourceCount()).toBe(0);
  });

  it('creates the collection on insert and names a missing index', async () => {
    const r = await insert({ mongoCollection: { __rl: true, mode: 'name', value: FRESH } }, DOCS.slice(0, 1));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const names = (await raw.db(DATABASE).listCollections({ name: FRESH }).toArray()).map((c) => c.name);
    expect(names).toEqual([FRESH]);
    const missing = await load('pizza', {
      mongoCollection: { __rl: true, mode: 'name', value: FRESH },
      vectorIndexName: 'no_such_index',
    });
    expect(missing.status).toBe('error');
    expect(missing.error?.message).toBe('Index no_such_index not found');
  });

  it('keeps namespaces apart and clears one namespace', async () => {
    const a = `a_${suffix}`;
    const b = `b_${suffix}`;
    expect((await insert(namespaceOption(a), DOCS.slice(0, 2))).status).toBe('success');
    expect((await insert(namespaceOption(b), DOCS.slice(2, 4))).status).toBe('success');
    const inA = await searchUntil(
      'pets food sky road',
      { topK: 10, ...namespaceOption(a) },
      (f) => f.length === 2,
    );
    expect(texts(inA).sort()).toEqual([
      'A car has an engine and drives on the road',
      'Cats and dogs are pets',
    ]);
    await searchUntil('pets food sky road', { topK: 10, ...namespaceOption(b) }, (f) => f.length === 2);

    // Clear Namespace deletes namespace a only, then inserts
    const cleared = await insert(namespaceOption(a, { clearNamespace: true }), [
      { json: { text: 'Pasta for the dog', topic: 'food' } },
    ]);
    expect(cleared.status, JSON.stringify(cleared.error)).toBe('success');
    const docs = raw.db(DATABASE).collection(COLLECTION);
    expect(await docs.countDocuments({ 'metadata.namespace': a })).toBe(1);
    expect(await docs.countDocuments({ 'metadata.namespace': b })).toBe(2);
    await searchUntil(
      'pets food sky road dog pasta',
      { topK: 10, ...namespaceOption(a) },
      (f) => f.length === 1 && f[0].document.pageContent === 'Pasta for the dog',
    );

    const noNamespace = await insert({ options: { clearNamespace: true } }, DOCS.slice(0, 1));
    expect(noNamespace.status).toBe('error');
    expect(noNamespace.error?.message).toMatch(/Clear Namespace needs a Namespace/);
  });

  it('applies the pre filter, the metadata filter and the post filter pipeline', async () => {
    const ns = `filters_${suffix}`;
    expect((await insert(namespaceOption(ns))).status).toBe('success');
    const all = 'cat dog car engine pizza pasta sun moon';
    await searchUntil(all, { topK: 10, ...namespaceOption(ns) }, (f) => f.length === 4);

    const pre = await searchUntil(
      all,
      { topK: 10, ...namespaceOption(ns, { preFilter: '{"topic": {"$in": ["food", "space"]}}' }) },
      () => true,
    );
    expect(texts(pre).sort()).toEqual(['Pizza and pasta are food', 'The sun and the moon are in the sky']);

    const meta = await searchUntil(
      all,
      {
        topK: 10,
        ...namespaceOption(ns, { metadata: { metadataValues: [{ name: 'topic', value: 'vehicles' }] } }),
      },
      () => true,
    );
    expect(texts(meta)).toEqual(['A car has an engine and drives on the road']);

    const post = await searchUntil(
      'pizza',
      {
        topK: 10,
        ...namespaceOption(ns, {
          postFilterPipeline: JSON.stringify([
            { $match: { topic: { $ne: 'animals' } } },
            { $sort: { score: -1 } },
            { $limit: 2 },
            { $unset: 'source' },
          ]),
        }),
      },
      () => true,
    );
    expect(post).toHaveLength(2);
    expect(post[0].document.pageContent).toBe('Pizza and pasta are food');
    expect(
      post.every((f) => !('source' in f.document.metadata) && f.document.metadata.topic !== 'animals'),
    ).toBe(true);
  });

  it('refuses post stages that write or run code, at any depth', async () => {
    const ns = `refuse_${suffix}`;
    const cases: Array<[pipeline: unknown, message: RegExp]> = [
      [[{ $match: { $and: [{ topic: 'food' }, { $where: 'sleep(100) || true' }] } }], /may not use \$where/],
      [
        [{ $set: { x: { $function: { body: 'function () { return 1 }', args: [], lang: 'js' } } } }],
        /may not use \$function/,
      ],
      [[{ $out: 'stolen' }], /stage \$out is not allowed/],
      [[{ $merge: { into: 'stolen' } }], /stage \$merge is not allowed/],
      [[{ $lookup: { from: 'other', as: 'x', pipeline: [] } }], /stage \$lookup is not allowed/],
      [[{ $group: { _id: null } }], /stage \$group is not allowed/],
      [{ $match: {} }, /must be a JSON array/],
    ];
    const aggregate = vi.spyOn(Collection.prototype, 'aggregate');
    for (const [pipeline, message] of cases) {
      const r = await load('pizza', namespaceOption(ns, { postFilterPipeline: JSON.stringify(pipeline) }));
      expect(r.status).toBe('error');
      expect(r.error?.message).toMatch(message);
    }
    let deep: unknown = { $function: { body: 'x', args: [], lang: 'js' } };
    for (let i = 0; i < 100; i++) deep = { $and: [deep] };
    const tooDeep = await load(
      'pizza',
      namespaceOption(ns, { postFilterPipeline: JSON.stringify([{ $match: deep }]) }),
    );
    expect(tooDeep.status).toBe('error');
    expect(tooDeep.error?.message).toMatch(/nested too deeply/);
    const preFilter = await load('pizza', namespaceOption(ns, { preFilter: '{"$where": "true"}' }));
    expect(preFilter.error?.message).toMatch(/may not use \$where/);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('names an undeclared filter field and keeps the password out', async () => {
    const ns = `undeclared_${suffix}`;
    const r = await load(
      'pizza',
      namespaceOption(ns, { metadata: { metadataValues: [{ name: 'source', value: 'json' }] } }),
    );
    expect(r.status).toBe('error');
    const message = `${r.error?.message} ${(r.error as DataObject | undefined)?.description ?? ''}`;
    expect(r.error?.message).toMatch(/"source"/);
    expect(message).toMatch(/type "filter"/);
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain(encodeURIComponent(PASSWORD));
    expect(message).not.toContain('mongodb://');
  });

  it('refuses unsafe field names before any database call', async () => {
    const r = await load('pizza', { embedding: '$where' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/Embedding/);
    const same = await load('pizza', { embedding: 'text' });
    expect(same.error?.message).toMatch(/must differ/);
  });

  it('lists the collections of the database', async () => {
    const http = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });
    const ctx = {
      getCredentials: async () => CREDENTIALS,
      helpers: { resolveAllowedHost: (host: string) => http.resolveAllowedHost(host) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getTenantId: () => 't1',
      getExecutionId: () => `list-${suffix}`,
      getNode: () => store('load'),
    } as unknown as LoadOptionsContext;
    const search = VectorStoreMongoDBAtlasNode.methods!.listSearch!.mongoCollectionSearch;
    const all = await search(ctx);
    expect(all.results.map((r) => r.value)).toEqual(expect.arrayContaining([COLLECTION]));
    const filtered = await search(ctx, `DOCS_${suffix}`);
    expect(filtered.results).toEqual([{ name: COLLECTION, value: COLLECTION }]);
    expect(sharedResourceCount()).toBe(0);
  });

  it('never connects to a blocked address (done when)', async () => {
    const connectSpy = vi.spyOn(net.Socket.prototype, 'connect');
    const blocked: DataObject = {
      configurationType: 'connectionString',
      connectionString: `mongodb://${USER}:${encodeURIComponent(PASSWORD)}@169.254.169.254:27017/${DATABASE}?serverSelectionTimeoutMS=1500`,
    };
    const r = await load('pizza', {}, blocked);
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/169\.254\.169\.254/);
    expect(r.error?.message).not.toContain(PASSWORD);
    expect(r.error?.message).not.toContain('mongodb://');
    const hosts = (connectSpy.mock.calls as unknown[][]).map((args) => {
      const first = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string } | number | string;
      return typeof first === 'object' && first
        ? first.host
        : typeof args[1] === 'string'
          ? args[1]
          : undefined;
    });
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).not.toContain('169.254.169.254');
    expect(sharedResourceCount()).toBe(0);
  });
});
