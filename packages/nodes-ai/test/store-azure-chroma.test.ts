import type { DataObject, HttpRequestOptions, Item, WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { VectorStoreAzureAISearchNode } from '../src/nodes/vector-stores/azure-ai-search';
import { VectorStoreChromaDBNode } from '../src/nodes/vector-stores/chroma';
import {
  connect,
  FakeHttpClient,
  type FakeReply,
  fakeVector,
  node,
  run,
  services,
  toolNodeTypes,
} from './harness';

const DOCS: Item[] = [
  { json: { text: 'Cats and dogs are pets', topic: 'animals' } },
  { json: { text: 'A car has an engine and drives on the road', topic: 'vehicles' } },
];

type Svc = ReturnType<typeof services>;

function loader() {
  return node('Loader', 'ai.documentDefaultDataLoader', {
    jsonMode: 'expressionData',
    jsonData: '={{ $json.text }}',
    options: { metadata: { metadataValues: [{ name: 'topic', value: '={{ $json.topic }}' }] } },
  });
}

function header(request: HttpRequestOptions, name: string): unknown {
  const found = Object.entries(request.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

const svcOf = (creds: Record<string, DataObject>, http: FakeHttpClient): Svc =>
  services({ creds, http, nodeTypes: toolNodeTypes });

const insert = (store: WorkflowNode, svc: Svc, items = DOCS) =>
  run(
    [node('Trigger', 'test.trigger'), store, loader(), node('Embeddings', 'test.fakeEmbeddings')],
    connect(
      ['Trigger', store.name],
      ['Loader', store.name, 'ai_document'],
      ['Embeddings', store.name, 'ai_embedding'],
    ),
    { triggerItems: items, services: svc, nodeTypes: toolNodeTypes },
  );

const withEmbeddings = (store: WorkflowNode, items: Item[], svc: Svc) =>
  run(
    [node('Trigger', 'test.trigger'), store, node('Embeddings', 'test.fakeEmbeddings')],
    connect(['Trigger', store.name], ['Embeddings', store.name, 'ai_embedding']),
    { triggerItems: items, services: svc, nodeTypes: toolNodeTypes },
  );

const load = (store: WorkflowNode, prompt: string, svc: Svc) =>
  withEmbeddings(store, [{ json: { chatInput: prompt } }], svc);

// ---------------------------------------------------------------------------------------------
// Azure AI Search
// ---------------------------------------------------------------------------------------------

const AZ_BASE = 'https://svc1.search.windows.net';
const azCreds = { azureAiSearchApi: { endpoint: AZ_BASE, apiKey: 'az-secret-key' } };

function azureHttp(options: { indexExists?: boolean; fields?: string[] } = {}) {
  return new FakeHttpClient((req): FakeReply => {
    if (req.url.endsWith('/docs/search')) {
      return {
        body: {
          value: [
            {
              '@search.score': 0.8,
              id: 'a1',
              content: 'Cats and dogs are pets',
              metadata: JSON.stringify({ topic: 'animals' }),
            },
          ],
        },
      };
    }
    if (req.url.endsWith('/docs/index')) return { body: { value: [] } };
    if (req.method === 'GET' && req.url.includes('/indexes/')) {
      return options.indexExists
        ? {
            body: {
              name: 'docs',
              fields: (options.fields ?? ['id', 'content', 'content_vector', 'metadata']).map((name) => ({
                name,
              })),
            },
          }
        : { status: 404, body: { error: { message: 'not found' } } };
    }
    return { body: {} };
  });
}

const azure = (mode: string, extra: DataObject = {}) =>
  node(
    'Store',
    'ai.vectorStoreAzureAISearch',
    { mode, indexName: 'docs', ...extra },
    { credentials: { azureAiSearchApi: { id: 'a', name: 'a' } } },
  );

describe('Azure AI Search store', () => {
  it('creates the index from the first document and writes with mergeOrUpload', async () => {
    const http = azureHttp();
    const r = await insert(azure('insert', { options: { metadataKeys: 'topic' } }), svcOf(azCreds, http));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const [probe, create, write] = http.requests;
    expect(probe.method).toBe('GET');
    expect(probe.url).toBe(`${AZ_BASE}/indexes/docs`);
    expect(probe.qs).toEqual({ 'api-version': '2024-07-01' });
    expect(header(probe, 'api-key')).toBe('az-secret-key');
    expect(create.method).toBe('PUT');
    expect(create.url).toBe(`${AZ_BASE}/indexes/docs`);
    expect(create.followRedirects).toBe(false);
    const schema = create.body as {
      fields: Array<{ name: string; dimensions?: number; key?: boolean; filterable?: boolean }>;
    };
    expect(schema.fields.map((f) => f.name)).toEqual([
      'id',
      'content',
      'content_vector',
      'metadata',
      'topic',
    ]);
    expect(schema.fields.find((f) => f.name === 'content_vector')?.dimensions).toBe(fakeVector('x').length);
    expect(schema.fields.find((f) => f.name === 'topic')?.filterable).toBe(true);
    expect(write.method).toBe('POST');
    expect(write.url).toBe(`${AZ_BASE}/indexes/docs/docs/index`);
    expect(header(write, 'api-key')).toBe('az-secret-key');
    const rows = (write.body as { value: DataObject[] }).value;
    expect(rows).toHaveLength(2);
    expect(rows[0]['@search.action']).toBe('mergeOrUpload');
    expect(rows[0].content).toBe('Cats and dogs are pets');
    expect(rows[0].content_vector).toEqual(fakeVector('Cats and dogs are pets'));
    expect(rows[0].topic).toBe('animals');
    expect(JSON.parse(String(rows[0].metadata))).toMatchObject({ topic: 'animals' });
    expect(String(rows[0].id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps an existing index and only fills the fields it has', async () => {
    const http = azureHttp({ indexExists: true, fields: ['id', 'content', 'content_vector', 'metadata'] });
    const r = await insert(azure('insert', { options: { metadataKeys: 'topic' } }), svcOf(azCreds, http));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(http.requests.map((q) => q.method)).toEqual(['GET', 'POST']);
    const rows = (http.requests[1].body as { value: DataObject[] }).value;
    expect(rows[0]).not.toHaveProperty('topic');
  });

  it('clears the index before inserting', async () => {
    const http = azureHttp();
    await insert(azure('insert', { options: { clearStore: true } }), svcOf(azCreds, http));
    expect(http.requests[0].method).toBe('DELETE');
    expect(http.requests[0].url).toBe(`${AZ_BASE}/indexes/docs`);
    expect(http.requests.map((q) => q.method)).toEqual(['DELETE', 'GET', 'PUT', 'POST']);
  });

  it('updates a document by merge upload on the given id', async () => {
    const http = azureHttp({ indexExists: true });
    const r = await withEmbeddings(
      azure('update', { id: 'doc-7' }),
      [{ json: { text: 'new text' } }],
      svcOf(azCreds, http),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const write = http.requests.find((q) => q.url.endsWith('/docs/index'))!;
    const rows = (write.body as { value: DataObject[] }).value;
    expect(rows).toHaveLength(1);
    expect(rows[0]['@search.action']).toBe('mergeOrUpload');
    expect(rows[0].id).toBe('doc-7');
    expect(String(rows[0].content)).toContain('new text');
    expect(rows[0]).not.toHaveProperty('metadata');
  });

  it('hybrid search (the default) sends the prompt as search text with the vector', async () => {
    const http = azureHttp();
    const r = await load(azure('load', { topK: 3 }), 'dog', svcOf(azCreds, http));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const search = http.requests[0];
    expect(search.url).toBe(`${AZ_BASE}/indexes/docs/docs/search`);
    expect(search.method).toBe('POST');
    expect(header(search, 'api-key')).toBe('az-secret-key');
    const body = search.body as DataObject;
    expect(body.search).toBe('dog');
    expect(body.top).toBe(3);
    expect(body.queryType).toBeUndefined();
    expect(body.vectorQueries).toEqual([
      { kind: 'vector', vector: fakeVector('dog'), fields: 'content_vector', k: 3 },
    ]);
    const out = r.output('Store')[0] as { document: DataObject; score: number };
    expect(out.document.pageContent).toBe('Cats and dogs are pets');
    expect(out.document.metadata).toEqual({ topic: 'animals' });
    expect(out.score).toBe(0.8);
  });

  it('vector query type sends no search text', async () => {
    const http = azureHttp();
    await load(azure('load', { options: { queryType: 'vector' } }), 'dog', svcOf(azCreds, http));
    const body = http.requests[0].body as DataObject;
    expect(body).not.toHaveProperty('search');
    expect(body.vectorQueries).toHaveLength(1);
  });

  it('semantic hybrid passes the text, the configuration and the OData filter', async () => {
    const http = azureHttp();
    await load(
      azure('load', {
        options: {
          queryType: 'semanticHybrid',
          semanticConfiguration: 'my-config',
          odataFilter: "topic eq 'animals'",
        },
      }),
      'dog',
      svcOf(azCreds, http),
    );
    const body = http.requests[0].body as DataObject;
    expect(body.search).toBe('dog');
    expect(body.queryType).toBe('semantic');
    expect(body.semanticConfiguration).toBe('my-config');
    expect(body.filter).toBe("topic eq 'animals'");
  });

  it('refuses an index name that could change the path', async () => {
    const http = azureHttp();
    const r = await load(azure('load', { indexName: '../x' }), 'dog', svcOf(azCreds, http));
    expect(r.status).toBe('error');
    expect(http.requests).toHaveLength(0);
  });

  it('refuses an http endpoint before sending the key', async () => {
    const http = azureHttp();
    const r = await load(
      azure('load'),
      'dog',
      svcOf({ azureAiSearchApi: { endpoint: 'http://svc1.search.windows.net', apiKey: 'k' } }, http),
    );
    expect(r.status).toBe('error');
    expect(http.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Chroma
// ---------------------------------------------------------------------------------------------

const CH_BASE = 'http://chroma.test:8000';
const SCOPE = '/api/v2/tenants/default_tenant/databases/default_database/collections';

function chromaHttp(options: { exists?: boolean; space?: string } = {}) {
  return new FakeHttpClient((req): FakeReply => {
    const path = new URL(req.url).pathname;
    if (path === '/api/v2/auth/identity') {
      return { body: { user_id: 'u', tenant: 'tenant-1', databases: ['db-1'] } };
    }
    if (req.method === 'GET' && path.endsWith('/collections') && req.url.includes('limit=')) {
      return {
        body: [
          { id: 'c1', name: 'docs' },
          { id: 'c2', name: 'notes' },
        ],
      };
    }
    if (req.method === 'GET') {
      return options.exists === false
        ? { status: 404, body: { error: 'NotFoundError' } }
        : {
            body: {
              id: 'col-1',
              name: 'docs',
              configuration_json: { hnsw: { space: options.space ?? 'cosine' } },
            },
          };
    }
    if (req.method === 'POST' && path.endsWith('/collections')) {
      return { body: { id: 'col-new', name: 'docs', configuration_json: { hnsw: { space: 'cosine' } } } };
    }
    if (path.endsWith('/query')) {
      return {
        body: {
          ids: [['a1']],
          documents: [['Cats and dogs are pets']],
          metadatas: [[{ topic: 'animals' }]],
          distances: [[0.25]],
        },
      };
    }
    return { body: {} };
  });
}

const chroma = (mode: string, extra: DataObject = {}, credential = 'chromaSelfHostedApi') =>
  node(
    'Store',
    'ai.vectorStoreChromaDB',
    {
      mode,
      authentication: credential,
      chromaCollection: { __rl: true, mode: 'id', value: 'docs' },
      ...extra,
    },
    { credentials: { [credential]: { id: 'c', name: 'c' } } },
  );

const selfNone = { chromaSelfHostedApi: { baseUrl: CH_BASE, authentication: 'none' } };

describe('Chroma store', () => {
  it('inserts through the collection id found by name', async () => {
    const http = chromaHttp();
    const r = await insert(chroma('insert'), svcOf(selfNone, http));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const [lookup, upsert] = http.requests;
    expect(lookup.method).toBe('GET');
    expect(lookup.url).toBe(`${CH_BASE}${SCOPE}/docs`);
    expect(lookup.followRedirects).toBe(false);
    expect(header(lookup, 'authorization')).toBeUndefined();
    expect(header(lookup, 'x-chroma-token')).toBeUndefined();
    expect(upsert.method).toBe('POST');
    expect(upsert.url).toBe(`${CH_BASE}${SCOPE}/col-1/upsert`);
    const body = upsert.body as {
      ids: string[];
      embeddings: number[][];
      documents: string[];
      metadatas: DataObject[];
    };
    expect(body.ids).toHaveLength(2);
    expect(body.embeddings[0]).toEqual(fakeVector('Cats and dogs are pets'));
    expect(body.documents[1]).toBe('A car has an engine and drives on the road');
    expect(body.metadatas[0]).toMatchObject({ topic: 'animals' });
  });

  it('creates the collection on insert when it is missing', async () => {
    const http = chromaHttp({ exists: false });
    const r = await insert(chroma('insert'), svcOf(selfNone, http));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const create = http.requests[1];
    expect(create.method).toBe('POST');
    expect(create.url).toBe(`${CH_BASE}${SCOPE}`);
    expect(create.body).toMatchObject({ name: 'docs', get_or_create: true });
    expect(http.requests[2].url).toBe(`${CH_BASE}${SCOPE}/col-new/upsert`);
  });

  it('searches with n_results and a where filter, and turns the distance into a score', async () => {
    const http = chromaHttp();
    const r = await load(
      chroma('load', {
        topK: 2,
        options: { metadata: { metadataValues: [{ name: 'topic', value: 'animals' }] } },
      }),
      'dog',
      svcOf(selfNone, http),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const query = http.requests[1];
    expect(query.url).toBe(`${CH_BASE}${SCOPE}/col-1/query`);
    expect(query.body).toEqual({
      query_embeddings: [fakeVector('dog')],
      n_results: 2,
      include: ['documents', 'metadatas', 'distances'],
      where: { topic: { $eq: 'animals' } },
    });
    const out = r.output('Store')[0] as { document: DataObject; score: number };
    expect(out.document.pageContent).toBe('Cats and dogs are pets');
    expect(out.document.metadata).toEqual({ topic: 'animals' });
    expect(out.score).toBeCloseTo(0.75);
  });

  it('joins several filter keys with $and', async () => {
    const http = chromaHttp();
    await load(
      chroma('load', {
        options: {
          metadata: {
            metadataValues: [
              { name: 'topic', value: 'animals' },
              { name: 'lang', value: 'en' },
            ],
          },
        },
      }),
      'dog',
      svcOf(selfNone, http),
    );
    expect((http.requests[1].body as DataObject).where).toEqual({
      $and: [{ topic: { $eq: 'animals' } }, { lang: { $eq: 'en' } }],
    });
  });

  it('clears the collection by deleting and creating it again', async () => {
    const http = chromaHttp();
    await insert(chroma('insert', { options: { clearStore: true } }), svcOf(selfNone, http));
    const calls = http.requests.map((q) => `${q.method} ${new URL(q.url).pathname.replace(SCOPE, '')}`);
    expect(calls).toEqual(['DELETE /docs', 'GET /docs', 'POST /col-1/upsert']);
  });

  it('self-hosted API key is sent as a Bearer token', async () => {
    const http = chromaHttp();
    await load(
      chroma('load'),
      'dog',
      svcOf({ chromaSelfHostedApi: { baseUrl: CH_BASE, authentication: 'apiKey', apiKey: 'ch-key' } }, http),
    );
    expect(header(http.requests[0], 'authorization')).toBe('Bearer ch-key');
  });

  it('self-hosted token is sent in X-Chroma-Token', async () => {
    const http = chromaHttp();
    await load(
      chroma('load'),
      'dog',
      svcOf({ chromaSelfHostedApi: { baseUrl: CH_BASE, authentication: 'token', token: 'ch-token' } }, http),
    );
    expect(header(http.requests[0], 'x-chroma-token')).toBe('ch-token');
    expect(header(http.requests[0], 'authorization')).toBeUndefined();
  });

  it('Chroma Cloud finds the tenant and database from the key and sends X-Chroma-Token', async () => {
    const http = chromaHttp();
    const r = await load(
      chroma('load', {}, 'chromaCloudApi'),
      'dog',
      svcOf({ chromaCloudApi: { baseUrl: 'https://api.trychroma.com', apiKey: 'cloud-key' } }, http),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(http.requests[0].url).toBe('https://api.trychroma.com/api/v2/auth/identity');
    expect(header(http.requests[0], 'x-chroma-token')).toBe('cloud-key');
    expect(http.requests[1].url).toBe(
      'https://api.trychroma.com/api/v2/tenants/tenant-1/databases/db-1/collections/docs',
    );
    expect(header(http.requests[1], 'x-chroma-token')).toBe('cloud-key');
  });

  it('Chroma Cloud uses the tenant and database of the credential without asking', async () => {
    const http = chromaHttp();
    await load(
      chroma('load', {}, 'chromaCloudApi'),
      'dog',
      svcOf(
        {
          chromaCloudApi: {
            baseUrl: 'https://api.trychroma.com',
            apiKey: 'cloud-key',
            tenant: 't9',
            database: 'd9',
          },
        },
        http,
      ),
    );
    expect(http.requests[0].url).toBe(
      'https://api.trychroma.com/api/v2/tenants/t9/databases/d9/collections/docs',
    );
  });

  it('a missing collection is an error on search', async () => {
    const http = chromaHttp({ exists: false });
    const r = await load(chroma('load'), 'dog', svcOf(selfNone, http));
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.error)).toContain('not found');
  });

  it('lists the collections of the chosen authentication', async () => {
    const http = chromaHttp();
    const ctx = {
      getNode: () => ({ name: 'Store' }),
      getCurrentNodeParameter: () => 'chromaSelfHostedApi',
      getCredentials: async () => ({ baseUrl: CH_BASE }),
      helpers: {
        httpRequestWithAuthentication: (_type: string, options: HttpRequestOptions) => http.request(options),
      },
    } as never;
    const list = VectorStoreChromaDBNode.methods!.listSearch!.chromaCollectionSearch;
    expect(await list(ctx, 'do')).toEqual({ results: [{ name: 'docs', value: 'docs' }] });
    expect(http.requests[0].url).toContain(`${CH_BASE}${SCOPE}?limit=100&offset=0`);
  });

  it('exposes both nodes with their modes', () => {
    expect(VectorStoreAzureAISearchNode.description.name).toBe('ai.vectorStoreAzureAISearch');
    expect(VectorStoreChromaDBNode.description.properties.map((p) => p.name)).toContain('authentication');
  });
});
