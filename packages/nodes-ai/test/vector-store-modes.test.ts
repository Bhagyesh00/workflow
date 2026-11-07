import { NodeTypes } from '@workflow/core';
import type { AiDocument, AiReranker, DataObject, Item, NodeProperty, NodeType } from '@workflow/workflow';
import { evaluateSimple } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import {
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  toAiVectorStore,
  VECTOR_STORE_INPUTS,
  VECTOR_STORE_OUTPUTS,
} from '../src/nodes/vector-stores/vector-store-factory';
import {
  clearMemoryVectorStores,
  MemoryVectorBackend,
  VectorStoreInMemoryNode,
  vectorStoreNodes,
} from '../src/nodes/vector-stores/vector-stores.nodes';
import {
  connect,
  embeddingCalls,
  modelRequests,
  node,
  rerankerCalls,
  run,
  scriptModel,
  services,
  testNodes,
  toolCalls,
  vectorStoreMemoryData,
} from './harness';

const DOCS: Item[] = [
  { json: { text: 'Cats and dogs are pets', topic: 'animals' } },
  { json: { text: 'A car has an engine and drives on the road', topic: 'vehicles' } },
  { json: { text: 'Pizza and pasta are food', topic: 'food' } },
  { json: { text: 'The sun and the moon are in the sky', topic: 'space' } },
];

const KEY = `modes-${process.pid}-${Date.now()}`;

beforeEach(() => {
  vectorStoreMemoryData.clear();
  rerankerCalls.length = 0;
  embeddingCalls.length = 0;
  modelRequests.clear();
  clearMemoryVectorStores();
});

const store = (mode: string, extra: DataObject = {}, name = 'Store') =>
  node(name, 'test.vectorStoreMemory', { mode, memoryKey: KEY, ...extra });

const loader = () =>
  node('Loader', 'ai.documentDefaultDataLoader', {
    jsonMode: 'expressionData',
    jsonData: '={{ $json.text }}',
    options: { metadata: { metadataValues: [{ name: 'topic', value: '={{ $json.topic }}' }] } },
  });

async function insertDocs(extra: DataObject = {}, items = DOCS) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      store('insert', extra),
      loader(),
      node('Embeddings', 'test.fakeEmbeddings'),
    ],
    connect(
      ['Trigger', 'Store'],
      ['Loader', 'Store', 'ai_document'],
      ['Embeddings', 'Store', 'ai_embedding'],
    ),
    { triggerItems: items },
  );
}

const pageContents = (docs: unknown[]) =>
  docs.map((o) => ((o as DataObject).document as DataObject).pageContent);

describe('store modes and ports', () => {
  const ports = (expr: string, parameter: DataObject) =>
    (evaluateSimple(expr, { $parameter: parameter }) as Array<string | { type: string }>).map((p) =>
      typeof p === 'string' ? p : p.type,
    );

  it('gives each mode its inputs and outputs', () => {
    expect(ports(VECTOR_STORE_INPUTS, { mode: 'update' })).toEqual(['main', 'ai_embedding']);
    expect(ports(VECTOR_STORE_INPUTS, { mode: 'retrieve-as-tool' })).toEqual(['ai_embedding']);
    expect(ports(VECTOR_STORE_OUTPUTS, { mode: 'retrieve-as-tool' })).toEqual(['ai_tool']);
    expect(ports(VECTOR_STORE_OUTPUTS, { mode: 'update' })).toEqual(['main']);
    expect(ports(VECTOR_STORE_OUTPUTS, { mode: 'retrieve' })).toEqual(['ai_vectorStore']);
  });

  it('adds a required reranker input on load, retrieve and tool when Use Reranker is on', () => {
    expect(ports(VECTOR_STORE_INPUTS, { mode: 'load', useReranker: true })).toEqual([
      'main',
      'ai_embedding',
      'ai_reranker',
    ]);
    expect(ports(VECTOR_STORE_INPUTS, { mode: 'retrieve', useReranker: true })).toEqual([
      'ai_embedding',
      'ai_reranker',
    ]);
    expect(ports(VECTOR_STORE_INPUTS, { mode: 'retrieve-as-tool', useReranker: true })).toEqual([
      'ai_embedding',
      'ai_reranker',
    ]);
    expect(ports(VECTOR_STORE_INPUTS, { mode: 'load', useReranker: false })).toEqual([
      'main',
      'ai_embedding',
    ]);
    // insert and update never take one
    expect(ports(VECTOR_STORE_INPUTS, { mode: 'insert', useReranker: true })).toEqual([
      'main',
      'ai_document',
      'ai_embedding',
    ]);
    expect(ports(VECTOR_STORE_INPUTS, { mode: 'update', useReranker: true })).toEqual([
      'main',
      'ai_embedding',
    ]);
    const reranker = nodes.find((n) => n.description.name === 'ai.vectorStoreInMemory')!;
    const useReranker = reranker.description.properties.find((p) => p.name === 'useReranker')!;
    expect(useReranker.displayOptions?.show?.mode).toEqual(['load', 'retrieve', 'retrieve-as-tool']);
  });
});

describe('modes and filter kind of the 12 stores', () => {
  // [name, modes beyond the default four, filter kind]
  const EXPECTED: Array<[string, boolean, 'none' | 'metadata' | 'json']> = [
    ['ai.vectorStoreInMemory', false, 'none'],
    ['ai.vectorStorePGVector', false, 'metadata'],
    ['ai.vectorStoreQdrant', false, 'metadata'],
    ['ai.vectorStorePinecone', true, 'metadata'],
    ['ai.vectorStoreSupabase', true, 'metadata'],
    ['ai.vectorStoreWeaviate', false, 'json'],
    ['ai.vectorStoreMongoDBAtlas', true, 'metadata'],
    ['ai.vectorStoreRedis', true, 'none'],
    ['ai.vectorStoreAzureAISearch', true, 'none'],
    ['ai.vectorStoreChromaDB', false, 'metadata'],
    ['ai.vectorStoreMilvus', false, 'none'],
    ['ai.vectorStoreDatabricks', false, 'json'],
  ];

  it('lists exactly the 12 stores', () => {
    expect(vectorStoreNodes.map((n) => n.description.name)).toEqual(EXPECTED.map(([name]) => name));
  });

  it.each(EXPECTED)('%s: update %s, filter %s', (name, hasUpdate, filter) => {
    const description = vectorStoreNodes.find((n) => n.description.name === name)!.description;
    const modeProperty = description.properties.find((p) => p.name === 'mode')!;
    const modes = (modeProperty.options as Array<{ value: string }>).map((o) => o.value);
    expect(modes).toEqual([...DEFAULT_VECTOR_STORE_MODES, ...(hasUpdate ? ['update'] : [])]);
    const searchOptions = description.properties.find(
      (p) => p.name === 'options' && p.displayOptions?.show?.mode?.includes('load'),
    );
    const optionNames = ((searchOptions?.options ?? []) as NodeProperty[]).map((o) => o.name);
    if (filter === 'metadata') expect(optionNames).toContain('metadata');
    if (filter === 'json') {
      expect(optionNames).toContain('searchFilterJson');
      expect(optionNames).not.toContain('metadata');
    }
    if (filter === 'none') expect(optionNames).not.toContain('metadata');
    // tool mode and reranker are on every store
    const names = description.properties.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['toolDescription', 'useReranker', 'topK']));
    expect(names.includes('id')).toBe(true);
  });

  it('refuses update on a store that does not list it', async () => {
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'ai.vectorStoreInMemory', { mode: 'update', id: 'a' }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
      { triggerItems: [{ json: { text: 'x' } }] },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Update operation is not implemented for this Vector Store');
  });
});

describe('retrieve as tool', () => {
  const agentRun = async (
    toolParams: DataObject,
    script: Parameters<typeof scriptModel>[1],
    extra = false,
  ) => {
    const requests = scriptModel('Model', script);
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', {
          promptType: 'define',
          text: 'go',
          options: { returnIntermediateSteps: true },
        }),
        node('Model', 'test.fakeChatModel'),
        store('retrieve-as-tool', toolParams, 'Docs'),
        node('Embeddings', 'test.fakeEmbeddings'),
        ...(extra ? [node('Reranker', 'test.fakeReranker')] : []),
      ],
      connect(
        ['Trigger', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['Docs', 'Agent', 'ai_tool'],
        ['Embeddings', 'Docs', 'ai_embedding'],
        ...(extra ? [['Reranker', 'Docs', 'ai_reranker'] as [string, string, 'ai_reranker']] : []),
      ),
    );
    const steps = (r.output('Agent')[0]?.intermediateSteps ?? []) as Array<{ observation: string }>;
    return { r, requests, steps };
  };

  it('lets an agent search the store, named after the node, one JSON text per document', async () => {
    await insertDocs();
    const { r, requests, steps } = await agentRun(
      { toolDescription: 'Search the pets and food notes', topK: 2 },
      [toolCalls(['Docs', { input: 'pizza' }]), 'done'],
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    const tool = requests[0].tools!.find((t) => t.name === 'Docs')!;
    expect(tool.description).toBe('Search the pets and food notes');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    });
    const lines = steps[0].observation.split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      pageContent: 'Pizza and pasta are food',
      metadata: { source: 'json', topic: 'food' },
    });
  });

  it('leaves the metadata out when Include Metadata is off', async () => {
    await insertDocs();
    const { steps } = await agentRun({ toolDescription: 'Search', topK: 1, includeDocumentMetadata: false }, [
      toolCalls(['Docs', { input: 'moon' }]),
      'done',
    ]);
    expect(JSON.parse(steps[0].observation)).toEqual({ pageContent: 'The sun and the moon are in the sky' });
  });

  it('applies the metadata filter and refuses a call without input', async () => {
    await insertDocs();
    const filtered = await agentRun(
      {
        toolDescription: 'Search',
        topK: 4,
        options: { metadata: { metadataValues: [{ name: 'topic', value: 'vehicles' }] } },
      },
      [toolCalls(['Docs', { input: 'pizza' }]), 'done'],
    );
    expect(filtered.steps[0].observation.split('\n')).toHaveLength(1);
    expect(filtered.steps[0].observation).toContain('engine');
    const empty = await agentRun({ toolDescription: 'Search' }, [toolCalls(['Docs', {}]), 'done']);
    expect(empty.steps[0].observation).toMatch(/input is required/);
  });

  it('needs a description', async () => {
    const { r } = await agentRun({ toolDescription: '  ' }, ['done']);
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/description for the tool/);
  });

  it('reranks the tool results', async () => {
    await insertDocs();
    const { steps } = await agentRun(
      { toolDescription: 'Search', topK: 2, useReranker: true },
      [toolCalls(['Docs', { input: 'pizza' }]), 'done'],
      true,
    );
    expect(rerankerCalls).toHaveLength(1);
    expect(rerankerCalls[0].query).toBe('pizza');
    const lines = steps[0].observation.split('\n').map((l) => JSON.parse(l));
    // the fake reranker reverses the store's ranking
    expect(lines[1].pageContent).toBe('Pizza and pasta are food');
  });

  it('is a sub-node only', async () => {
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        store('retrieve-as-tool', { toolDescription: 'x' }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
    );
    expect(r.status).toBe('error');
  });
});

describe('update mode', () => {
  const update = (items: Item[], extra: DataObject = {}, continueOnFail = false) =>
    run(
      [
        node('Trigger', 'test.trigger'),
        {
          ...store('update', { id: '={{ $json.id }}', ...extra }),
          ...(continueOnFail ? { continueOnFail: true } : {}),
        },
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
      { triggerItems: items },
    );

  it('replaces the document with the given id by the flattened item JSON', async () => {
    const first = await update([{ json: { id: 'doc-a', note: 'Cats and dogs are pets' } }]);
    expect(first.status, JSON.stringify(first.error)).toBe('success');
    expect(first.output('Store')).toEqual([
      { id: 'doc-a', pageContent: ['id: doc-a', 'note: Cats and dogs are pets'].join('\n') },
    ]);
    const entries = vectorStoreMemoryData.get(KEY)!;
    expect(entries.size).toBe(1);
    const second = await update([
      { json: { id: 'doc-a', note: 'Pizza', detail: { size: 'large' } } },
      { json: { id: 'doc-b', note: 'Moon' } },
    ]);
    expect(second.status).toBe('success');
    expect(entries.size).toBe(2);
    expect(entries.get('doc-a')!.document.pageContent).toBe(
      ['id: doc-a', 'note: Pizza', 'detail.size: large'].join('\n'),
    );
    expect(entries.get('doc-b')!.document.pageContent).toBe(['id: doc-b', 'note: Moon'].join('\n'));
  });

  it('wants one document per item', async () => {
    const r = await update([{ json: {} }], { id: 'doc-a' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Single document per item expected');
    const noId = await update([{ json: { note: 'x' } }], { id: '' });
    expect(noId.error?.message).toBe('The ID is empty');
  });
});

describe('reranker', () => {
  it('reorders load results and uses its score', async () => {
    await insertDocs();
    const loadRun = (extra: DataObject, withReranker: boolean) =>
      run(
        [
          node('Trigger', 'test.trigger'),
          store('load', { topK: 2, ...extra }),
          node('Embeddings', 'test.fakeEmbeddings'),
          ...(withReranker ? [node('Reranker', 'test.fakeReranker')] : []),
        ],
        connect(
          ['Trigger', 'Store'],
          ['Embeddings', 'Store', 'ai_embedding'],
          ...(withReranker ? [['Reranker', 'Store', 'ai_reranker'] as [string, string, 'ai_reranker']] : []),
        ),
        { triggerItems: [{ json: { chatInput: 'pizza' } }] },
      );
    const plain = await loadRun({}, false);
    expect(pageContents(plain.output('Store'))[0]).toBe('Pizza and pasta are food');
    expect(rerankerCalls).toHaveLength(0);

    const reranked = await loadRun({ useReranker: true }, true);
    expect(reranked.status, JSON.stringify(reranked.error)).toBe('success');
    const out = reranked.output('Store');
    expect(pageContents(out)).toEqual(['Cats and dogs are pets', 'Pizza and pasta are food']);
    expect(out.map((o) => o.score)).toEqual([1, 0.5]);
    expect(rerankerCalls).toHaveLength(1);
    expect(rerankerCalls[0]).toMatchObject({ query: 'pizza' });

    const missing = await loadRun({ useReranker: true }, false);
    expect(missing.status).toBe('error');
  });

  it('reranks what a chain retrieves', async () => {
    await insertDocs();
    const requests = scriptModel('Model', ['ok']);
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('QA', 'ai.chainRetrievalQa', { options: { topK: 2 } }),
        node('Model', 'test.fakeChatModel'),
        store('retrieve', { useReranker: true }),
        node('Embeddings', 'test.fakeEmbeddings'),
        node('Reranker', 'test.fakeReranker'),
      ],
      connect(
        ['Trigger', 'QA'],
        ['Model', 'QA', 'ai_languageModel'],
        ['Store', 'QA', 'ai_vectorStore'],
        ['Embeddings', 'Store', 'ai_embedding'],
        ['Reranker', 'Store', 'ai_reranker'],
      ),
      { triggerItems: [{ json: { chatInput: 'pizza' } }] },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(rerankerCalls).toHaveLength(1);
    const context = String(requests[0].messages[0].content);
    expect(context.indexOf('Cats and dogs')).toBeLessThan(context.indexOf('Pizza and pasta'));
  });

  it('takes the score from the reranker and drops relevanceScore from the metadata', async () => {
    const backend = new MemoryVectorBackend();
    await backend.add(
      [
        { pageContent: 'a', metadata: { relevanceScore: 0.1, keep: 1 } },
        { pageContent: 'b', metadata: { relevanceScore: 0.2 } },
      ],
      [[1], [1]],
    );
    const reranker: AiReranker = {
      kind: 'reranker',
      async rerank(_query, documents: AiDocument[]) {
        return [...documents].reverse().map((document) => ({ document, score: 0.77 }));
      },
    };
    const embeddings = {
      kind: 'embeddings' as const,
      dimensions: 1,
      embedDocuments: async (t: string[]) => t.map(() => [1]),
      embedQuery: async () => [1],
    };
    const results = await toAiVectorStore(
      backend,
      embeddings,
      undefined,
      undefined,
      reranker,
    ).similaritySearch('q', 5);
    expect(results.map((r) => r.document.pageContent)).toEqual(['b', 'a']);
    expect(results.map((r) => r.score)).toEqual([0.77, 0.77]);
    expect(results[1].document.metadata).toEqual({ keep: 1 });
  });
});

describe('embedding batch size', () => {
  it('embeds in groups of the batch size', async () => {
    const r = await insertDocs({ options: { embeddingBatchSize: 3 } });
    expect(r.status).toBe('success');
    expect(embeddingCalls.map((c) => c.length)).toEqual([3, 1]);
    expect(vectorStoreMemoryData.get(KEY)!.size).toBe(4);
  });

  it('defaults to 200 documents per request', async () => {
    const many: Item[] = Array.from({ length: 205 }, (_, i) => ({ json: { text: `cat ${i}`, topic: 't' } }));
    await insertDocs({}, many);
    expect(embeddingCalls.map((c) => c.length)).toEqual([200, 5]);
  });
});

describe('filter kinds', () => {
  const searches: Array<{ filter?: DataObject }> = [];
  const jsonStore: NodeType = createVectorStoreNode({
    name: 'test.jsonFilterStore',
    displayName: 'Json Filter Store',
    description: '',
    icon: 'lucide:database',
    filter: 'json',
    retrieveOptions: [{ displayName: 'Extra', name: 'extra', type: 'string', default: '' }],
    properties: [],
    async open() {
      return {
        backend: {
          async add() {},
          async search(_vector, _k, filter) {
            searches.push({ filter });
            return [];
          },
        },
      };
    },
  });
  const types = new NodeTypes([...nodes, ...testNodes, jsonStore]);
  const loadWith = (options: DataObject) =>
    run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'test.jsonFilterStore', { mode: 'load', options }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
      {
        triggerItems: [{ json: { chatInput: 'dog' } }],
        nodeTypes: types,
        services: services({ nodeTypes: types }),
      },
    );

  beforeEach(() => {
    searches.length = 0;
  });

  it('parses the JSON filter and passes it on, merged retrieve options included', () => {
    const description = jsonStore.description.properties.find((p) => p.name === 'options')!;
    expect((description.options as NodeProperty[]).map((o) => o.name)).toEqual(['searchFilterJson', 'extra']);
  });

  it('passes a parsed JSON filter to the search', async () => {
    const r = await loadWith({ searchFilterJson: '{"must":[{"key":"a","match":{"value":1}}]}' });
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(searches[0].filter).toEqual({ must: [{ key: 'a', match: { value: 1 } }] });
    await loadWith({});
    expect(searches[1].filter).toBeUndefined();
  });

  it('refuses a filter that is not a JSON object', async () => {
    expect((await loadWith({ searchFilterJson: '{oops' })).status).toBe('error');
    const array = await loadWith({ searchFilterJson: '[1]' });
    expect(array.error?.message).toMatch(/must be a JSON object/);
    expect(searches).toHaveLength(0);
  });
});

describe('Simple Vector Store memory keys', () => {
  const list = VectorStoreInMemoryNode.methods!.listSearch!.vectorStoresSearch;
  const asTenant = (tenantId: string) => ({ getTenantId: () => tenantId }) as never;
  const simple = (key: unknown) =>
    node('Store', 'ai.vectorStoreInMemory', { mode: 'insert', memoryKey: key });

  const insertAs = (key: unknown, tenantId: string) =>
    run(
      [node('Trigger', 'test.trigger'), simple(key), loader(), node('Embeddings', 'test.fakeEmbeddings')],
      connect(
        ['Trigger', 'Store'],
        ['Loader', 'Store', 'ai_document'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
      { triggerItems: [DOCS[0]], services: services({ tenantId }) },
    );

  it('lists this tenant keys only and filters them by the typed text', async () => {
    await insertAs('kb-alpha', 'tenant-a');
    await insertAs({ __rl: true, mode: 'id', value: 'kb-beta' }, 'tenant-a');
    await insertAs('kb-other', 'tenant-b');
    expect((await list(asTenant('tenant-a'))).results).toEqual([
      { name: 'kb-alpha', value: 'kb-alpha' },
      { name: 'kb-beta', value: 'kb-beta' },
    ]);
    expect((await list(asTenant('tenant-a'), 'BET')).results.map((r) => r.value)).toEqual(['kb-beta']);
    expect((await list(asTenant('tenant-b'))).results.map((r) => r.value)).toEqual(['kb-other']);
    expect((await list(asTenant('tenant-c'))).results).toEqual([]);
    expect((await list(asTenant('tenant-b'), 'alpha')).results).toEqual([]);
  });

  it('reads a locator value and a plain string alike, and creates a new key by name', async () => {
    await insertAs({ __rl: true, mode: 'list', value: 'shared' }, 'tenant-a');
    const read = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'ai.vectorStoreInMemory', { mode: 'load', memoryKey: 'shared' }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
      { triggerItems: [{ json: { chatInput: 'dog' } }], services: services({ tenantId: 'tenant-a' }) },
    );
    expect(pageContents(read.output('Store'))).toEqual(['Cats and dogs are pets']);
  });

  it('has no metadata filter field', () => {
    const options = VectorStoreInMemoryNode.description.properties.filter((p) => p.name === 'options');
    for (const group of options) {
      expect((group.options as NodeProperty[]).map((o) => o.name)).not.toContain('metadata');
    }
  });
});
