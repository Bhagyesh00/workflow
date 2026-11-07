/** Embeddings Mistral Cloud sub-node. Stub: L15 fills it. */
import type { NodeType } from '@workflow/workflow';

export const EmbeddingsMistralCloudNode: NodeType = {
  description: {
    name: 'ai.embeddingsMistralCloud',
    displayName: 'Embeddings Mistral Cloud',
    description: 'Turns text into vectors with Mistral embedding models',
    icon: 'simple:mistralai',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Mistral Cloud' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [{ name: 'mistralCloudApi', required: true }],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'mistral'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L15)');
  },
};
