/** Embeddings Google Vertex sub-node. Stub: L14 fills it. */
import type { NodeType } from '@workflow/workflow';

export const EmbeddingsGoogleVertexNode: NodeType = {
  description: {
    name: 'ai.embeddingsGoogleVertex',
    displayName: 'Embeddings Google Vertex',
    description: 'Turns text into vectors with embedding models on Google Cloud Vertex AI',
    icon: 'simple:googlecloud',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Google Vertex' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [
      { name: 'googleApi', required: true, displayOptions: { show: { authentication: ['googleApi'] } } },
      {
        name: 'googleVertexAiApi',
        required: true,
        displayOptions: { show: { authentication: ['googleVertexAiApi'] } },
      },
    ],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'vertex', 'google'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L14)');
  },
};
