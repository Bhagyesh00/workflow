/**
 * Phase 5 S2 C0d: what the store, reranker and retriever lanes build on. Names, registrations, ports and
 * credentials of the new nodes, the factory's new types, `getReranker` and the retriever move. No stub's body.
 */
import { credentials as baseCredentials } from '@workflow/nodes-base';
import {
  type AiDocument,
  type AiEmbeddings,
  type AiReranker,
  evaluatePortExpression,
  type NodeType,
  portType,
  type SupplyDataContext,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { credentials, nodes } from '../src';
import { ragChainNodes } from '../src/nodes/chains/rag-chains.nodes';
import { RerankerCohereNode } from '../src/nodes/rerankers/RerankerCohere.node';
import { RetrieverVectorStoreNode } from '../src/nodes/retrievers/RetrieverVectorStore.node';
import { retrieverNodes } from '../src/nodes/retrievers/retrievers.nodes';
import {
  DEFAULT_VECTOR_STORE_MODES,
  toAiVectorStore,
  type VectorBackend,
  type VectorStoreMode,
  type VectorStoreSpec,
} from '../src/nodes/vector-stores/vector-store-factory';
import { vectorStoreNodes } from '../src/nodes/vector-stores/vector-stores.nodes';
import { getReranker } from '../src/shared/ai-inputs';

/** new store: credential names (and `testedBy` where the node tests the credential) */
const STORES: Record<string, Array<{ name: string; testedBy?: string }>> = {
  'ai.vectorStorePinecone': [{ name: 'pineconeApi' }],
  'ai.vectorStoreSupabase': [{ name: 'supabaseApi' }],
  'ai.vectorStoreWeaviate': [{ name: 'weaviateApi' }],
  'ai.vectorStoreMongoDBAtlas': [{ name: 'mongoDb', testedBy: 'mongoDbConnectionTest' }],
  'ai.vectorStoreRedis': [{ name: 'redis' }],
  'ai.vectorStoreAzureAISearch': [{ name: 'azureAiSearchApi' }],
  'ai.vectorStoreChromaDB': [{ name: 'chromaSelfHostedApi' }, { name: 'chromaCloudApi' }],
  'ai.vectorStoreMilvus': [{ name: 'milvusApi' }],
  'ai.vectorStoreDatabricks': [{ name: 'databricksOAuth2Api' }],
};

const RETRIEVERS = [
  'ai.retrieverVectorStore',
  'ai.retrieverContextualCompression',
  'ai.retrieverMultiQuery',
  'ai.retrieverWorkflow',
];

const NEW_NAMES = [...Object.keys(STORES), 'ai.rerankerCohere', ...RETRIEVERS];

const allCredentialNames = new Set([...credentials, ...baseCredentials].map((c) => c.name));

function byName(name: string): NodeType {
  const type = nodes.find((n) => n.description.name === name);
  if (!type) throw new Error(`${name} is not registered`);
  return type;
}

function outputTypes(type: NodeType, parameters: Record<string, unknown> = {}): string[] {
  const outputs = type.description.outputs;
  const list = typeof outputs === 'string' ? evaluatePortExpression(outputs, parameters) : outputs;
  return (list as Parameters<typeof portType>[0][]).map(portType);
}

function inputTypes(type: NodeType): string[] {
  const inputs = type.description.inputs;
  expect(Array.isArray(inputs), type.description.name).toBe(true);
  return (inputs as Parameters<typeof portType>[0][]).map(portType);
}

describe('registry', () => {
  it('registers every new name once', () => {
    for (const name of NEW_NAMES) {
      expect(nodes.filter((n) => n.description.name === name).length, name).toBe(1);
    }
  });

  it('lists the stores in vectorStoreNodes and the retrievers in retrieverNodes', () => {
    const stores = vectorStoreNodes.map((n) => n.description.name);
    for (const name of Object.keys(STORES)) expect(stores, name).toContain(name);
    expect(retrieverNodes.map((n) => n.description.name)).toEqual(RETRIEVERS);
    for (const type of [...vectorStoreNodes, ...retrieverNodes, RerankerCohereNode]) {
      expect(byName(type.description.name), type.description.name).toBe(type);
    }
  });
});

describe('vector stores', () => {
  it.each(Object.entries(STORES))('%s: ports by mode, credentials, categories', (name, expected) => {
    const type = byName(name);
    const d = type.description;
    expect(d.categories).toEqual(['AI', 'Vector Stores']);
    expect(d.icon).toMatch(/^(lucide|simple):[a-z0-9-]+$/);
    expect(outputTypes(type, { mode: 'retrieve' })).toEqual(['ai_vectorStore']);
    expect(outputTypes(type, { mode: 'load' })).toEqual(['main']);
    expect(outputTypes(type, { mode: 'insert' })).toEqual(['main']);
    expect(typeof type.supplyData).toBe('function');
    expect(typeof type.execute).toBe('function');
    const creds = d.credentials ?? [];
    expect(creds.map((c) => c.name)).toEqual(expected.map((c) => c.name));
    for (const [i, c] of creds.entries()) {
      expect(c.testedBy, `${name} ${c.name}`).toBe(expected[i].testedBy);
      expect(allCredentialNames.has(c.name), `${name}: credential type ${c.name}`).toBe(true);
    }
  });

  it('the Chroma credentials follow the Authentication choice', () => {
    const creds = byName('ai.vectorStoreChromaDB').description.credentials ?? [];
    expect(creds.map((c) => c.displayOptions?.show?.authentication)).toEqual([
      ['chromaSelfHostedApi'],
      ['chromaCloudApi'],
    ]);
  });
});

describe('vector store factory contract', () => {
  it('default modes are n8n default operation modes, update is opt-in', () => {
    expect(DEFAULT_VECTOR_STORE_MODES).toEqual(['load', 'insert', 'retrieve', 'retrieve-as-tool']);
    const all: VectorStoreMode[] = [...DEFAULT_VECTOR_STORE_MODES, 'update'];
    expect(all).toHaveLength(5);
  });

  it('backends take ids and the query text; the spec takes modes, filter kind, options and methods', async () => {
    const added: Array<{ ids?: string[] }> = [];
    const searched: Array<string | undefined> = [];
    const backend: VectorBackend = {
      async add(_documents, _vectors, ids) {
        added.push({ ids });
      },
      async search(_vector, _k, _filter, text) {
        searched.push(text);
        return [];
      },
    };
    await backend.add([{ pageContent: 'a', metadata: {} }], [[1]], ['id-1']);
    await backend.search([1], 1, undefined, 'query');
    expect(added).toEqual([{ ids: ['id-1'] }]);
    expect(searched).toEqual(['query']);

    const spec: VectorStoreSpec = {
      name: 'test.contractStore',
      displayName: 'Contract Store',
      description: 'type check only',
      icon: 'lucide:database',
      credentials: [{ name: 'mongoDb', required: true, testedBy: 'mongoDbConnectionTest' }],
      modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
      filter: 'json',
      retrieveOptions: [{ displayName: 'Namespace', name: 'namespace', type: 'string', default: '' }],
      methods: { listSearch: {} },
      properties: [],
      open: async () => ({ backend }),
    };
    expect(spec.filter).toBe('json');
  });

  it('toAiVectorStore takes a reranker as its last parameter', () => {
    const embeddings: AiEmbeddings = {
      kind: 'embeddings',
      embedDocuments: async (texts) => texts.map(() => [1]),
      embedQuery: async () => [1],
    } as AiEmbeddings;
    const reranker: AiReranker = {
      kind: 'reranker',
      rerank: async (_query, documents: AiDocument[]) =>
        documents.map((document) => ({ document, score: 1 })),
    };
    const backend: VectorBackend = { add: async () => {}, search: async () => [] };
    const store = toAiVectorStore(backend, embeddings, undefined, undefined, reranker);
    expect(store.kind).toBe('vectorStore');
  });
});

describe('getReranker', () => {
  const reranker: AiReranker = { kind: 'reranker', rerank: async () => [] };
  function ctxWith(value: unknown, calls: string[] = []): SupplyDataContext {
    return {
      getNode: () => ({ name: 'Store', type: 'ai.vectorStoreInMemory' }),
      getInputConnectionData: async (type: string) => {
        calls.push(type);
        return value;
      },
    } as unknown as SupplyDataContext;
  }

  it('returns the connected reranker from the ai_reranker port', async () => {
    const calls: string[] = [];
    expect(await getReranker(ctxWith(reranker, calls), 0)).toBe(reranker);
    expect(calls).toEqual(['ai_reranker']);
    expect(await getReranker(ctxWith([reranker]), 0)).toBe(reranker);
  });

  it('is undefined when nothing is connected', async () => {
    expect(await getReranker(ctxWith(undefined), 0)).toBeUndefined();
    expect(await getReranker(ctxWith(null), 0)).toBeUndefined();
  });

  it('refuses a node that supplies something else', async () => {
    await expect(getReranker(ctxWith({ kind: 'retriever' }), 0)).rejects.toThrow(
      'The node connected as reranker does not supply a reranker',
    );
  });
});

describe('reranker and retrievers', () => {
  it('the Cohere reranker is a sub-node on ai_reranker with cohereApi', () => {
    const d = RerankerCohereNode.description;
    expect(d.name).toBe('ai.rerankerCohere');
    expect(outputTypes(RerankerCohereNode)).toEqual(['ai_reranker']);
    expect(d.inputs).toEqual([]);
    expect(d.categories).toEqual(['AI', 'Rerankers']);
    expect(d.credentials?.map((c) => c.name)).toEqual(['cohereApi']);
    expect(allCredentialNames.has('cohereApi')).toBe(true);
    expect(typeof RerankerCohereNode.supplyData).toBe('function');
  });

  it('every retriever outputs ai_retriever, in the Retrievers category', () => {
    for (const type of retrieverNodes) {
      const d = type.description;
      expect(outputTypes(type), d.name).toEqual(['ai_retriever']);
      expect(d.categories, d.name).toEqual(['AI', 'Retrievers']);
      expect(typeof type.supplyData, d.name).toBe('function');
    }
    expect(inputTypes(byName('ai.retrieverVectorStore'))).toEqual(['ai_vectorStore']);
    expect(inputTypes(byName('ai.retrieverContextualCompression'))).toEqual([
      'ai_languageModel',
      'ai_retriever',
    ]);
    expect(inputTypes(byName('ai.retrieverMultiQuery'))).toEqual(['ai_languageModel', 'ai_retriever']);
    expect(inputTypes(byName('ai.retrieverWorkflow'))).toEqual([]);
  });

  it('the Vector Store Retriever moved out of ragChainNodes into retrieverNodes', () => {
    expect(ragChainNodes.map((n) => n.description.name)).not.toContain('ai.retrieverVectorStore');
    expect(retrieverNodes).toContain(RetrieverVectorStoreNode);
    expect(RetrieverVectorStoreNode.description.name).toBe('ai.retrieverVectorStore');
  });
});
