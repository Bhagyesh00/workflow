/** Phase 5 S2 contract step, C0a: reranker port, memory loadAll and replace, hideFromUI, sub-node parent lookup. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type AiChatMessage,
  type AiDocument,
  type AiMemory,
  type AiReranker,
  type ConnectedNode,
  type ConnectionType,
  ConnectionTypes,
  type NodeTypeLookup,
  type SupplyDataContext,
  Workflow,
  type WorkflowDefinition,
} from '../src';

const noTypes: NodeTypeLookup = { get: () => undefined };

function rerankerWorkflow(disabled = false): Workflow {
  const definition: WorkflowDefinition = {
    name: 'p5s2 reranker',
    nodes: [
      { id: 'n1', name: 'Trigger', type: 'test.trigger', typeVersion: 1, parameters: {}, position: [0, 0] },
      {
        id: 'n2',
        name: 'Vector Store',
        type: 'test.vectorStore',
        typeVersion: 1,
        parameters: {},
        position: [200, 0],
      },
      {
        id: 'n3',
        name: 'Reranker',
        type: 'test.reranker',
        typeVersion: 1,
        parameters: {},
        position: [200, 200],
        disabled,
      },
    ],
    connections: {
      Trigger: { main: [[{ node: 'Vector Store', type: 'main', index: 0 }]] },
      Reranker: { ai_reranker: [[{ node: 'Vector Store', type: 'ai_reranker', index: 0 }]] },
    },
  };
  return new Workflow(definition, noTypes);
}

describe('ConnectionTypes.AiReranker', () => {
  it('is ai_reranker and is listed in Object.values (the editor ports derive from it)', () => {
    expect(ConnectionTypes.AiReranker).toBe('ai_reranker');
    expect(Object.values(ConnectionTypes)).toContain('ai_reranker');
    expectTypeOf<'ai_reranker'>().toMatchTypeOf<ConnectionType>();
  });

  it('keeps every earlier connection type', () => {
    expect(Object.values(ConnectionTypes)).toEqual(
      expect.arrayContaining([
        'main',
        'ai_languageModel',
        'ai_tool',
        'ai_memory',
        'ai_outputParser',
        'ai_embedding',
        'ai_vectorStore',
        'ai_document',
        'ai_textSplitter',
        'ai_retriever',
      ]),
    );
    expect(new Set(Object.values(ConnectionTypes)).size).toBe(Object.values(ConnectionTypes).length);
  });
});

describe('ai_reranker sub-node port round-trips through the connection maps', () => {
  it('is inverted into connectionsByDestination', () => {
    const wf = rerankerWorkflow();
    expect(wf.connectionsBySource.Reranker?.ai_reranker).toEqual([
      [{ node: 'Vector Store', type: 'ai_reranker', index: 0 }],
    ]);
    expect(wf.connectionsByDestination['Vector Store']?.ai_reranker).toEqual([
      [{ node: 'Reranker', type: 'ai_reranker', index: 0 }],
    ]);
  });

  it('is found by getSubNodes, getSubNodesBySlot and the typed parent and child walks', () => {
    const wf = rerankerWorkflow();
    expect(wf.getSubNodes('Vector Store', ConnectionTypes.AiReranker).map((n) => n.name)).toEqual([
      'Reranker',
    ]);
    expect(
      wf.getSubNodesBySlot('Vector Store', ConnectionTypes.AiReranker).map((slot) => slot.map((n) => n.name)),
    ).toEqual([['Reranker']]);
    expect(wf.getParentNodes('Vector Store', ConnectionTypes.AiReranker)).toEqual(['Reranker']);
    expect(wf.getChildNodes('Reranker', ConnectionTypes.AiReranker)).toEqual(['Vector Store']);
  });

  it('stays out of the main graph', () => {
    const wf = rerankerWorkflow();
    expect(wf.getParentNodes('Vector Store')).toEqual(['Trigger']);
    expect(wf.getMainInputs('Vector Store')).toEqual([[{ node: 'Trigger', type: 'main', index: 0 }]]);
    expect(wf.getSubNodes('Vector Store', ConnectionTypes.AiRetriever)).toEqual([]);
  });

  it('drops a disabled reranker from getSubNodes', () => {
    expect(rerankerWorkflow(true).getSubNodes('Vector Store', ConnectionTypes.AiReranker)).toEqual([]);
  });
});

describe('AI contracts', () => {
  it('AiChatMessage carries an optional hideFromUI', () => {
    expectTypeOf<AiChatMessage['hideFromUI']>().toEqualTypeOf<boolean | undefined>();
    const hidden: AiChatMessage = { role: 'user', content: 'hi', hideFromUI: true };
    const plain: AiChatMessage = { role: 'assistant', content: 'hello' };
    expect(hidden.hideFromUI).toBe(true);
    expect('hideFromUI' in plain).toBe(false);
  });

  it('AiMemory has loadAll and replace next to load, append and clear', async () => {
    expectTypeOf<AiMemory['loadAll']>().toEqualTypeOf<(sessionId: string) => Promise<AiChatMessage[]>>();
    expectTypeOf<AiMemory['replace']>().toEqualTypeOf<
      (sessionId: string, messages: AiChatMessage[]) => Promise<void>
    >();
    expectTypeOf<AiMemory['load']>().toEqualTypeOf<(sessionId: string) => Promise<AiChatMessage[]>>();

    // a window-2 memory: load is windowed, loadAll never is, replace rewrites the whole history
    const store = new Map<string, AiChatMessage[]>();
    const memory: AiMemory = {
      kind: 'memory',
      load: async (id) => (store.get(id) ?? []).slice(-2),
      loadAll: async (id) => [...(store.get(id) ?? [])],
      append: async (id, messages) => {
        store.set(id, [...(store.get(id) ?? []), ...messages]);
      },
      replace: async (id, messages) => {
        store.set(id, [...messages]);
      },
      clear: async (id) => {
        store.delete(id);
      },
    };
    const msgs: AiChatMessage[] = ['a', 'b', 'c'].map((content) => ({ role: 'user', content }));
    await memory.append('s', msgs);
    expect((await memory.load('s')).map((m) => m.content)).toEqual(['b', 'c']);
    expect((await memory.loadAll('s')).map((m) => m.content)).toEqual(['a', 'b', 'c']);
    await memory.replace('s', [{ role: 'user', content: 'x', hideFromUI: true }]);
    expect(await memory.loadAll('s')).toEqual([{ role: 'user', content: 'x', hideFromUI: true }]);
  });

  it('AiReranker returns scored documents', async () => {
    expectTypeOf<AiReranker['kind']>().toEqualTypeOf<'reranker'>();
    expectTypeOf<AiReranker['rerank']>().toEqualTypeOf<
      (
        query: string,
        documents: AiDocument[],
        options?: { signal?: AbortSignal },
      ) => Promise<Array<{ document: AiDocument; score: number }>>
    >();
    const reranker: AiReranker = {
      kind: 'reranker',
      rerank: async (query, documents) =>
        documents
          .map((document) => ({ document, score: document.pageContent.includes(query) ? 1 : 0 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 1),
    };
    const docs: AiDocument[] = [
      { pageContent: 'cats', metadata: {} },
      { pageContent: 'dogs', metadata: { id: 2 } },
    ];
    expect(await reranker.rerank('dog', docs)).toEqual([{ document: docs[1], score: 1 }]);
  });

  it('SupplyDataContext has getParentNodes returning ConnectedNode[]', () => {
    expectTypeOf<SupplyDataContext['getParentNodes']>().toEqualTypeOf<() => ConnectedNode[]>();
  });
});
