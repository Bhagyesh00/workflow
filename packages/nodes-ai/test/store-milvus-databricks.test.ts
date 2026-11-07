/**
 * Milvus and Databricks Vector Store (P5-43): FakeHttpClient fixtures written from the Milvus REST v2 docs
 * and the Databricks Vector Search REST docs. A fixture proves the request we send, not the vendor's answer.
 */
import type { DataObject, HttpRequestOptions, Item, LoadOptionsContext, WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { VectorStoreDatabricksNode } from '../src/nodes/vector-stores/databricks';
import { VectorStoreMilvusNode } from '../src/nodes/vector-stores/milvus';
import {
  connect,
  FakeHttpClient,
  type FakeReply,
  fakeVector,
  node,
  run,
  services,
  toolNodeTypes,
  VOCABULARY,
} from './harness';

const DOCS: Item[] = [
  { json: { text: 'Cats and dogs are pets', topic: 'animals' } },
  { json: { text: 'A car has an engine', topic: 'vehicles' } },
];

function loader(): WorkflowNode {
  return node('Loader', 'ai.documentDefaultDataLoader', {
    jsonMode: 'expressionData',
    jsonData: '={{ $json.text }}',
    options: { metadata: { metadataValues: [{ name: 'topic', value: '={{ $json.topic }}' }] } },
  });
}

const noPartnerHeaders = (http: FakeHttpClient) => {
  for (const request of http.requests) {
    expect(JSON.stringify(request.headers ?? {})).not.toMatch(/openai-platform|n8n/i);
  }
};

// ---------------------------------------------------------------------------------------------
// Milvus
// ---------------------------------------------------------------------------------------------

const MILVUS = 'http://milvus.example.com:19530';
const MILVUS_CREDS = { milvusApi: { baseUrl: `${MILVUS}/`, username: 'root', password: 'pw-secret' } };

interface MilvusFixture {
  collections?: string[];
  search?: DataObject[];
  fail?: Record<string, FakeReply>;
}

function fakeMilvus(fixture: MilvusFixture = {}) {
  const collections = [...(fixture.collections ?? [])];
  return new FakeHttpClient((req: HttpRequestOptions) => {
    const path = new URL(req.url).pathname;
    const failed = fixture.fail?.[path];
    if (failed) return failed;
    const body = (req.body ?? {}) as DataObject;
    switch (path) {
      case '/v2/vectordb/collections/list':
        return { body: { code: 0, data: collections } };
      case '/v2/vectordb/collections/create':
        collections.push(String(body.collectionName));
        return { body: { code: 0, data: {} } };
      case '/v2/vectordb/collections/drop':
        collections.splice(collections.indexOf(String(body.collectionName)), 1);
        return { body: { code: 0, data: {} } };
      case '/v2/vectordb/entities/insert':
        return { body: { code: 0, data: { insertCount: (body.data as unknown[]).length, insertIds: [] } } };
      case '/v2/vectordb/entities/search':
        return { body: { code: 0, data: fixture.search ?? [] } };
      default:
        return { status: 404, body: { code: 404, message: `no route ${path}` } };
    }
  });
}

function milvusNode(mode: string, extra: DataObject = {}, collection = 'docs_p5'): WorkflowNode {
  return node(
    'Store',
    'ai.vectorStoreMilvus',
    { mode, milvusCollection: { __rl: true, mode: 'id', value: collection }, ...extra },
    { credentials: { milvusApi: { id: 'm', name: 'm' } } },
  );
}

async function milvusInsert(storeNode: WorkflowNode, http: FakeHttpClient, creds: DataObject = MILVUS_CREDS) {
  return run(
    [node('Trigger', 'test.trigger'), storeNode, loader(), node('Embeddings', 'test.fakeEmbeddings')],
    connect(
      ['Trigger', storeNode.name],
      ['Loader', storeNode.name, 'ai_document'],
      ['Embeddings', storeNode.name, 'ai_embedding'],
    ),
    { triggerItems: DOCS, services: services({ creds: creds as never, http }) },
  );
}

async function milvusLoad(storeNode: WorkflowNode, prompt: string, http: FakeHttpClient) {
  return run(
    [node('Trigger', 'test.trigger'), storeNode, node('Embeddings', 'test.fakeEmbeddings')],
    connect(['Trigger', storeNode.name], ['Embeddings', storeNode.name, 'ai_embedding']),
    { triggerItems: [{ json: { chatInput: prompt } }], services: services({ creds: MILVUS_CREDS as never, http }) },
  );
}

describe('Milvus', () => {
  it('describes the node: default modes, no filter, collection locator', () => {
    const d = VectorStoreMilvusNode.description;
    expect(d.credentials).toEqual([{ name: 'milvusApi', required: true }]);
    const modes = (d.properties.find((p) => p.name === 'mode')?.options as Array<{ value: string }>).map(
      (o) => o.value,
    );
    expect(modes).toEqual(['load', 'insert', 'retrieve', 'retrieve-as-tool']);
    expect(d.properties.some((p) => p.name === 'milvusCollection')).toBe(true);
    expect(VectorStoreMilvusNode.methods?.listSearch?.milvusCollectionSearch).toBeTypeOf('function');
  });

  it('creates the collection from the first insert and inserts rows with their vectors', async () => {
    const http = fakeMilvus();
    const r = await milvusInsert(milvusNode('insert'), http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const paths = http.requests.map((q) => new URL(q.url).pathname);
    expect(paths).toEqual([
      '/v2/vectordb/collections/list',
      '/v2/vectordb/collections/create',
      '/v2/vectordb/entities/insert',
    ]);
    const [list, create, insert] = http.requests;
    expect(list.method).toBe('POST');
    expect(list.url).toBe(`${MILVUS}/v2/vectordb/collections/list`);
    expect(list.headers?.authorization).toBe('Bearer root:pw-secret');
    expect(create.body).toMatchObject({
      collectionName: 'docs_p5',
      dimension: VOCABULARY.length,
      metricType: 'COSINE',
      vectorFieldName: 'vector',
      enableDynamicField: true,
    });
    expect(insert.body).toEqual({
      collectionName: 'docs_p5',
      data: [
        { vector: fakeVector('Cats and dogs are pets'), text: 'Cats and dogs are pets', metadata: { source: 'json', topic: 'animals' } },
        { vector: fakeVector('A car has an engine'), text: 'A car has an engine', metadata: { source: 'json', topic: 'vehicles' } },
      ],
    });
    for (const request of http.requests) {
      expect(request.url).not.toContain('pw-secret');
      expect(JSON.stringify(request.body ?? {})).not.toContain('pw-secret');
      expect(request.followRedirects).toBe(false);
    }
    noPartnerHeaders(http);
  });

  it('inserts into an existing collection without creating it, and Clear Collection drops it first', async () => {
    const existing = fakeMilvus({ collections: ['docs_p5'] });
    const ok = await milvusInsert(milvusNode('insert'), existing);
    expect(ok.status, JSON.stringify(ok.error)).toBe('success');
    expect(existing.requests.map((q) => new URL(q.url).pathname)).toEqual([
      '/v2/vectordb/collections/list',
      '/v2/vectordb/entities/insert',
    ]);

    const cleared = fakeMilvus({ collections: ['docs_p5'] });
    const r = await milvusInsert(milvusNode('insert', { options: { clearStore: true } }), cleared);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(cleared.requests.map((q) => new URL(q.url).pathname)).toEqual([
      '/v2/vectordb/collections/list',
      '/v2/vectordb/collections/drop',
      '/v2/vectordb/collections/create',
      '/v2/vectordb/entities/insert',
    ]);
    expect(cleared.requests[1].body).toEqual({ collectionName: 'docs_p5' });
  });

  it('searches by vector and returns text, metadata and the score', async () => {
    const http = fakeMilvus({
      collections: ['docs_p5'],
      search: [
        { id: 1, distance: 0.91, text: 'Cats and dogs are pets', metadata: { topic: 'animals' } },
        { id: 2, distance: 0.12, text: 'A car has an engine' },
      ],
    });
    const r = await milvusLoad(milvusNode('load', { topK: 2 }), 'which pets', http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const search = http.requests.find((q) => q.url.endsWith('/v2/vectordb/entities/search'))!;
    expect(search.body).toEqual({
      collectionName: 'docs_p5',
      data: [fakeVector('which pets')],
      annsField: 'vector',
      limit: 2,
      outputFields: ['text', 'metadata'],
    });
    expect(r.output('Store')).toEqual([
      { document: { pageContent: 'Cats and dogs are pets', metadata: { topic: 'animals' } }, score: 0.91 },
      { document: { pageContent: 'A car has an engine', metadata: {} }, score: 0.12 },
    ]);
    noPartnerHeaders(http);
  });

  it('sends no authorization header without a user and a password', async () => {
    const http = fakeMilvus({ collections: ['docs_p5'] });
    const creds = { milvusApi: { baseUrl: MILVUS } };
    const r = await milvusInsert(milvusNode('insert'), http, creds);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(http.requests.every((q) => !('authorization' in (q.headers ?? {})))).toBe(true);
  });

  it('refuses a missing collection on search, a bad name before any request, and redacts an error', async () => {
    const missing = fakeMilvus();
    const r1 = await milvusLoad(milvusNode('load'), 'cat', missing);
    expect(r1.status).toBe('error');
    expect(r1.error?.message).toMatch(/Collection docs_p5 not found/);

    const bad = fakeMilvus();
    const r2 = await milvusLoad(milvusNode('load', {}, 'a/../b'), 'cat', bad);
    expect(r2.status).toBe('error');
    expect(r2.error?.message).toMatch(/not valid for Milvus/);
    expect(bad.requests).toHaveLength(0);

    const failing = fakeMilvus({
      fail: {
        '/v2/vectordb/collections/list': {
          body: { code: 1800, message: 'user hasn\'t authenticated with token sk-abcdefghijklmnopqrstuvwxyz123456' },
        },
      },
    });
    const r3 = await milvusLoad(milvusNode('load'), 'cat', failing);
    expect(r3.status).toBe('error');
    expect(r3.error?.message).toMatch(/code 1800/);
    expect(JSON.stringify(r3.error)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });
});

// ---------------------------------------------------------------------------------------------
// Databricks
// ---------------------------------------------------------------------------------------------

const HOST = 'https://dbx.example.com';
const TOKEN = 'dapi-token-0123456789abcdef';
const DBX_CREDS = {
  databricksOAuth2Api: { host: HOST, grantType: 'clientCredentials', clientId: 'sp-1', clientSecret: 'shh-secret' },
};
const INDEX = 'main.docs.kb_index';
const INFO_PATH = `/api/2.0/vector-search/indexes/${encodeURIComponent(INDEX)}`;

type IndexKind = 'direct' | 'selfManaged' | 'managed';

function indexInfo(kind: IndexKind): DataObject {
  if (kind === 'direct') {
    return {
      name: INDEX,
      index_type: 'DIRECT_ACCESS',
      primary_key: 'id',
      direct_access_index_spec: {
        embedding_vector_columns: [{ name: 'embedding', embedding_dimension: VOCABULARY.length }],
        schema_json: '{}',
      },
    };
  }
  if (kind === 'selfManaged') {
    return {
      name: INDEX,
      index_type: 'DELTA_SYNC',
      primary_key: 'id',
      delta_sync_index_spec: {
        source_table: 'main.docs.kb',
        embedding_vector_columns: [{ name: 'embedding', embedding_dimension: VOCABULARY.length }],
      },
    };
  }
  return {
    name: INDEX,
    index_type: 'DELTA_SYNC',
    primary_key: 'id',
    delta_sync_index_spec: {
      source_table: 'main.docs.kb',
      embedding_source_columns: [{ name: 'text', embedding_model_endpoint_name: 'gte-large' }],
    },
  };
}

function fakeDatabricks(kind: IndexKind, query?: (body: DataObject) => FakeReply) {
  return new FakeHttpClient((req: HttpRequestOptions) => {
    const path = new URL(req.url).pathname;
    if (path === '/oidc/v1/token') return { body: { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 } };
    if (path === INFO_PATH) return { body: indexInfo(kind) };
    if (path === `${INFO_PATH}/upsert-data`) {
      return { body: { status: 'SUCCESS', result: { success_row_count: 2, failed_primary_keys: [] } } };
    }
    if (path === `${INFO_PATH}/query`) {
      return (
        query?.(req.body as DataObject) ?? {
          body: {
            manifest: { column_count: 3, columns: [{ name: 'text' }, { name: 'topic' }, { name: 'score' }] },
            result: {
              row_count: 2,
              data_array: [
                ['Cats and dogs are pets', 'animals', 0.83],
                ['A car has an engine', null, 0.2],
              ],
            },
          },
        }
      );
    }
    if (path === '/api/2.0/vector-search/endpoints') return { body: { endpoints: [{ name: 'ep1' }, { name: '../evil' }] } };
    if (path === '/api/2.0/vector-search/indexes') {
      return { body: { vector_indexes: [{ name: INDEX }, { name: 'bad name' }, { name: 'main.docs.alpha' }] } };
    }
    return { status: 404, body: { message: `no route ${req.method ?? 'GET'} ${path}` } };
  });
}

function dbxNode(mode: string, extra: DataObject = {}): WorkflowNode {
  return node(
    'Store',
    'ai.vectorStoreDatabricks',
    {
      mode,
      databricksIndex: { __rl: true, mode: 'id', value: INDEX },
      contentColumn: 'text',
      metadataColumns: 'topic',
      ...extra,
    },
    { credentials: { databricksOAuth2Api: { id: 'd', name: 'd' } } },
  );
}

const dbxServices = (http: FakeHttpClient, creds: DataObject = DBX_CREDS) =>
  services({ nodeTypes: toolNodeTypes, creds: creds as never, http });

async function dbxInsert(storeNode: WorkflowNode, http: FakeHttpClient) {
  return run(
    [node('Trigger', 'test.trigger'), storeNode, loader(), node('Embeddings', 'test.fakeEmbeddings')],
    connect(
      ['Trigger', storeNode.name],
      ['Loader', storeNode.name, 'ai_document'],
      ['Embeddings', storeNode.name, 'ai_embedding'],
    ),
    { nodeTypes: toolNodeTypes, triggerItems: DOCS, services: dbxServices(http) },
  );
}

async function dbxLoad(storeNode: WorkflowNode, prompt: string, http: FakeHttpClient, creds?: DataObject) {
  return run(
    [node('Trigger', 'test.trigger'), storeNode, node('Embeddings', 'test.fakeEmbeddings')],
    connect(['Trigger', storeNode.name], ['Embeddings', storeNode.name, 'ai_embedding']),
    {
      nodeTypes: toolNodeTypes,
      triggerItems: [{ json: { chatInput: prompt } }],
      services: dbxServices(http, creds),
    },
  );
}

const apiCalls = (http: FakeHttpClient) => http.requests.filter((q) => new URL(q.url).pathname !== '/oidc/v1/token');

describe('Databricks', () => {
  it('describes the node: databricksOAuth2Api only, JSON filter, index locator', () => {
    const d = VectorStoreDatabricksNode.description;
    expect(d.credentials).toEqual([{ name: 'databricksOAuth2Api', required: true }]);
    expect(JSON.stringify(d)).not.toContain('databricksApi"');
    expect(d.properties.some((p) => p.name === 'databricksIndex')).toBe(true);
    expect(VectorStoreDatabricksNode.methods?.listSearch?.databricksIndexSearch).toBeTypeOf('function');
  });

  it('inserts rows into a Direct Access index through upsert-data, with the bearer token', async () => {
    const http = fakeDatabricks('direct');
    const r = await dbxInsert(dbxNode('insert'), http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const [info, upsert] = apiCalls(http);
    expect(info.url).toBe(`${HOST}${INFO_PATH}`);
    expect(info.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(upsert).toMatchObject({ url: `${HOST}${INFO_PATH}/upsert-data`, method: 'POST', followRedirects: false });
    expect(upsert.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    const rows = JSON.parse((upsert.body as { inputs_json: string }).inputs_json) as DataObject[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      text: 'Cats and dogs are pets',
      topic: 'animals',
      embedding: fakeVector('Cats and dogs are pets'),
    });
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    // only the listed metadata columns are written
    expect(rows[0]).not.toHaveProperty('source');
    for (const request of http.requests) {
      expect(request.url).not.toContain(TOKEN);
      expect(request.url).not.toContain('shh-secret');
    }
    noPartnerHeaders(http);
  });

  it('refuses insert into a Delta Sync index', async () => {
    const http = fakeDatabricks('selfManaged');
    const r = await dbxInsert(dbxNode('insert'), http);
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/Direct Access index/);
    expect(apiCalls(http).some((q) => q.url.endsWith('/upsert-data'))).toBe(false);
  });

  it('searches a self-managed index by query_vector, with columns and the JSON filter', async () => {
    const http = fakeDatabricks('selfManaged');
    const r = await dbxLoad(
      dbxNode('load', { topK: 2, options: { searchFilterJson: '{"topic":"animals"}' } }),
      'which pets',
      http,
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const query = apiCalls(http).find((q) => q.url.endsWith('/query'))!;
    expect(query.method).toBe('POST');
    expect(query.body).toEqual({
      columns: ['text', 'topic'],
      query_vector: fakeVector('which pets'),
      query_type: 'ANN',
      num_results: 2,
      filters_json: '{"topic":"animals"}',
    });
    expect(r.output('Store')).toEqual([
      { document: { pageContent: 'Cats and dogs are pets', metadata: { topic: 'animals' } }, score: 0.83 },
      { document: { pageContent: 'A car has an engine', metadata: {} }, score: 0.2 },
    ]);
    noPartnerHeaders(http);
  });

  it('sends query_text, not a vector, to an index with managed embeddings', async () => {
    const http = fakeDatabricks('managed');
    const r = await dbxLoad(dbxNode('load'), 'which pets', http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const query = apiCalls(http).find((q) => q.url.endsWith('/query'))!;
    expect(query.body).toMatchObject({ query_text: 'which pets', query_type: 'ANN', num_results: 4 });
    expect(query.body).not.toHaveProperty('query_vector');
    expect(query.body).not.toHaveProperty('filters_json');
  });

  it('hybrid search sends the text with the vector, and the text alone to a managed index', async () => {
    const self = fakeDatabricks('selfManaged');
    const r1 = await dbxLoad(dbxNode('load', { options: { searchMode: 'hybrid' } }), 'which pets', self);
    expect(r1.status, JSON.stringify(r1.error)).toBe('success');
    expect(apiCalls(self).find((q) => q.url.endsWith('/query'))!.body).toMatchObject({
      query_type: 'HYBRID',
      query_text: 'which pets',
      query_vector: fakeVector('which pets'),
    });

    const managed = fakeDatabricks('managed');
    const r2 = await dbxLoad(dbxNode('load', { options: { searchMode: 'hybrid' } }), 'which pets', managed);
    expect(r2.status, JSON.stringify(r2.error)).toBe('success');
    const body = apiCalls(managed).find((q) => q.url.endsWith('/query'))!.body as DataObject;
    expect(body).toMatchObject({ query_type: 'HYBRID', query_text: 'which pets' });
    expect(body).not.toHaveProperty('query_vector');
  });

  it('refuses an http host before any request, and a bad index or column name', async () => {
    const http = fakeDatabricks('selfManaged');
    const r = await dbxLoad(dbxNode('load'), 'cat', http, {
      databricksOAuth2Api: { ...DBX_CREDS.databricksOAuth2Api, host: 'http://dbx.example.com' },
    });
    expect(r.status).toBe('error');
    expect(http.requests).toHaveLength(0);

    const badIndex = fakeDatabricks('selfManaged');
    const r2 = await dbxLoad(
      dbxNode('load', { databricksIndex: { __rl: true, mode: 'id', value: '../x?y=1' } }),
      'cat',
      badIndex,
    );
    expect(r2.status).toBe('error');
    expect(r2.error?.message).toMatch(/catalog\.schema\.index/);
    expect(apiCalls(badIndex)).toHaveLength(0);

    const badColumn = fakeDatabricks('selfManaged');
    const r3 = await dbxLoad(dbxNode('load', { metadataColumns: 'topic, a;b' }), 'cat', badColumn);
    expect(r3.status).toBe('error');
    expect(r3.error?.message).toMatch(/letters, digits and underscores/);
    expect(apiCalls(badColumn)).toHaveLength(0);
  });

  it('redacts a workspace error', async () => {
    const http = fakeDatabricks('selfManaged', () => ({
      status: 400,
      body: { message: 'bad token sk-abcdefghijklmnopqrstuvwxyz123456' },
    }));
    const r = await dbxLoad(dbxNode('load'), 'cat', http);
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/status 400/);
    expect(JSON.stringify(r.error)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('lists the indexes of every endpoint, skipping names that are not catalog.schema.index', async () => {
    const http = fakeDatabricks('direct');
    const ctx = {
      getNode: () => ({ name: 'Store' }),
      getCredentials: async () => DBX_CREDS.databricksOAuth2Api,
      helpers: { httpRequestWithAuthentication: (_type: string, options: HttpRequestOptions) => http.request(options) },
    } as unknown as LoadOptionsContext;
    const search = VectorStoreDatabricksNode.methods!.listSearch!.databricksIndexSearch;
    expect((await search(ctx, 'alpha')).results).toEqual([{ name: 'main.docs.alpha', value: 'main.docs.alpha' }]);
    const all = await search(ctx);
    expect(all.results.map((x) => x.value)).toEqual(['main.docs.alpha', INDEX]);
    // the endpoint with a path-like name is never queried
    expect(http.requests.filter((q) => q.url.endsWith('/indexes')).every((q) => q.qs?.endpoint_name === 'ep1')).toBe(true);
  });
});
