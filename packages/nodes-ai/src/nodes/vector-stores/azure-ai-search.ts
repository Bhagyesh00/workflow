/** Azure AI Search Vector Store (stub, filled by L15). */
import { createVectorStoreNode, DEFAULT_VECTOR_STORE_MODES } from './vector-store-factory';

export const VectorStoreAzureAISearchNode = createVectorStoreNode({
  name: 'ai.vectorStoreAzureAISearch',
  displayName: 'Azure AI Search Vector Store',
  description: 'Stores documents in an Azure AI Search index with vector, hybrid or semantic search',
  icon: 'simple:microsoftazure',
  credentials: [{ name: 'azureAiSearchApi', required: true }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'none',
  properties: [],
  async open() {
    throw new Error('not implemented (L15)');
  },
});
