/** Weaviate Vector Store (stub, filled by L11). */
import { createVectorStoreNode, DEFAULT_VECTOR_STORE_MODES } from './vector-store-factory';

export const VectorStoreWeaviateNode = createVectorStoreNode({
  name: 'ai.vectorStoreWeaviate',
  displayName: 'Weaviate Vector Store',
  description: 'Stores documents in a Weaviate collection and searches them by similarity',
  icon: 'simple:weaviate',
  credentials: [{ name: 'weaviateApi', required: true }],
  modes: DEFAULT_VECTOR_STORE_MODES,
  filter: 'json',
  properties: [],
  async open() {
    throw new Error('not implemented (L11)');
  },
});
