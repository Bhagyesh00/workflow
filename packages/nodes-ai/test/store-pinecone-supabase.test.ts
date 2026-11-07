import type { DataObject, HttpRequestOptions, Item, WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { VectorStorePineconeNode } from '../src/nodes/vector-stores/pinecone';
import { VectorStoreSupabaseNode } from '../src/nodes/vector-stores/supabase';
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
  { json: { text: 'Pizza and pasta are food', topic: 'food' } },
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

async function insertWith(store: WorkflowNode, loaderNode: WorkflowNode, svc: Svc, items = DOCS) {
  return run(
    [node('Trigger', 'test.trigger'), store, loaderNode, node('Embeddings', 'test.fakeEmbeddings')],
    connect(
      ['Trigger', store.name],
      ['Loader', store.name, 'ai_document'],
      ['Embeddings', store.name, 'ai_embedding'],
    ),
    { triggerItems: items, services: svc, nodeTypes: toolNodeTypes },
  );
}

const insert = (store: WorkflowNode, svc: Svc, items = DOCS) => insertWith(store, loader(), svc, items);

async function withEmbeddings(store: WorkflowNode, items: Item[], svc: Svc) {
  return run(
    [node('Trigger', 'test.trigger'), store, node('Embeddings', 'test.fakeEmbeddings')],
    connect(['Trigger', store.name], ['Embeddings', store.name, 'ai_embedding']),
    { triggerItems: items, services: svc, nodeTypes: toolNodeTypes },
  );
}

const load = (store: WorkflowNode, prompt: string, svc: Svc) =>
  withEmbeddings(store, [{ json: { chatInput: prompt } }], svc);

/** What a list search method needs from its context. */
function listContext(creds: DataObject, http: FakeHttpClient) {
  return {
    getCredentials: async () => creds,
    helpers: {
      httpRequestWithAuthentication: (_type: string, options: HttpRequestOptions) => http.request(options),
    },
  } as never;
}

// ---------------------------------------------------------------------------------------------
// Pinecone
// ---------------------------------------------------------------------------------------------

const PC_HOST = 'docs-abc123.svc.aped-4627-b74a.pinecone.io';
const pcCreds = { pineconeApi: { apiKey: 'pc-secret-key' } };

function pineconeHttp(
  options: {
    host?: string;
    indexes?: string[];
    data?: (req: HttpRequestOptions) => FakeReply | undefined;
  } = {},
) {
  return new FakeHttpClient((req) => {
    if (req.url === 'https://api.pinecone.io/indexes') {
      return {
        body: {
          indexes: (options.indexes ?? ['docs']).map((name) => ({
            name,
            dimension: 8,
            host: options.host ?? PC_HOST,
          })),
        },
      };
    }
    const custom = options.data?.(req);
    if (custom) return custom;
    if (req.url.endsWith('/vectors/upsert')) {
      return { body: { upsertedCount: (req.body as { vectors: unknown[] }).vectors.length } };
    }
    if (req.url.endsWith('/query')) {
      return {
        body: {
          matches: [
            {
              id: 'a1',
              score: 0.91,
              metadata: { text: 'Cats and dogs are pets', topic: 'animals', 'a.b': 1 },
            },
          ],
        },
      };
    }
    return { body: {} };
  });
}

const pinecone = (mode: string, extra: DataObject = {}) =>
  node(
    'Store',
    'ai.vectorStorePinecone',
    { mode, pineconeIndex: { __rl: true, mode: 'id', value: 'docs' }, ...extra },
    { credentials: { pineconeApi: { id: 'p', name: 'p' } } },
  );

describe('Pinecone store', () => {
  it('inserts through the index host with the version header', async () => {
    const http = pineconeHttp();
    const r = await insert(
      pinecone('insert', { options: { pineconeNamespace: 'ns1' } }),
      svcOf(pcCreds, http),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const [list, upsert] = http.requests;
    expect(list.url).toBe('https://api.pinecone.io/indexes');
    expect(header(list, 'api-key')).toBe('pc-secret-key');
    expect(header(list, 'X-Pinecone-Api-Version')).toBe('2025-10');
    expect(upsert.url).toBe(`https://${PC_HOST}/vectors/upsert`);
    expect(upsert.method).toBe('POST');
    expect(upsert.followRedirects).toBe(false);
    expect(header(upsert, 'X-Pinecone-Api-Version')).toBe('2025-10');
    expect(header(upsert, 'api-key')).toBe('pc-secret-key');
    const body = upsert.body as {
      namespace: string;
      vectors: Array<{ id: string; values: number[]; metadata: DataObject }>;
    };
    expect(body.namespace).toBe('ns1');
    expect(body.vectors).toHaveLength(3);
    expect(body.vectors[0].values).toEqual(fakeVector('Cats and dogs are pets'));
    expect(body.vectors[0].metadata).toMatchObject({ text: 'Cats and dogs are pets', topic: 'animals' });
    expect(body.vectors[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('upserts in batches of 100', async () => {
    const http = pineconeHttp();
    const items = Array.from({ length: 250 }, (_, i) => ({ json: { text: `doc ${i}`, topic: 't' } }));
    const r = await insert(pinecone('insert'), svcOf(pcCreds, http), items);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const sizes = http.requests
      .filter((q) => q.url.endsWith('/vectors/upsert'))
      .map((q) => (q.body as { vectors: unknown[] }).vectors.length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it('flattens metadata to strings, numbers, booleans and string lists', async () => {
    const http = pineconeHttp();
    const flatLoader = node('Loader', 'ai.documentDefaultDataLoader', {
      jsonMode: 'expressionData',
      jsonData: '={{ $json.text }}',
      options: {
        metadata: {
          metadataValues: [
            { name: 'nested', value: '={{ { a: { b: 1, c: ["x", "y"] }, d: [1, 2], e: null, f: true } }}' },
          ],
        },
      },
    });
    const r = await insertWith(pinecone('insert'), flatLoader, svcOf(pcCreds, http), [
      { json: { text: 'x', topic: 'animals' } },
    ]);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const upsert = http.requests.find((q) => q.url.endsWith('/vectors/upsert'))!;
    const metadata = (upsert.body as { vectors: Array<{ metadata: DataObject }> }).vectors[0].metadata;
    for (const value of Object.values(metadata)) {
      const ok =
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (Array.isArray(value) && value.every((v) => typeof v === 'string'));
      expect(ok, JSON.stringify(value)).toBe(true);
    }
    expect(metadata['nested.a.b']).toBe(1);
    expect(metadata['nested.a.c']).toEqual(['x', 'y']);
    expect(metadata['nested.d']).toBe('[1,2]');
    expect(metadata['nested.f']).toBe(true);
    expect('nested.e' in metadata).toBe(false);
    expect(metadata.text).toBe('x');
  });

  it('searches with namespace, filter and topK', async () => {
    const http = pineconeHttp();
    const r = await load(
      pinecone('load', {
        topK: 3,
        options: {
          pineconeNamespace: 'ns1',
          metadata: { metadataValues: [{ name: 'topic', value: 'animals' }] },
        },
      }),
      'dog',
      svcOf(pcCreds, http),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Store')).toEqual([
      {
        document: { pageContent: 'Cats and dogs are pets', metadata: { topic: 'animals', 'a.b': 1 } },
        score: 0.91,
      },
    ]);
    const query = http.requests.at(-1)!;
    expect(query.url).toBe(`https://${PC_HOST}/query`);
    expect(query.followRedirects).toBe(false);
    expect(query.body).toMatchObject({
      topK: 3,
      namespace: 'ns1',
      includeMetadata: true,
      filter: { topic: { $eq: 'animals' } },
    });
    expect((query.body as { vector: number[] }).vector).toEqual(fakeVector('dog'));
  });

  it('updates the vector with the given id', async () => {
    const http = pineconeHttp();
    const r = await withEmbeddings(
      pinecone('update', { id: 'doc-7' }),
      [{ json: { text: 'new text' } }],
      svcOf(pcCreds, http),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const upsert = http.requests.find((q) => q.url.endsWith('/vectors/upsert'))!;
    const vectors = (upsert.body as { vectors: Array<{ id: string; metadata: DataObject }> }).vectors;
    expect(vectors).toHaveLength(1);
    expect(vectors[0].id).toBe('doc-7');
    expect(String(vectors[0].metadata.text)).toContain('new text');
  });

  it('reads the namespace per item in Get Many and opens the index once while settings match', async () => {
    const http = pineconeHttp();
    const items = [{ json: { chatInput: 'dog', ns: 'n1' } }, { json: { chatInput: 'cat', ns: 'n2' } }];
    const same = await withEmbeddings(
      pinecone('load', { options: { pineconeNamespace: '={{ $json.ns }}' } }),
      items,
      svcOf(pcCreds, http),
    );
    expect(same.status, JSON.stringify(same.error)).toBe('success');
    const queries = http.requests.filter((q) => q.url.endsWith('/query'));
    expect(queries.map((q) => (q.body as DataObject).namespace)).toEqual(['n1', 'n2']);
    const sameIndex = pineconeHttp();
    await withEmbeddings(
      pinecone('load', { options: { pineconeNamespace: 'fixed' } }),
      items,
      svcOf(pcCreds, sameIndex),
    );
    expect(sameIndex.requests.filter((q) => q.url === 'https://api.pinecone.io/indexes')).toHaveLength(1);
  });

  it('reads the index per item in Update', async () => {
    const http = pineconeHttp({ indexes: ['docs', 'other'] });
    const items = [{ json: { text: 'first', idx: 'docs' } }, { json: { text: 'second', idx: 'other' } }];
    const r = await withEmbeddings(
      pinecone('update', { id: 'doc-1', pineconeIndex: '={{ $json.idx }}' }),
      items,
      svcOf(pcCreds, http),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(http.requests.filter((q) => q.url.endsWith('/vectors/upsert'))).toHaveLength(2);
    expect(http.requests.filter((q) => q.url === 'https://api.pinecone.io/indexes')).toHaveLength(2);
  });

  it('clears the namespace on insert only when a namespace is set', async () => {
    const withNs = pineconeHttp();
    await insert(
      pinecone('insert', { options: { clearStore: true, pineconeNamespace: 'ns1' } }),
      svcOf(pcCreds, withNs),
    );
    const del = withNs.requests.find((q) => q.url.endsWith('/vectors/delete'))!;
    expect(del.body).toEqual({ deleteAll: true, namespace: 'ns1' });
    expect(del.followRedirects).toBe(false);
    expect(withNs.requests.indexOf(del)).toBeLessThan(
      withNs.requests.findIndex((q) => q.url.endsWith('/vectors/upsert')),
    );

    const noNs = pineconeHttp();
    await insert(pinecone('insert', { options: { clearStore: true } }), svcOf(pcCreds, noNs));
    expect(noNs.requests.some((q) => q.url.endsWith('/vectors/delete'))).toBe(false);
  });

  it('reports a missing index', async () => {
    const http = pineconeHttp({ indexes: ['other'] });
    const r = await insert(pinecone('insert'), svcOf(pcCreds, http));
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Index docs not found');
    expect(http.requests).toHaveLength(1);
  });

  it.each([
    ['a foreign host', 'evil.example.com'],
    ['a look-alike host', 'docs.pinecone.io.evil.com'],
    ['a suffix look-alike', 'notpinecone.io'],
    ['a scheme other than https', 'http://docs-abc.svc.x.pinecone.io'],
    ['credentials in the host', 'https://user:pw@docs-abc.svc.x.pinecone.io'],
    ['a path in the host', 'https://docs-abc.svc.x.pinecone.io/evil'],
  ])('refuses %s with no data-plane request', async (_name, host) => {
    const http = pineconeHttp({ host });
    const r = await insert(pinecone('insert'), svcOf(pcCreds, http));
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/host/i);
    expect(http.requests.every((q) => q.url === 'https://api.pinecone.io/indexes')).toBe(true);
    expect(JSON.stringify(r.error)).not.toContain('pc-secret-key');
  });

  it('treats a redirect on the data plane as an error and follows nothing', async () => {
    const http = pineconeHttp({
      data: (req) =>
        req.url.endsWith('/vectors/upsert') || req.url.endsWith('/query')
          ? { status: 307, headers: { location: 'https://evil.example.com/steal' }, body: '' }
          : undefined,
    });
    const inserted = await insert(pinecone('insert'), svcOf(pcCreds, http));
    expect(inserted.status).toBe('error');
    expect(inserted.error?.message).toMatch(/redirect/i);
    const loaded = await load(pinecone('load'), 'dog', svcOf(pcCreds, http));
    expect(loaded.status).toBe('error');
    expect(loaded.error?.message).toMatch(/redirect/i);
    expect(http.requests.every((q) => !q.url.includes('evil.example.com'))).toBe(true);
    const dataPlane = http.requests.filter((q) => q.url.includes(PC_HOST));
    expect(dataPlane.length).toBeGreaterThan(0);
    expect(dataPlane.every((q) => q.followRedirects === false)).toBe(true);
  });

  it('lists the indexes for the index picker', async () => {
    const http = pineconeHttp({ indexes: ['docs', 'Notes', 'zeta'] });
    const search = VectorStorePineconeNode.methods?.listSearch?.pineconeIndexSearch;
    expect(search).toBeTypeOf('function');
    const found = await search!(listContext(pcCreds.pineconeApi, http), 'no');
    expect(found.results.map((x) => x.value)).toEqual(['Notes']);
  });
});

// ---------------------------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------------------------

const sbCreds = { supabaseApi: { host: 'https://proj.supabase.co/', serviceRole: 'sb-secret-role' } };

function supabaseHttp(handler?: (req: HttpRequestOptions) => FakeReply | undefined) {
  return new FakeHttpClient((req) => {
    const custom = handler?.(req);
    if (custom) return custom;
    if (req.url.includes('/rest/v1/rpc/')) {
      return {
        body: [
          { id: 4, content: 'Cats and dogs are pets', metadata: { topic: 'animals' }, similarity: 0.88 },
        ],
      };
    }
    return { status: 201, body: '' };
  });
}

const supabaseNode = (params: DataObject) =>
  node('Store', 'ai.vectorStoreSupabase', params, { credentials: { supabaseApi: { id: 's', name: 's' } } });

const supabase = (mode: string, extra: DataObject = {}) =>
  supabaseNode({ mode, tableName: { __rl: true, mode: 'id', value: 'documents' }, ...extra });

describe('Supabase store', () => {
  it('inserts rows with the vector as a "[..]" string', async () => {
    const http = supabaseHttp();
    const r = await insert(supabase('insert'), svcOf(sbCreds, http));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const req = http.requests[0];
    expect(req.url).toBe('https://proj.supabase.co/rest/v1/documents');
    expect(req.method).toBe('POST');
    expect(header(req, 'apikey')).toBe('sb-secret-role');
    const rows = req.body as Array<{ content: string; embedding: string; metadata: DataObject }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].content).toBe('Cats and dogs are pets');
    expect(rows[0].embedding).toBe(JSON.stringify(fakeVector('Cats and dogs are pets')));
    expect(rows[0].metadata).toMatchObject({ topic: 'animals' });
  });

  it('updates by upserting on id', async () => {
    const http = supabaseHttp();
    const r = await withEmbeddings(
      supabase('update', { id: '42' }),
      [{ json: { text: 'changed' } }],
      svcOf(sbCreds, http),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const req = http.requests[0];
    expect(req.url).toBe('https://proj.supabase.co/rest/v1/documents');
    expect(req.qs).toEqual({ on_conflict: 'id' });
    expect(header(req, 'Prefer')).toBe('resolution=merge-duplicates,return=minimal');
    const rows = req.body as Array<{ id: string; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('42');
    expect(rows[0].content).toContain('changed');
  });

  it('searches through the query function with the filter', async () => {
    const http = supabaseHttp();
    const r = await load(
      supabase('load', {
        topK: 2,
        options: {
          queryName: 'match_chunks',
          metadata: { metadataValues: [{ name: 'topic', value: 'animals' }] },
        },
      }),
      'dog',
      svcOf(sbCreds, http),
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Store')).toEqual([
      { document: { pageContent: 'Cats and dogs are pets', metadata: { topic: 'animals' } }, score: 0.88 },
    ]);
    const req = http.requests[0];
    expect(req.url).toBe('https://proj.supabase.co/rest/v1/rpc/match_chunks');
    expect(req.method).toBe('POST');
    expect(req.body).toMatchObject({ match_count: 2, filter: { topic: 'animals' } });
    expect((req.body as { query_embedding: unknown }).query_embedding).toEqual(fakeVector('dog'));
  });

  it('uses match_documents by default and an empty filter', async () => {
    const http = supabaseHttp();
    await load(supabase('load'), 'dog', svcOf(sbCreds, http));
    expect(http.requests[0].url).toBe('https://proj.supabase.co/rest/v1/rpc/match_documents');
    expect((http.requests[0].body as { filter: unknown }).filter).toEqual({});
  });

  it.each(['a b', 'docs;drop', '../x', '1abc', 'a/b', 'x?y=1', '', 'a'.repeat(64), 'ü'])(
    'refuses the table name %j with no request',
    async (name) => {
      const http = supabaseHttp();
      const store = (mode: string) => supabaseNode({ mode, tableName: name });
      const inserted = await insert(store('insert'), svcOf(sbCreds, http));
      expect(inserted.status).toBe('error');
      const loaded = await load(store('load'), 'dog', svcOf(sbCreds, http));
      expect(loaded.status).toBe('error');
      expect(http.requests).toHaveLength(0);
    },
  );

  it.each(['match documents', 'x/../y', '9fn', 'fn;select', 'a'.repeat(64)])(
    'refuses the query name %j with no request',
    async (queryName) => {
      const http = supabaseHttp();
      const r = await load(supabase('load', { options: { queryName } }), 'dog', svcOf(sbCreds, http));
      expect(r.status).toBe('error');
      expect(r.error?.message).toMatch(/query name/i);
      expect(http.requests).toHaveLength(0);
    },
  );

  it('accepts a table name of 63 characters', async () => {
    const http = supabaseHttp();
    const name = `t${'a'.repeat(62)}`;
    const r = await insert(supabaseNode({ mode: 'insert', tableName: name }), svcOf(sbCreds, http));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(http.requests[0].url).toBe(`https://proj.supabase.co/rest/v1/${name}`);
  });

  it('reports a table that does not exist', async () => {
    const http = supabaseHttp((req) =>
      req.method === 'POST' && req.url.endsWith('/rest/v1/documents')
        ? { status: 404, body: { code: 'PGRST205', message: "Could not find the table 'public.documents'" } }
        : undefined,
    );
    const r = await insert(supabase('insert'), svcOf(sbCreds, http));
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Table documents not found');
  });

  it('refuses a host that is not https', async () => {
    const http = supabaseHttp();
    const creds = { supabaseApi: { host: 'http://proj.supabase.co', serviceRole: 'k' } };
    const r = await insert(supabase('insert'), svcOf(creds, http));
    expect(r.status).toBe('error');
    expect(http.requests).toHaveLength(0);
  });

  it('lists the tables from the OpenAPI root', async () => {
    const http = supabaseHttp(() => ({
      body: { definitions: { notes: {}, documents: {}, 'bad name': {} }, paths: {} },
    }));
    const search = VectorStoreSupabaseNode.methods?.listSearch?.supabaseTableSearch;
    expect(search).toBeTypeOf('function');
    const found = await search!(listContext(sbCreds.supabaseApi, http));
    expect(found.results.map((x) => x.value)).toEqual(['documents', 'notes']);
    expect(http.requests[0].url).toBe('https://proj.supabase.co/rest/v1/');
  });
});
