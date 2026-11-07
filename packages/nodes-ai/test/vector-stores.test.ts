import { HttpClient } from '@workflow/core';
import type { DataObject, Item, WorkflowNode } from '@workflow/workflow';
import { evaluateSimple } from '@workflow/workflow';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  VECTOR_STORE_INPUTS,
  VECTOR_STORE_OUTPUTS,
} from '../src/nodes/vector-stores/vector-store-factory';
import {
  clearMemoryVectorStores,
  MemoryVectorBackend,
  VectorStoreInMemoryNode,
  VectorStoreQdrantNode,
} from '../src/nodes/vector-stores/vector-stores.nodes';
import {
  connect,
  embeddingCalls,
  FakeHttpClient,
  fakeVector,
  modelRequests,
  node,
  PG_CREDENTIALS,
  run,
  scriptModel,
  services,
} from './harness';

const DOCS: Item[] = [
  { json: { text: 'Cats and dogs are pets', topic: 'animals' } },
  { json: { text: 'A car has an engine and drives on the road', topic: 'vehicles' } },
  { json: { text: 'Pizza and pasta are food', topic: 'food' } },
  { json: { text: 'The sun and the moon are in the sky', topic: 'space' } },
];

function loader(extra: DataObject = {}) {
  return node('Loader', 'ai.documentDefaultDataLoader', {
    jsonMode: 'expressionData',
    jsonData: '={{ $json.text }}',
    options: { metadata: { metadataValues: [{ name: 'topic', value: '={{ $json.topic }}' }] } },
    ...extra,
  });
}

async function insert(store: WorkflowNode, svc = services(), items = DOCS) {
  return run(
    [node('Trigger', 'test.trigger'), store, loader(), node('Embeddings', 'test.fakeEmbeddings')],
    connect(
      ['Trigger', store.name],
      ['Loader', store.name, 'ai_document'],
      ['Embeddings', store.name, 'ai_embedding'],
    ),
    { triggerItems: items, services: svc },
  );
}

async function load(store: WorkflowNode, prompt: string, svc = services()) {
  return run(
    [node('Trigger', 'test.trigger'), store, node('Embeddings', 'test.fakeEmbeddings')],
    connect(['Trigger', store.name], ['Embeddings', store.name, 'ai_embedding']),
    { triggerItems: [{ json: { chatInput: prompt } }], services: svc },
  );
}

/** Retrieval QA chain over a store in retrieve mode. */
async function ask(store: WorkflowNode, question: string, svc = services()) {
  const requests = scriptModel('Model', ['Answer from context']);
  const r = await run(
    [
      node('Trigger', 'test.trigger'),
      node('QA', 'ai.chainRetrievalQa', { options: { topK: 1, returnSourceDocuments: true } }),
      node('Model', 'test.fakeChatModel'),
      store,
      node('Embeddings', 'test.fakeEmbeddings'),
    ],
    connect(
      ['Trigger', 'QA'],
      ['Model', 'QA', 'ai_languageModel'],
      [store.name, 'QA', 'ai_vectorStore'],
      ['Embeddings', store.name, 'ai_embedding'],
    ),
    { triggerItems: [{ json: { chatInput: question } }], services: svc },
  );
  return { r, requests };
}

describe('vector store ports', () => {
  it('change with the operation mode', () => {
    const ports = (expr: string, mode?: string) =>
      evaluateSimple(expr, { $parameter: mode ? { mode } : {} }) as Array<string | { type: string }>;
    const types = (list: Array<string | { type: string }>) =>
      list.map((p) => (typeof p === 'string' ? p : p.type));
    expect(types(ports(VECTOR_STORE_INPUTS, 'insert'))).toEqual(['main', 'ai_document', 'ai_embedding']);
    expect(types(ports(VECTOR_STORE_INPUTS, 'load'))).toEqual(['main', 'ai_embedding']);
    expect(types(ports(VECTOR_STORE_INPUTS))).toEqual(['ai_embedding']);
    expect(types(ports(VECTOR_STORE_OUTPUTS))).toEqual(['ai_vectorStore']);
    expect(types(ports(VECTOR_STORE_OUTPUTS, 'load'))).toEqual(['main']);
  });

  it('cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('In-memory vector store', () => {
  beforeEach(() => {
    clearMemoryVectorStores();
    embeddingCalls.length = 0;
  });
  const store = (mode: string, extra: DataObject = {}) =>
    node('Store', 'ai.vectorStoreInMemory', { mode, memoryKey: 'kb', ...extra });

  it('inserts documents and outputs them paired to their items', async () => {
    const r = await insert(store('insert'));
    expect(r.status).toBe('success');
    expect(r.output('Store')).toEqual(
      DOCS.map((d) => ({ pageContent: d.json.text, metadata: { source: 'json', topic: d.json.topic } })),
    );
    const items = r.runData.Store[0].data.main[0];
    expect(items.map((i: Item) => i.pairedItem)).toEqual([
      { item: 0 },
      { item: 1 },
      { item: 2 },
      { item: 3 },
    ]);
    // embedded in one batch
    expect(embeddingCalls).toHaveLength(1);
  });

  it('loads the top-k documents for a prompt, with a metadata filter', async () => {
    await insert(store('insert'));
    const r = await load(store('load', { prompt: '={{ $json.chatInput }}', topK: 2 }), 'my dog and cat');
    const out = r.output('Store');
    expect(out).toHaveLength(2);
    expect((out[0].document as DataObject).pageContent).toBe('Cats and dogs are pets');
    expect(out[0].score as number).toBeGreaterThan(out[1].score as number);

    // the Simple store has no filter field (the metadata filter is tested on PGVector)
    const optionNames = VectorStoreInMemoryNode.description.properties
      .filter((p) => p.name === 'options')
      .flatMap((p) => ((p.options ?? []) as Array<{ name: string }>).map((o) => o.name));
    expect(optionNames).not.toContain('metadata');
  });

  it('serves chains in retrieve mode', async () => {
    await insert(store('insert'));
    const { r, requests } = await ask(store('retrieve'), 'what about the engine of a car?');
    expect(r.status).toBe('success');
    expect(r.output('QA')).toEqual([
      {
        response: 'Answer from context',
        sourceDocuments: [
          {
            pageContent: 'A car has an engine and drives on the road',
            metadata: { source: 'json', topic: 'vehicles' },
          },
        ],
      },
    ]);
    expect(requests[0].messages[0].content).toContain('A car has an engine');
    expect(requests[0].messages[1]).toEqual({ role: 'user', content: 'what about the engine of a car?' });
  });

  it('serves chains through the vector store retriever', async () => {
    await insert(store('insert'));
    const requests = scriptModel('Model', ['From the retriever']);
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('QA', 'ai.chainRetrievalQa', { promptType: 'define', text: 'pizza or pasta?' }),
        node('Model', 'test.fakeChatModel'),
        node('Retriever', 'ai.retrieverVectorStore', { topK: 2 }),
        store('retrieve'),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(
        ['Trigger', 'QA'],
        ['Model', 'QA', 'ai_languageModel'],
        ['Retriever', 'QA', 'ai_retriever'],
        ['Store', 'Retriever', 'ai_vectorStore'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('QA')).toEqual([{ response: 'From the retriever' }]);
    const context = String(requests[0].messages[0].content);
    expect(context).toContain('Pizza and pasta are food');
    expect(context.match(/\n\n/g)?.length).toBeGreaterThanOrEqual(1); // two documents
    expect(r.runData.Retriever).toHaveLength(1);
  });

  it('is scoped to the tenant', async () => {
    await insert(store('insert'), services({ tenantId: 'tenant-a' }));
    const r = await load(store('load'), 'dog', services({ tenantId: 'tenant-b' }));
    expect(r.output('Store')).toEqual([]);
    const own = await load(store('load'), 'dog', services({ tenantId: 'tenant-a' }));
    expect(own.output('Store').length).toBeGreaterThan(0);
  });

  it('clears the store on insert when asked', async () => {
    await insert(store('insert'));
    await insert(store('insert', { options: { clearStore: true } }), services(), [DOCS[2]]);
    const r = await load(store('load', { topK: 10 }), 'dog');
    expect(r.output('Store')).toHaveLength(1);
  });

  it('is bounded in size', async () => {
    const backend = new MemoryVectorBackend(3);
    await backend.add(
      [1, 2, 3, 4].map((n) => ({ pageContent: `d${n}`, metadata: {} })),
      [1, 2, 3, 4].map(() => [1]),
    );
    expect(backend.size).toBe(3);
    expect((await backend.search([1], 10)).map((r) => r.document.pageContent)).toEqual(['d2', 'd3', 'd4']);
  });

  it('cannot run in retrieve mode as a main node', async () => {
    const r = await load(store('retrieve'), 'dog');
    expect(r.status).toBe('error');
  });
});

describe('PGVector store', () => {
  const table = `ai_vectors_test_${process.pid}_${Date.now()}`;
  const client = new pg.Client({ ...PG_CREDENTIALS });
  const creds = { postgres: PG_CREDENTIALS };
  const svc = () => services({ creds, http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) });
  const store = (mode: string, extra: DataObject = {}) =>
    node(
      'Store',
      'ai.vectorStorePGVector',
      { mode, tableName: table, ...extra },
      { credentials: { postgres: { id: 'pg', name: 'pg' } } },
    );

  beforeAll(() => client.connect());
  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS "${table}"`);
    await client.end();
  });

  it('returns nothing before the table exists', async () => {
    const r = await load(store('load'), 'dog', svc());
    expect(r.status).toBe('success');
    expect(r.output('Store')).toEqual([]);
  });

  it('creates a vector table sized to the embeddings and inserts', async () => {
    const r = await insert(store('insert'), svc());
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const column = await client.query(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'embedding'`,
      [table],
    );
    expect(column.rows[0].type).toBe(`vector(${fakeVector('x').length})`);
    expect((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBe(4);
  });

  it('searches by cosine distance with a jsonb metadata filter', async () => {
    const r = await load(store('load', { topK: 2 }), 'pizza please', svc());
    const out = r.output('Store');
    expect((out[0].document as DataObject).pageContent).toBe('Pizza and pasta are food');
    expect(out[0].score as number).toBeCloseTo(1 / Math.sqrt(3), 5);

    const filtered = await load(
      store('load', {
        topK: 5,
        options: { metadata: { metadataValues: [{ name: 'topic', value: 'space' }] } },
      }),
      'pizza',
      svc(),
    );
    expect(filtered.output('Store').map((o) => (o.document as DataObject).pageContent)).toEqual([
      'The sun and the moon are in the sky',
    ]);
  });

  it('supplies a store to chains in retrieve mode', async () => {
    const { r, requests } = await ask(store('retrieve'), 'tell me about the moon', svc());
    expect(r.status).toBe('success');
    expect(requests[0].messages[0].content).toContain('The sun and the moon');
  });

  it('clears the table on insert when asked', async () => {
    await insert(store('insert', { options: { clearStore: true } }), svc(), [DOCS[0]]);
    expect((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBe(1);
  });

  it('checks the host against the SSRF policy', async () => {
    const r = await load(store('load'), 'dog', services({ creds, http: new HttpClient() }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/blocked/);
  });
});

describe('Qdrant store', () => {
  it('creates the collection, upserts points and searches over HTTP', async () => {
    const http = new FakeHttpClient((req) => {
      if (req.method === undefined || req.method === 'GET')
        return { status: 404, body: { status: { error: 'Not found' } } };
      if (req.url.endsWith('/points/search')) {
        return {
          body: {
            result: [
              {
                id: 'x',
                score: 0.93,
                payload: { content: 'Cats and dogs are pets', metadata: { topic: 'animals' } },
              },
            ],
          },
        };
      }
      return { body: { result: true, status: 'ok' } };
    });
    const creds = { qdrantApi: { url: 'https://qdrant.example.com:6333/', apiKey: 'q-key' } };
    const store = (mode: string, extra: DataObject = {}) =>
      node(
        'Store',
        'ai.vectorStoreQdrant',
        { mode, qdrantCollection: 'docs', ...extra },
        { credentials: { qdrantApi: { id: 'q', name: 'q' } } },
      );

    const inserted = await insert(store('insert'), services({ creds, http }));
    expect(inserted.status, JSON.stringify(inserted.error)).toBe('success');
    const [check, create, upsert] = http.requests;
    expect(check.url).toBe('https://qdrant.example.com:6333/collections/docs');
    expect(check.headers?.['api-key']).toBe('q-key');
    expect(create).toMatchObject({
      method: 'PUT',
      body: { vectors: { size: fakeVector('x').length, distance: 'Cosine' } },
    });
    expect(upsert.url).toBe('https://qdrant.example.com:6333/collections/docs/points');
    expect(upsert.qs).toEqual({ wait: 'true' });
    const points = (upsert.body as { points: Array<{ id: string; vector: number[]; payload: DataObject }> })
      .points;
    expect(points).toHaveLength(4);
    expect(points[0].payload).toEqual({
      content: 'Cats and dogs are pets',
      metadata: { source: 'json', topic: 'animals' },
    });
    expect(points[0].id).toMatch(/^[0-9a-f-]{36}$/);

    const loaded = await load(
      store('load', {
        topK: 3,
        options: { searchFilterJson: '{"must":[{"key":"metadata.topic","match":{"value":"animals"}}]}' },
      }),
      'dog',
      services({ creds, http }),
    );
    expect(loaded.output('Store')).toEqual([
      { document: { pageContent: 'Cats and dogs are pets', metadata: { topic: 'animals' } }, score: 0.93 },
    ]);
    const search = http.requests.at(-1)!;
    expect(search.body).toMatchObject({
      limit: 3,
      with_payload: true,
      filter: { must: [{ key: 'metadata.topic', match: { value: 'animals' } }] },
    });
  });

  it('rejects unsafe collection names', async () => {
    const http = new FakeHttpClient(() => ({ body: {} }));
    const r = await load(
      node(
        'Store',
        'ai.vectorStoreQdrant',
        { mode: 'load', qdrantCollection: '../admin' },
        { credentials: { qdrantApi: { id: 'q', name: 'q' } } },
      ),
      'x',
      services({ creds: { qdrantApi: { url: 'https://q.example.com' } }, http }),
    );
    expect(r.status).toBe('error');
    expect(http.requests).toHaveLength(0);
  });
});

describe('PGVector options', () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const tables: string[] = [];
  const client = new pg.Client({ ...PG_CREDENTIALS });
  const creds = { postgres: PG_CREDENTIALS };
  const svc = () => services({ creds, http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) });
  const tableFor = (label: string) => {
    const table = `ai_vec_${label}_${stamp}`;
    tables.push(table);
    return table;
  };
  const store = (mode: string, table: string, options: DataObject = {}) =>
    node(
      'Store',
      'ai.vectorStorePGVector',
      { mode, tableName: table, options },
      { credentials: { postgres: { id: 'pg', name: 'pg' } } },
    );

  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const table of tables) await client.query(`DROP TABLE IF EXISTS "${table}"`);
    await client.query(`DROP TABLE IF EXISTS "ai_vec_colls_${stamp}"`);
    await client.end();
  });

  it('scores each distance strategy as higher for a closer document', async () => {
    const table = tableFor('distance');
    expect((await insert(store('insert', table), svc())).status).toBe('success');
    // the query is the unit vector of "pizza"; the pizza document is (food, pizza, pasta)
    const scores: Record<string, number> = {};
    for (const distanceStrategy of ['cosine', 'innerProduct', 'euclidean']) {
      const r = await load(store('load', table, { distanceStrategy, topK: 2 }), 'pizza please', svc());
      expect(r.status, JSON.stringify(r.error)).toBe('success');
      const out = r.output('Store');
      expect(pageContent(out[0])).toBe('Pizza and pasta are food');
      expect(out[0].score as number).toBeGreaterThan(out[1].score as number);
      scores[distanceStrategy] = out[0].score as number;
    }
    expect(scores.cosine).toBeCloseTo(1 / Math.sqrt(3), 5);
    expect(scores.innerProduct).toBeCloseTo(1, 5);
    expect(scores.euclidean).toBeCloseTo(1 / (1 + Math.SQRT2), 5);
  });

  it('refuses an unknown distance strategy', async () => {
    const table = tableFor('badstrategy');
    const r = await load(store('load', table, { distanceStrategy: 'x <=> y; --' }), 'dog', svc());
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/Unknown distance strategy/);
  });

  it('uses the configured column names', async () => {
    const table = tableFor('columns');
    const columnNames = {
      values: {
        idColumnName: 'doc_id',
        vectorColumnName: 'vec',
        contentColumnName: 'body',
        metadataColumnName: 'meta',
      },
    };
    expect((await insert(store('insert', table, { columnNames }), svc())).status).toBe('success');
    const columns = await client.query(
      `SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 ORDER BY attnum`,
      [table],
    );
    expect(columns.rows.map((r) => r.attname)).toEqual(['doc_id', 'body', 'meta', 'vec']);
    const r = await load(store('load', table, { columnNames, topK: 1 }), 'moon', svc());
    expect(pageContent(r.output('Store')[0])).toBe('The sun and the moon are in the sky');
  });

  it('refuses a column name that is not a plain identifier, before any query on the table', async () => {
    const table = tableFor('injection');
    for (const field of ['idColumnName', 'vectorColumnName', 'contentColumnName', 'metadataColumnName']) {
      const columnNames = { values: { [field]: 'x"; DROP TABLE users; --' } };
      const r = await insert(store('insert', table, { columnNames }), svc());
      expect(r.status).toBe('error');
      expect(r.error?.message).toMatch(/Invalid column name/);
    }
    const tableName = await insert(store('insert', 'users; DROP TABLE x', {}), svc());
    expect(tableName.error?.message).toMatch(/Invalid table name/);
    const exists = await client.query('SELECT to_regclass($1) AS t', [table]);
    expect(exists.rows[0].t).toBeNull();
  });

  it('keeps several collections in one table', async () => {
    const table = tableFor('collections');
    const collection = (name: string) => ({
      values: {
        useCollection: true,
        collectionName: name,
        collectionTableName: `ai_vec_colls_${stamp}`,
      },
    });
    const ins = await insert(store('insert', table, { collection: collection('pets') }), svc(), [DOCS[0]]);
    expect(ins.status, JSON.stringify(ins.error)).toBe('success');
    await insert(store('insert', table, { collection: collection('food') }), svc(), [DOCS[2]]);
    const pets = await load(
      store('load', table, { collection: collection('pets'), topK: 5 }),
      'pizza',
      svc(),
    );
    expect(pets.output('Store').map(pageContent)).toEqual(['Cats and dogs are pets']);
    const food = await load(
      store('load', table, { collection: collection('food'), topK: 5 }),
      'pizza',
      svc(),
    );
    expect(food.output('Store').map(pageContent)).toEqual(['Pizza and pasta are food']);
    const none = await load(store('load', table, { collection: collection('nothing') }), 'pizza', svc());
    expect(none.output('Store')).toEqual([]);
    expect((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBe(2);
    // clearing one collection leaves the other
    await insert(store('insert', table, { collection: collection('pets'), clearStore: true }), svc(), [
      DOCS[1],
    ]);
    const all = await load(store('load', table, { topK: 5 }), 'pizza', svc());
    expect(all.output('Store')).toHaveLength(2);
    const petsNow = await load(
      store('load', table, { collection: collection('pets'), topK: 5 }),
      'car',
      svc(),
    );
    expect(petsNow.output('Store').map(pageContent)).toEqual(['A car has an engine and drives on the road']);
  });

  it('leaves the table alone when initialization is skipped', async () => {
    const table = tableFor('skip');
    const skipped = await insert(store('insert', table, { skipInitialization: true }), svc());
    expect(skipped.status).toBe('error');
    const exists = await client.query('SELECT to_regclass($1) AS t', [table]);
    expect(exists.rows[0].t).toBeNull();
    await insert(store('insert', table), svc(), [DOCS[0]]);
    const again = await insert(store('insert', table, { skipInitialization: true }), svc(), [DOCS[2]]);
    expect(again.status, JSON.stringify(again.error)).toBe('success');
    expect((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBe(2);
  });
});

describe('Qdrant options', () => {
  const creds = { qdrantApi: { url: 'https://qdrant.example.com:6333', apiKey: 'q-key' } };
  const store = (mode: string, extra: DataObject = {}) =>
    node(
      'Store',
      'ai.vectorStoreQdrant',
      { mode, qdrantCollection: { __rl: true, mode: 'list', value: 'docs' }, ...extra },
      { credentials: { qdrantApi: { id: 'q', name: 'q' } } },
    );
  const fake = () =>
    new FakeHttpClient((req) => {
      if (req.method === undefined || req.method === 'GET') return { status: 404, body: {} };
      if (req.url.endsWith('/points/search')) {
        return { body: { result: [{ score: 0.5, payload: { body: 'Cats', meta: { topic: 'animals' } } }] } };
      }
      return { body: { result: true } };
    });

  it('writes and reads the configured payload keys, and sends the collection config on create', async () => {
    const http = fake();
    const options = {
      contentPayloadKey: 'body',
      metadataPayloadKey: 'meta',
      collectionConfig: '{"on_disk_payload":true,"vectors":{"distance":"Dot","size":3}}',
    };
    const r = await insert(store('insert', { options }), services({ creds, http }), [DOCS[0]]);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const [, create, upsert] = http.requests;
    expect(create.body).toEqual({
      on_disk_payload: true,
      vectors: { distance: 'Dot', size: fakeVector('x').length },
    });
    const points = (upsert.body as { points: Array<{ payload: DataObject }> }).points;
    expect(points[0].payload).toEqual({
      body: 'Cats and dogs are pets',
      meta: { source: 'json', topic: 'animals' },
    });
    const loaded = await load(
      store('load', { options: { contentPayloadKey: 'body', metadataPayloadKey: 'meta' } }),
      'dog',
      services({ creds, http }),
    );
    expect(loaded.output('Store')).toEqual([
      { document: { pageContent: 'Cats', metadata: { topic: 'animals' } }, score: 0.5 },
    ]);
  });

  it('sends the search filter JSON as the filter as it is, and has no metadata filter list', async () => {
    const http = fake();
    const filter = {
      must: [{ key: 'lang', match: { value: 'en' } }],
      must_not: [{ key: 'x', match: { value: 1 } }],
    };
    const options = {
      metadataPayloadKey: 'meta',
      // a leftover metadata list from an older save is not read
      metadata: { metadataValues: [{ name: 'topic', value: 'animals' }] },
      searchFilterJson: JSON.stringify(filter),
    };
    const r = await load(store('load', { options }), 'dog', services({ creds, http }));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect((http.requests.at(-1)!.body as DataObject).filter).toEqual(filter);
    const names = (
      VectorStoreQdrantNode.description.properties.flatMap((p) => p.options ?? []) as Array<{
        name: string;
      }>
    ).map((o) => o.name);
    expect(names.filter((n) => n === 'searchFilterJson')).toHaveLength(1);
    expect(names).not.toContain('metadata');
  });

  it('sends no redirect-following request while the api-key header is set', async () => {
    const http = fake();
    await insert(store('insert'), services({ creds, http }), [DOCS[0]]);
    await load(store('load'), 'dog', services({ creds, http }));
    expect(http.requests.length).toBeGreaterThan(3);
    for (const request of http.requests) expect(request.followRedirects).toBe(false);
  });

  it('refuses bad payload keys and a filter that is not a JSON object, with no request', async () => {
    const http = fake();
    const bad = await load(
      store('load', { options: { contentPayloadKey: 'a.b' } }),
      'dog',
      services({ creds, http }),
    );
    expect(bad.status).toBe('error');
    const filter = await load(
      store('load', { options: { searchFilterJson: '[1]' } }),
      'dog',
      services({ creds, http }),
    );
    expect(filter.error?.message).toMatch(/must be a JSON object/);
    expect(http.requests).toHaveLength(0);
  });

  it('reads a plain collection name saved before the picker, and lists collections for it', async () => {
    const http = fake();
    await load(store('load', { qdrantCollection: 'plain' }), 'dog', services({ creds, http }));
    expect(http.requests[0].url).toBe('https://qdrant.example.com:6333/collections/plain/points/search');
    const list = VectorStoreQdrantNode.methods!.listSearch!.qdrantCollectionsSearch;
    const requested: string[] = [];
    const context = {
      getCredentials: async () => creds.qdrantApi,
      helpers: {
        httpRequestWithAuthentication: async (
          _type: string,
          options: { url: string; followRedirects?: boolean },
        ) => {
          requested.push(options.url);
          expect(options.followRedirects).toBe(false);
          return { result: { collections: [{ name: 'zeta' }, { name: 'Docs' }, { name: 'notes' }] } };
        },
      },
    } as never;
    expect((await list(context, 'DO')).results).toEqual([{ name: 'Docs', value: 'Docs' }]);
    expect((await list(context)).results.map((r) => r.value)).toEqual(['Docs', 'notes', 'zeta']);
    expect(requested[0]).toBe('https://qdrant.example.com:6333/collections');
  });
});

const pageContent = (o: DataObject) => (o.document as DataObject).pageContent;

// model scripts are per node name; make sure nothing leaks between files
afterAll(() => modelRequests.clear());
