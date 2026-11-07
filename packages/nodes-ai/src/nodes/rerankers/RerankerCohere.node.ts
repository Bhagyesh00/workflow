/** Cohere reranker (stub, filled by L17): reorders documents by relevance to the query, keeps the Top N. */
import type { NodeType } from '@workflow/workflow';

export const RerankerCohereNode: NodeType = {
  description: {
    name: 'ai.rerankerCohere',
    displayName: 'Reranker Cohere',
    description: 'Reorders documents from a vector store by their relevance to the query',
    icon: 'simple:cohere',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Reranker Cohere' },
    inputs: [],
    outputs: ['ai_reranker'],
    outputNames: ['Reranker'],
    credentials: [{ name: 'cohereApi', required: true }],
    categories: ['AI', 'Rerankers'],
    alias: ['rerank', 'rag'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L17)');
  },
};
