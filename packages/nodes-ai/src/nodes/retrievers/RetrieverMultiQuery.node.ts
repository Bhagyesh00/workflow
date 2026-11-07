/** MultiQuery Retriever (stub, filled by L17): the model rewrites the query several ways, results are merged. */
import type { NodeType } from '@workflow/workflow';

export const RetrieverMultiQueryNode: NodeType = {
  description: {
    name: 'ai.retrieverMultiQuery',
    displayName: 'MultiQuery Retriever',
    description: 'Asks the model for several versions of the query and merges the documents found',
    icon: 'lucide:list-tree',
    group: ['transform'],
    version: 1,
    defaults: { name: 'MultiQuery Retriever' },
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
