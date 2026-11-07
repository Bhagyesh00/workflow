/**
 * Weaviate Vector Store (P5-39): REST and GraphQL on FakeHttpClient fixtures written from Weaviate's
 * docs (batch objects, schema, tenants, GraphQL Get with nearVector and hybrid). A fixture proves the
 * request we send, not Weaviate's answer.
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
