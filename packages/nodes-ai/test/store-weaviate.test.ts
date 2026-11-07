/**
 * Weaviate Vector Store (P5-39): REST and GraphQL on FakeHttpClient fixtures written from Weaviate's
 * docs (batch objects, schema, tenants, meta, REST Search API near-vector and hybrid from the v1.40.4
 * OpenAPI spec, GraphQL Get with nearVector and hybrid). A fixture proves the request we send, not
 * Weaviate's answer. The fake answers as v1.38.0 unless a test names a version, so the "Weaviate search"
 * tests cover the GraphQL fallback and "Weaviate REST search" the REST Search API.
 */
import type { DataObject, HttpRequestOptions, Item, WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { VectorStoreWeaviateNode, weaviateProperties } from '../src/nodes/vector-stores/weaviate';
import {
  buildGetQuery,
  parseWhereFilter,
  renderWhere,
  WeaviateQueryError,
} from '../src/nodes/vector-stores/weaviate-graphql';
import {
  hasRestHybridVector,
  hasRestSearch,
  parseWeaviateVersion,
} from '../src/nodes/vector-stores/weaviate-rest';
import { connect, FakeHttpClient, type FakeReply, fakeVector, node, run, services } from './harness';

const BASE = 'https://w.example.com';
const CREDS = { weaviateApi: { connection_type: 'custom_connection', url: `${BASE}/`, apiKey: 'w-key' } };

const DOCS: Item[] = [
  { json: { text: 'Cats and dogs are pets', topic: 'animals' } },
  { json: { text: 'A car has an engine', topic: 'vehicles' } },
];

interface Fixture {
  /** classes the fake schema knows, by name, with their property names */
  classes?: Record<string, { properties: string[]; multiTenancy?: boolean }>;
  tenants?: string[];
  graphql?: (query: string) => FakeReply;
  batch?: (objects: DataObject[]) => FakeReply;
  /** `/v1/meta` version; v1.38.0 (no REST search) by default */
  version?: string;
  /** REST search route; without it the route is unknown (404) */
  search?: (kind: string, body: DataObject) => FakeReply;
}

/** A fake Weaviate: routes by method and path, as the REST API documents them. */
function fakeWeaviate(fixture: Fixture = {}) {
  const classes = fixture.classes ?? {};
  const tenants = fixture.tenants ?? [];
  return new FakeHttpClient((req: HttpRequestOptions) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/v1/.well-known/ready') return { status: 200, body: '' };
    if (path === '/v1/meta')
      return { body: { hostname: 'http://[::]:8080', version: fixture.version ?? '1.38.0' } };
    const searchPath = /^\/v1\/search\/([^/]+)\/([a-z-]+)$/.exec(path);
    if (searchPath && fixture.search && method === 'POST') {
      return fixture.search(searchPath[2], req.body as DataObject);
    }
    if (path === '/v1/schema' && method === 'GET') {
      return { body: { classes: Object.keys(classes).map((name) => ({ class: name })) } };
    }
    if (path === '/v1/schema' && method === 'POST') return { body: req.body };
    const tenantPath = /^\/v1\/schema\/([^/]+)\/tenants$/.exec(path);
    if (tenantPath) {
      if (method === 'GET') return { body: tenants.map((name) => ({ name, activityStatus: 'ACTIVE' })) };
      return { body: method === 'POST' ? req.body : null };
    }
    const classPath = /^\/v1\/schema\/([^/]+)$/.exec(path);
    if (classPath) {
      const name = decodeURIComponent(classPath[1]);
      if (method === 'DELETE') return { body: null };
      const known = classes[name];
      if (!known) return { status: 404, body: null };
      return {
        body: {
          class: name,
          properties: known.properties.map((p) => ({ name: p, dataType: ['text'] })),
          multiTenancyConfig: { enabled: known.multiTenancy === true },
        },
      };
    }
    if (path === '/v1/batch/objects') {
      const objects = (req.body as { objects: DataObject[] }).objects;
      return fixture.batch?.(objects) ?? { body: objects.map((o) => ({ ...o, result: {} })) };
    }
    if (path === '/v1/graphql') {
      const query = (req.body as { query: string }).query;
      return fixture.graphql?.(query) ?? { body: { data: { Get: { Docs: [] } } } };
    }
    return { status: 404, body: { error: [{ message: `no route ${method} ${path}` }] } };
  });
}

function store(mode: string, extra: DataObject = {}): WorkflowNode {
  return node(
    'Store',
    'ai.vectorStoreWeaviate',
    { mode, weaviateCollection: { __rl: true, mode: 'list', value: 'Docs' }, ...extra },
    { credentials: { weaviateApi: { id: 'w', name: 'w' } } },
  );
}

function loader() {
  return node('Loader', 'ai.documentDefaultDataLoader', {
    jsonMode: 'expressionData',
    jsonData: '={{ $json.text }}',
    options: { metadata: { metadataValues: [{ name: 'topic', value: '={{ $json.topic }}' }] } },
  });
}

async function insert(
  storeNode: WorkflowNode,
  http: FakeHttpClient,
  items = DOCS,
  creds: DataObject = CREDS,
) {
  return run(
    [node('Trigger', 'test.trigger'), storeNode, loader(), node('Embeddings', 'test.fakeEmbeddings')],
    connect(
      ['Trigger', storeNode.name],
      ['Loader', storeNode.name, 'ai_document'],
      ['Embeddings', storeNode.name, 'ai_embedding'],
    ),
    { triggerItems: items, services: services({ creds: creds as never, http }) },
  );
}

async function load(
  storeNode: WorkflowNode,
  prompt: string,
  http: FakeHttpClient,
  creds: DataObject = CREDS,
) {
  return run(
    [node('Trigger', 'test.trigger'), storeNode, node('Embeddings', 'test.fakeEmbeddings')],
    connect(['Trigger', storeNode.name], ['Embeddings', storeNode.name, 'ai_embedding']),
    { triggerItems: [{ json: { chatInput: prompt } }], services: services({ creds: creds as never, http }) },
  );
}

const graphqlQueries = (http: FakeHttpClient) =>
  http.requests.filter((r) => r.url.endsWith('/v1/graphql')).map((r) => (r.body as { query: string }).query);

/** The query with every string literal removed: what is left is structure we wrote. */
function withoutStrings(query: string): string {
  return query.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const DOCS_CLASS = { Docs: { properties: ['text', 'source', 'topic'] } };

describe('Weaviate insert', () => {
  it('checks readiness, creates the collection and batch-inserts objects with their vectors', async () => {
    const http = fakeWeaviate();
    const r = await insert(store('insert'), http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const [ready, schema, create, batch] = http.requests;
    expect(ready.url).toBe(`${BASE}/v1/.well-known/ready`);
    expect(ready.timeout).toBe(2000);
    expect(ready.headers?.authorization).toBe('Bearer w-key');
    expect(schema).toMatchObject({ url: `${BASE}/v1/schema/Docs` });
    expect(create).toMatchObject({
      url: `${BASE}/v1/schema`,
      method: 'POST',
      body: { class: 'Docs', vectorizer: 'none', properties: [{ name: 'text', dataType: ['text'] }] },
    });
    expect((create.body as DataObject).multiTenancyConfig).toBeUndefined();
    expect(batch).toMatchObject({ url: `${BASE}/v1/batch/objects`, method: 'POST', timeout: 90_000 });
    const objects = (batch.body as { objects: DataObject[] }).objects;
    expect(objects).toHaveLength(2);
    expect(objects[0]).toEqual({
      class: 'Docs',
      properties: { text: 'Cats and dogs are pets', source: 'json', topic: 'animals' },
      vector: fakeVector('Cats and dogs are pets'),
    });
    for (const request of http.requests) {
      expect(JSON.stringify(request.headers ?? {})).not.toMatch(/openai-platform|n8n/i);
      expect(request.url).not.toContain('w-key');
    }
  });

  it('uses an existing collection and the configured text key', async () => {
    const http = fakeWeaviate({ classes: { Docs: { properties: ['body'] } } });
    const r = await insert(store('insert', { options: { textKey: 'body', skip_init_checks: true } }), http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(http.requests.map((q) => `${q.method ?? 'GET'} ${new URL(q.url).pathname}`)).toEqual([
      'GET /v1/schema/Docs',
      'POST /v1/batch/objects',
    ]);
    const objects = (http.requests[1].body as { objects: DataObject[] }).objects;
    expect((objects[0].properties as DataObject).body).toBe('Cats and dogs are pets');
  });

  it('reports the per-object errors of a batch', async () => {
    const http = fakeWeaviate({
      classes: DOCS_CLASS,
      batch: (objects) => ({
        body: objects.map((o, i) => ({
          ...o,
          result: i === 1 ? { errors: { error: [{ message: 'invalid text property' }] } } : {},
        })),
      }),
    });
    const r = await insert(store('insert'), http);
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/Weaviate rejected 1 of 2 objects: invalid text property/);
  });

  it('creates a multi-tenant collection and the tenant, and writes into it', async () => {
    const http = fakeWeaviate();
    const r = await insert(store('insert', { options: { tenant: 'acme' } }), http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const create = http.requests.find((q) => q.url === `${BASE}/v1/schema` && q.method === 'POST')!;
    expect(create.body).toMatchObject({ class: 'Docs', multiTenancyConfig: { enabled: true } });
    const addTenant = http.requests.find(
      (q) => q.url.endsWith('/v1/schema/Docs/tenants') && q.method === 'POST',
    )!;
    expect(addTenant.body).toEqual([{ name: 'acme' }]);
    const batch = http.requests.find((q) => q.url.endsWith('/v1/batch/objects'))!;
    expect((batch.body as { objects: DataObject[] }).objects.every((o) => o.tenant === 'acme')).toBe(true);
  });

  it('does not add a tenant that exists, and refuses a tenant on a single-tenant collection', async () => {
    const existing = fakeWeaviate({
      classes: { Docs: { properties: ['text'], multiTenancy: true } },
      tenants: ['acme'],
    });
    const ok = await insert(store('insert', { options: { tenant: 'acme' } }), existing);
    expect(ok.status, JSON.stringify(ok.error)).toBe('success');
    expect(existing.requests.some((q) => q.url.endsWith('/tenants') && q.method === 'POST')).toBe(false);

    const single = fakeWeaviate({ classes: DOCS_CLASS });
    const bad = await insert(store('insert', { options: { tenant: 'acme' } }), single);
    expect(bad.error?.message).toMatch(/multi-tenancy/);
    expect(single.requests.some((q) => q.url.endsWith('/v1/batch/objects'))).toBe(false);
  });

  it('Clear Data deletes the collection, or only the tenant when one is set', async () => {
    const whole = fakeWeaviate({ classes: DOCS_CLASS });
    await insert(store('insert', { options: { clearStore: true } }), whole);
    const deleted = whole.requests.find((q) => q.method === 'DELETE')!;
    expect(deleted.url).toBe(`${BASE}/v1/schema/Docs`);
    expect(whole.requests.indexOf(deleted)).toBeLessThan(
      whole.requests.findIndex((q) => q.url.endsWith('/v1/batch/objects')),
    );

    const tenant = fakeWeaviate({ classes: { Docs: { properties: ['text'], multiTenancy: true } } });
    await insert(store('insert', { options: { clearStore: true, tenant: 'acme' } }), tenant);
    const removed = tenant.requests.find((q) => q.method === 'DELETE')!;
    expect(removed.url).toBe(`${BASE}/v1/schema/Docs/tenants`);
    expect(removed.body).toEqual(['acme']);
  });

  it('flattens nested metadata into valid property names', () => {
    expect(
      weaviateProperties(
        {
          pageContent: 'Hello',
          metadata: {
            source: 'blob',
            pdf: { info: { Author: 'Elis', 'Created-At': '2024' } },
            tags: ['a', 'b'],
            'my key': 1,
            '1st': true,
            id: 'x',
            text: 'not the content',
            empty: null,
            rows: [{ a: 1 }],
          },
        },
        'text',
      ),
    ).toEqual({
      text: 'Hello',
      source: 'blob',
      pdf_info_Author: 'Elis',
      pdf_info_Created_At: '2024',
      tags: ['a', 'b'],
      my_key: 1,
      _1st: true,
      meta_id: 'x',
      rows: '[{"a":1}]',
    });
  });
});

describe('Weaviate search', () => {
  it('searches by near vector with the raw distance as score and only the metadata keys the collection has', async () => {
    const http = fakeWeaviate({
      classes: DOCS_CLASS,
      graphql: () => ({
        body: {
          data: {
            Get: {
              Docs: [
                {
                  text: 'Cats and dogs are pets',
                  source: 'json',
                  _additional: { id: '0b1c2d3e-0000-4000-8000-000000000001', distance: 0.12 },
                },
              ],
            },
          },
        },
      }),
    });
    const r = await load(store('load', { topK: 3 }), 'dog', http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Store')).toEqual([
      { document: { pageContent: 'Cats and dogs are pets', metadata: { source: 'json' } }, score: 0.12 },
    ]);
    const [query] = graphqlQueries(http);
    expect(query).toBe(
      `{ Get { Docs(nearVector: {vector: ${JSON.stringify(fakeVector('dog'))}}, limit: 3) { text source _additional { distance } } } }`,
    );
    const graphql = http.requests.find((q) => q.url.endsWith('/v1/graphql'))!;
    expect(graphql).toMatchObject({ method: 'POST', timeout: 30_000 });
  });

  it('runs a hybrid search with every hybrid option', async () => {
    const http = fakeWeaviate({
      classes: { Docs: { properties: ['text', 'question', 'answer'] } },
      graphql: () => ({
        body: {
          data: {
            Get: {
              Docs: [
                { text: 'A', question: 'q?', _additional: { score: '0.75', explainScore: '(bm25) 0.5' } },
                { text: 'B', question: null, _additional: { score: '0.25', explainScore: '(vector) 0.2' } },
              ],
            },
          },
        },
      }),
    });
    const options = {
      hybridQuery: 'salmon "fisher"',
      hybridExplainScore: true,
      fusionType: 'Ranked',
      autoCutLimit: 2,
      alpha: 0.3,
      queryProperties: 'question^2, answer',
      maxVectorDistance: 0.4,
      metadataKeys: 'question',
      tenant: 'acme',
    };
    const r = await load(store('load', { topK: 5, options }), 'dog', http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Store')).toEqual([
      {
        document: { pageContent: 'A', metadata: { question: 'q?', explainScore: '(bm25) 0.5' } },
        score: 0.75,
      },
      { document: { pageContent: 'B', metadata: { explainScore: '(vector) 0.2' } }, score: 0.25 },
    ]);
    const [query] = graphqlQueries(http);
    expect(query).toBe(
      `{ Get { Docs(hybrid: {query: "salmon \\"fisher\\"", vector: ${JSON.stringify(fakeVector('dog'))}, alpha: 0.3, properties: ["question^2","answer"], fusionType: rankedFusion, maxVectorDistance: 0.4}, limit: 5, autocut: 2, tenant: "acme") { text question _additional { score explainScore } } } }`,
    );
  });

  it('falls back to the search text when a hybrid option is set without Query Text', async () => {
    const http = fakeWeaviate({ classes: DOCS_CLASS });
    const r = await load(store('load', { options: { alpha: 0.7 } }), 'pets at home', http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(graphqlQueries(http)[0]).toContain('hybrid: {query: "pets at home", vector: [');
    expect(graphqlQueries(http)[0]).toContain('alpha: 0.7');
  });

  it('passes the JSON search filter as a where argument built from the validated structure', async () => {
    const http = fakeWeaviate({ classes: DOCS_CLASS });
    const filter = {
      AND: [
        { path: ['topic'], operator: 'Equal', valueString: 'animals' },
        { path: ['page'], operator: 'greaterThan', valueNumber: 2 },
        {
          OR: [
            { path: ['tags'], operator: 'ContainsAny', valueTextArray: ['a', 'b'] },
            { path: ['source'], operator: 'IsNull', valueBoolean: false },
          ],
        },
        {
          path: ['place'],
          operator: 'WithinGeoRange',
          valueGeoCoordinates: { latitude: 51.5, longitude: -0.09, distance: 2000 },
        },
      ],
    };
    const r = await load(
      store('load', { options: { searchFilterJson: JSON.stringify(filter) } }),
      'dog',
      http,
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(graphqlQueries(http)[0]).toContain(
      'where: {operator: And, operands: [{path: ["topic"], operator: Equal, valueText: "animals"}, {path: ["page"], operator: GreaterThan, valueNumber: 2}, {operator: Or, operands: [{path: ["tags"], operator: ContainsAny, valueText: ["a","b"]}, {path: ["source"], operator: IsNull, valueBoolean: false}]}, {path: ["place"], operator: WithinGeoRange, valueGeoRange: {geoCoordinates: {latitude: 51.5, longitude: -0.09}, distance: {max: 2000}}}]}',
    );
  });

  it('refuses or escapes a filter injection in key, operator and value', async () => {
    // key: refused before any request
    const keyHttp = fakeWeaviate({ classes: DOCS_CLASS });
    const key = await load(
      store('load', {
        options: {
          searchFilterJson: JSON.stringify({
            path: ['topic"}) { secret } x: Get(where: {path: ["a'],
            operator: 'Equal',
            valueString: 'x',
          }),
        },
      }),
      'dog',
      keyHttp,
    );
    expect(key.status).toBe('error');
    expect(key.error?.message).toMatch(/Invalid property name in search filter/);
    expect(keyHttp.requests).toHaveLength(0);

    // operator: only the allow-list, refused before any request
    const opHttp = fakeWeaviate({ classes: DOCS_CLASS });
    const op = await load(
      store('load', {
        options: {
          searchFilterJson: JSON.stringify({
            path: ['topic'],
            operator: 'Equal, path: ["secret"]',
            valueString: 'x',
          }),
        },
      }),
      'dog',
      opHttp,
    );
    expect(op.error?.message).toBe('Unsupported operator: Equal, path: ["secret"]');
    expect(opHttp.requests).toHaveLength(0);

    // value: sent, but only inside one escaped string literal
    const valueHttp = fakeWeaviate({ classes: DOCS_CLASS });
    const evil = 'x"}) { secret } other: Get { Users { password } } #\\';
    const value = await load(
      store('load', {
        options: {
          searchFilterJson: JSON.stringify({ path: ['topic'], operator: 'Like', valueString: evil }),
        },
      }),
      'dog',
      valueHttp,
    );
    expect(value.status, JSON.stringify(value.error)).toBe('success');
    const [query] = graphqlQueries(valueHttp);
    expect(query).toContain(`valueText: ${JSON.stringify(evil)}`);
    const structure = withoutStrings(query);
    expect(structure).not.toMatch(/secret|password|Users/);
    expect(structure).toBe(
      `{ Get { Docs(nearVector: {vector: ${JSON.stringify(fakeVector('dog'))}}, limit: 4, where: {path: [""], operator: Like, valueText: ""}) { text source _additional { distance } } } }`,
    );
  });

  it('names a bad operator and a missing value as n8n does', () => {
    expect(() => parseWhereFilter({ path: ['a'], operator: 'Between', valueNumber: 1 })).toThrow(
      'Unsupported operator: Between',
    );
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => parseWhereFilter({ path: ['a'], operator: name, valueNumber: 1 })).toThrow(
        `Unsupported operator: ${name}`,
      );
    }
    expect(() => parseWhereFilter({ path: ['a'], operator: 'Like', valueNumber: 1 })).toThrow(
      "Missing 'valueString' for 'like' operator.",
    );
    expect(() => parseWhereFilter({ path: ['a'], operator: 'containsAll', valueTextArray: 'x' })).toThrow(
      "Missing 'valueTextArray' for 'containsAll' operator.",
    );
    expect(() => parseWhereFilter({ path: ['a'], operator: 'Equal' })).toThrow(
      'No valid filter value provided for operator: Equal',
    );
    expect(() => parseWhereFilter({ path: ['a'], operator: 'GreaterThan', valueNumber: Number.NaN })).toThrow(
      "Missing 'valueNumber' for 'greaterThan' operator.",
    );
    expect(() => parseWhereFilter({ AND: 'x' })).toThrow(WeaviateQueryError);
    let deep: DataObject = { path: ['a'], operator: 'Equal', valueString: 'x' };
    for (let i = 0; i < 20; i++) deep = { AND: [deep] };
    expect(() => parseWhereFilter(deep)).toThrow(/nested too deeply/);
  });

  it('surfaces a bad operator from the node with no request', async () => {
    const http = fakeWeaviate({ classes: DOCS_CLASS });
    const r = await load(
      store('load', {
        options: { searchFilterJson: '{"path":["topic"],"operator":"Between","valueNumber":1}' },
      }),
      'dog',
      http,
    );
    expect(r.error?.message).toBe('Unsupported operator: Between');
    expect(http.requests).toHaveLength(0);
  });

  it('reports GraphQL errors and a missing collection, without the key', async () => {
    const failing = fakeWeaviate({
      classes: DOCS_CLASS,
      graphql: () => ({
        body: { errors: [{ message: 'explorer: get class: vector search: tenant not found' }] },
      }),
    });
    const r = await load(store('load'), 'dog', failing);
    expect(r.error?.message).toMatch(
      /Weaviate query failed: explorer: get class: vector search: tenant not found/,
    );
    expect(JSON.stringify(r.error)).not.toContain('w-key');

    const missing = fakeWeaviate();
    const m = await load(store('load'), 'dog', missing);
    expect(m.error?.message).toMatch(/Weaviate collection "Docs" not found/);
    expect(graphqlQueries(missing)).toHaveLength(0);
  });

  it('refuses unsafe collection, text key, metadata key and tenant names before any request', async () => {
    const cases: DataObject[] = [
      { weaviateCollection: 'docs' },
      { weaviateCollection: 'Docs){ x }' },
      { options: { textKey: 'text } x {' } },
      { options: { metadataKeys: 'source,page _additional' } },
      { options: { tenant: 'a"b' } },
      { options: { queryProperties: 'question^x' } },
      { options: { fusionType: 'Ranked) { x' } },
    ];
    for (const extra of cases) {
      const http = fakeWeaviate({ classes: DOCS_CLASS });
      const r = await load(store('load', extra), 'dog', http);
      expect(r.status, JSON.stringify(extra)).toBe('error');
      expect(http.requests, JSON.stringify(extra)).toHaveLength(0);
    }
  });

  it('skips the readiness check when asked and uses the timeouts', async () => {
    const http = fakeWeaviate({ classes: DOCS_CLASS });
    await load(store('load', { options: { skip_init_checks: true, timeout_query: 5 } }), 'dog', http);
    expect(http.requests.some((q) => q.url.endsWith('/.well-known/ready'))).toBe(false);
    expect(http.requests.find((q) => q.url.endsWith('/v1/graphql'))!.timeout).toBe(5000);
  });

  it('reaches Weaviate Cloud over https only', async () => {
    const cloud = {
      weaviateApi: { connection_type: 'weaviate_cloud', url: 'my-cluster.weaviate.cloud', apiKey: 'k' },
    };
    const http = fakeWeaviate({ classes: DOCS_CLASS });
    const r = await load(store('load'), 'dog', http, cloud);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(http.requests[0].url).toBe('https://my-cluster.weaviate.cloud/v1/.well-known/ready');

    const plain = fakeWeaviate({ classes: DOCS_CLASS });
    const bad = await load(store('load'), 'dog', plain, {
      weaviateApi: {
        connection_type: 'weaviate_cloud',
        url: 'http://my-cluster.weaviate.cloud',
        apiKey: 'k',
      },
    });
    expect(bad.error?.message).toMatch(/https/);
    expect(plain.requests).toHaveLength(0);
  });
});

const route = (q: HttpRequestOptions) => `${q.method ?? 'GET'} ${new URL(q.url).pathname}`;
const restSearches = (http: FakeHttpClient) => http.requests.filter((q) => q.url.includes('/v1/search/'));

/** Two prompts through one store node, so one backend serves both searches of the run. */
async function loadTwice(storeNode: WorkflowNode, http: FakeHttpClient) {
  return run(
    [node('Trigger', 'test.trigger'), storeNode, node('Embeddings', 'test.fakeEmbeddings')],
    connect(['Trigger', storeNode.name], ['Embeddings', storeNode.name, 'ai_embedding']),
    {
      triggerItems: [{ json: { chatInput: 'dog' } }, { json: { chatInput: 'cat' } }],
      services: services({ creds: CREDS as never, http }),
    },
  );
}

describe('Weaviate REST search', () => {
  it('searches by near vector over REST with the raw distance as score, the tenant and no redirects', async () => {
    const http = fakeWeaviate({
      version: '1.40.4',
      classes: { Docs: { properties: ['text', 'source', 'topic'], multiTenancy: true } },
      search: () => ({
        body: {
          results: [
            {
              id: '0b1c2d3e-0000-4000-8000-000000000001',
              properties: { text: 'Cats and dogs are pets', source: 'json' },
              metadata: { distance: 0.12 },
            },
          ],
          tookMs: 1,
        },
      }),
    });
    const r = await load(store('load', { topK: 3, options: { tenant: 'acme' } }), 'dog', http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Store')).toEqual([
      { document: { pageContent: 'Cats and dogs are pets', metadata: { source: 'json' } }, score: 0.12 },
    ]);
    expect(http.requests.map(route)).toEqual([
      'GET /v1/.well-known/ready',
      'GET /v1/schema/Docs',
      'GET /v1/meta',
      'POST /v1/search/Docs/near-vector',
    ]);
    const [search] = restSearches(http);
    expect(search).toMatchObject({
      url: `${BASE}/v1/search/Docs/near-vector`,
      method: 'POST',
      timeout: 30_000,
    });
    expect(search.body).toEqual({
      vector: fakeVector('dog'),
      limit: 3,
      returnProperties: ['text', 'source'],
      returnMetadata: ['distance'],
      tenant: 'acme',
    });
    for (const request of http.requests) {
      expect(request.headers?.authorization).toBe('Bearer w-key');
      expect(request.followRedirects, request.url).toBe(false);
    }
  });

  it('runs a hybrid search over REST with every hybrid option and the fused score', async () => {
    const http = fakeWeaviate({
      version: '1.39.15',
      classes: { Docs: { properties: ['text', 'question', 'answer'] } },
      search: () => ({
        body: {
          results: [
            {
              id: '0b1c2d3e-0000-4000-8000-000000000001',
              properties: { text: 'A', question: 'q?' },
              metadata: { score: 0.75, explainScore: '(bm25) 0.5' },
            },
            {
              id: '0b1c2d3e-0000-4000-8000-000000000002',
              properties: { text: 'B' },
              metadata: { score: 0.25 },
            },
          ],
          tookMs: 2,
        },
      }),
    });
    const options = {
      hybridQuery: 'salmon "fisher"',
      hybridExplainScore: true,
      fusionType: 'Ranked',
      autoCutLimit: 2,
      alpha: 0.3,
      queryProperties: 'question^2, answer',
      maxVectorDistance: 0.4,
      metadataKeys: 'question',
      tenant: 'acme',
    };
    const r = await load(store('load', { topK: 5, options }), 'dog', http);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Store')).toEqual([
      {
        document: { pageContent: 'A', metadata: { question: 'q?', explainScore: '(bm25) 0.5' } },
        score: 0.75,
      },
      { document: { pageContent: 'B', metadata: {} }, score: 0.25 },
    ]);
    const [search] = restSearches(http);
    expect(search.url).toBe(`${BASE}/v1/search/Docs/hybrid`);
    expect(search.body).toEqual({
      query: 'salmon "fisher"',
      vector: fakeVector('dog'),
      alpha: 0.3,
      queryProperties: ['question^2', 'answer'],
      fusionType: 'ranked',
      maxVectorDistance: 0.4,
      autoLimit: 2,
      limit: 5,
      returnProperties: ['text', 'question'],
      returnMetadata: ['score', 'explainScore'],
      tenant: 'acme',
    });
    expect(graphqlQueries(http)).toHaveLength(0);
  });

  it('falls back to GraphQL on a 404 or 405 search route and keeps that choice for the run', async () => {
    for (const status of [404, 405]) {
      const http = fakeWeaviate({
        version: '1.40.4',
        classes: DOCS_CLASS,
        search: () => ({ status, body: { code: status, message: 'path not found' } }),
      });
      const r = await loadTwice(store('load'), http);
      expect(r.status, JSON.stringify(r.error)).toBe('success');
      expect(restSearches(http), String(status)).toHaveLength(1);
      expect(graphqlQueries(http), String(status)).toHaveLength(2);
      expect(http.requests.filter((q) => q.url.endsWith('/v1/meta'))).toHaveLength(1);
    }

    // another refusal is Weaviate's answer, not a missing route: shown, no fallback
    const refusing = fakeWeaviate({
      version: '1.40.4',
      classes: DOCS_CLASS,
      search: () => ({ status: 422, body: { error: [{ message: 'vector has 3 dimensions, index has 4' }] } }),
    });
    const bad = await load(store('load'), 'dog', refusing);
    expect(bad.error?.message).toBe("Couldn't query Weaviate: Weaviate answered 422");
    expect(JSON.stringify(bad.error)).toContain('vector has 3 dimensions');
    expect(graphqlQueries(refusing)).toHaveLength(0);
  });

  it('uses GraphQL before v1.39.7, and for a hybrid search before the hybrid route takes our vector', async () => {
    const search = () => ({ body: { results: [], tookMs: 0 } });
    const old = fakeWeaviate({ version: '1.39.6', classes: DOCS_CLASS, search });
    expect((await loadTwice(store('load'), old)).status).toBe('success');
    expect(restSearches(old)).toHaveLength(0);
    expect(graphqlQueries(old)).toHaveLength(2);

    const noVector = fakeWeaviate({ version: '1.40.2', classes: DOCS_CLASS, search });
    expect((await load(store('load', { options: { alpha: 0.7 } }), 'dog', noVector)).status).toBe('success');
    expect(restSearches(noVector)).toHaveLength(0);
    expect(graphqlQueries(noVector)[0]).toContain('hybrid: {query: "dog", vector: [');

    // alpha 0 is keyword only: no vector is sent, so the hybrid route serves it on any REST version
    const keyword = fakeWeaviate({ version: '1.40.2', classes: DOCS_CLASS, search });
    const options = { alpha: 0, maxVectorDistance: 0.4 };
    expect((await load(store('load', { options }), 'dog', keyword)).status).toBe('success');
    expect(restSearches(keyword)[0].body).toEqual({
      query: 'dog',
      alpha: 0,
      limit: 4,
      returnProperties: ['text', 'source'],
      returnMetadata: ['score'],
    });
  });

  it('rebuilds the REST where filter from the validated structure: no injected key or value reaches the body', async () => {
    const evil = 'x", "tenant": "other", "limit": 10000, "returnProperties": ["password"]}';
    const filter = {
      AND: [
        {
          path: ['topic'],
          operator: 'Like',
          valueString: evil,
          tenant: 'other',
          limit: 10000,
          returnProperties: ['password'],
          operands: [{ path: ['secret'], operator: 'IsNull', valueBoolean: false }],
        },
        { path: ['tags'], operator: 'containsAny', valueTextArray: ['a', 'b'], valueNumber: 1 },
        {
          path: ['place'],
          operator: 'WithinGeoRange',
          valueGeoCoordinates: { latitude: 51.5, longitude: -0.09, distance: 2000, extra: 'x' },
        },
      ],
    };
    const http = fakeWeaviate({
      version: '1.40.4',
      classes: { Docs: { properties: ['text', 'source'], multiTenancy: true } },
      search: () => ({ body: { results: [], tookMs: 0 } }),
    });
    const r = await load(
      store('load', { options: { tenant: 'acme', searchFilterJson: JSON.stringify(filter) } }),
      'dog',
      http,
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const body = restSearches(http)[0].body as DataObject;
    expect(body.tenant).toBe('acme');
    expect(body.limit).toBe(4);
    expect(body.returnProperties).toEqual(['text', 'source']);
    expect(body.where).toEqual({
      operator: 'And',
      operands: [
        { path: ['topic'], operator: 'Like', valueText: evil },
        { path: ['tags'], operator: 'ContainsAny', valueTextArray: ['a', 'b'] },
        {
          path: ['place'],
          operator: 'WithinGeoRange',
          valueGeoRange: { geoCoordinates: { latitude: 51.5, longitude: -0.09 }, distance: { max: 2000 } },
        },
      ],
    });

    // a key that is not a property name is refused before any request
    const keyHttp = fakeWeaviate({ version: '1.40.4', classes: DOCS_CLASS, search: () => ({ body: {} }) });
    const key = await load(
      store('load', {
        options: {
          searchFilterJson: JSON.stringify({
            path: ['topic", "tenant": "other'],
            operator: 'Equal',
            valueString: 'x',
          }),
        },
      }),
      'dog',
      keyHttp,
    );
    expect(key.error?.message).toMatch(/Invalid property name in search filter/);
    expect(keyHttp.requests).toHaveLength(0);
  });

  it('reads the server version from /v1/meta', () => {
    expect(parseWeaviateVersion('1.40.4')).toEqual([1, 40, 4]);
    expect(parseWeaviateVersion('1.41.0-rc.1')).toEqual([1, 41, 0]);
    expect(parseWeaviateVersion(undefined)).toBeNull();
    expect(hasRestSearch([1, 39, 6])).toBe(false);
    expect(hasRestSearch([1, 39, 7])).toBe(true);
    expect(hasRestSearch([2, 0, 0])).toBe(true);
    expect(
      [
        [1, 39, 14],
        [1, 39, 15],
        [1, 40, 3],
        [1, 40, 4],
        [1, 41, 0],
      ].map((v) => hasRestHybridVector(v as [number, number, number])),
    ).toEqual([false, true, false, true, true]);
    expect(hasRestHybridVector(null)).toBe(false);
  });
});

describe('Weaviate GraphQL builder', () => {
  it('renders nested filters and refuses an unknown additional field or bad numbers', () => {
    expect(
      renderWhere(parseWhereFilter({ OR: [{ path: 'a', operator: 'equal', valueBoolean: true }] })),
    ).toBe('{operator: Or, operands: [{path: ["a"], operator: Equal, valueBoolean: true}]}');
    expect(() =>
      buildGetQuery({
        className: 'Docs',
        limit: 1,
        properties: ['text'],
        // @ts-expect-error a field outside AdditionalField must be refused at run time
        additional: ['vector'],
        nearVector: [1],
      }),
    ).toThrow(WeaviateQueryError);
    expect(() =>
      buildGetQuery({
        className: 'Docs',
        limit: 1,
        properties: ['text'],
        additional: [],
        nearVector: [Number.NaN],
      }),
    ).toThrow(WeaviateQueryError);
    expect(() =>
      buildGetQuery({ className: 'docs', limit: 1, properties: ['text'], additional: [], nearVector: [1] }),
    ).toThrow(/collection name/);
  });
});

describe('Weaviate node description', () => {
  const description = VectorStoreWeaviateNode.description;

  it('has a collection locator with a list search, and no gRPC fields', async () => {
    const collection = description.properties.find((p) => p.name === 'weaviateCollection')!;
    expect(collection.type).toBe('resourceLocator');
    expect(JSON.stringify(description)).not.toMatch(/grpc/i);
    const searchOptions = description.properties.find(
      (p) => p.name === 'options' && p.displayOptions?.show?.mode?.includes('load'),
    )!;
    const names = ((searchOptions.options ?? []) as Array<{ name: string; description?: string }>).map(
      (o) => o.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'searchFilterJson',
        'metadataKeys',
        'hybridQuery',
        'hybridExplainScore',
        'fusionType',
        'autoCutLimit',
        'alpha',
        'queryProperties',
        'maxVectorDistance',
        'tenant',
        'textKey',
        'skip_init_checks',
        'timeout_init',
        'timeout_insert',
        'timeout_query',
      ]),
    );
    const hybrid = (searchOptions.options as Array<{ name: string; description?: string }>).find(
      (o) => o.name === 'hybridQuery',
    )!;
    expect(hybrid.description).toMatch(/distance/);

    const list = VectorStoreWeaviateNode.methods!.listSearch!.weaviateCollectionsSearch;
    const requested: string[] = [];
    const context = {
      getCredentials: async () => CREDS.weaviateApi,
      helpers: {
        httpRequestWithAuthentication: async (_type: string, options: { url: string }) => {
          requested.push(options.url);
          return { classes: [{ class: 'Zeta' }, { class: 'Docs' }, { class: 'Notes' }] };
        },
      },
    } as never;
    expect((await list(context, 'do')).results).toEqual([{ name: 'Docs', value: 'Docs' }]);
    expect((await list(context)).results.map((r) => r.value)).toEqual(['Docs', 'Notes', 'Zeta']);
    expect(requested[0]).toBe(`${BASE}/v1/schema`);
  });

  it('offers Clear Data on insert', () => {
    const insertOptions = description.properties.find(
      (p) => p.name === 'options' && p.displayOptions?.show?.mode?.includes('insert'),
    )!;
    const clear = (insertOptions.options as Array<{ name: string; displayName: string }>).find(
      (o) => o.name === 'clearStore',
    )!;
    expect(clear.displayName).toBe('Clear Data');
  });
});
