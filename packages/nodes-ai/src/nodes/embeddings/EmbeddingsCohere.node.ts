/** Embeddings Cohere sub-node. Stub: L16 fills it. */
import type { NodeType } from '@workflow/workflow';

export const EmbeddingsCohereNode: NodeType = {
  description: {
    name: 'ai.embeddingsCohere',
    displayName: 'Embeddings Cohere',
    description: 'Turns text into vectors with Cohere embedding models',
    icon: 'simple:cohere',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Cohere' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [{ name: 'cohereApi', required: true }],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'cohere'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L16)');
  },
};
