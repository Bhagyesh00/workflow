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
import { clearMemoryVectorStores, MemoryVectorBackend } from '../src/nodes/vector-stores/vector-stores.nodes';
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

    const filtered = await load(
      store('load', {
        topK: 5,
        options: { metadata: { metadataValues: [{ name: 'topic', value: 'food' }] } },
      }),
      'dog',
    );
    expect(filtered.output('Store').map((o) => (o.document as DataObject).metadata)).toEqual([
      { source: 'json', topic: 'food' },
    ]);
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
        options: { metadata: { metadataValues: [{ name: 'topic', value: 'animals' }] } },
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

// model scripts are per node name; make sure nothing leaks between files
afterAll(() => modelRequests.clear());
