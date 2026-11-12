/** Vector Store Retriever: a connected vector store as a retriever for chains (moved from rag-chains.nodes.ts). */
import type { AiRetriever, NodeType } from '@workflow/workflow';
import { logAiEvent } from '../../shared/ai-events';
import { getVectorStore } from '../../shared/ai-inputs';

export const RetrieverVectorStoreNode: NodeType = {
  description: {
    name: 'ai.retrieverVectorStore',
    displayName: 'Vector Store Retriever',
    description: 'Uses a vector store as a retriever for chains',
    icon: 'lucide:search',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Vector Store Retriever' },
    inputs: [{ type: 'ai_vectorStore', displayName: 'Vector Store', required: true, maxConnections: 1 }],
    outputs: ['ai_retriever'],
    outputNames: ['Retriever'],
    categories: ['AI', 'Retrievers'],
    alias: ['rag', 'search'],
    properties: [
      {
        displayName: 'Limit',
        name: 'topK',
        type: 'number',
        default: 4,
        typeOptions: { minValue: 1, maxValue: 100 },
        description: 'Number of documents to retrieve',
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const store = (await getVectorStore(ctx, itemIndex))!;
    const topK = Number(ctx.getNodeParameter('topK', itemIndex, 4));
    const retriever: AiRetriever = {
      kind: 'retriever',
      async retrieve(query) {
        const documents = (await store.similaritySearch(query, topK)).map((r) => r.document);
        ctx.logSubNodeRun({ query }, { documents });
        logAiEvent(ctx, 'ai.retriever.get.relevant.documents', { query });
        return documents;
      },
    };
    return { response: retriever };
  },
};
