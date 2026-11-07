/** Contextual Compression Retriever (stub, filled by L17): keeps only the parts of each document that answer the query. */
import type { NodeType } from '@workflow/workflow';

export const RetrieverContextualCompressionNode: NodeType = {
  description: {
    name: 'ai.retrieverContextualCompression',
    displayName: 'Contextual Compression Retriever',
    description: 'Keeps only the parts of each retrieved document that are relevant to the query',
    icon: 'lucide:minimize-2',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Contextual Compression Retriever' },
    inputs: [
      { type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 },
      { type: 'ai_retriever', displayName: 'Retriever', required: true, maxConnections: 1 },
    ],
    outputs: ['ai_retriever'],
    outputNames: ['Retriever'],
    categories: ['AI', 'Retrievers'],
    alias: ['rag', 'search'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L17)');
  },
};
