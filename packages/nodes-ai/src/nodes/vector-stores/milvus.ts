/** Milvus Vector Store (stub, filled by L16). */
import { createVectorStoreNode, DEFAULT_VECTOR_STORE_MODES } from './vector-store-factory';

export const VectorStoreMilvusNode = createVectorStoreNode({
  name: 'ai.vectorStoreMilvus',
  displayName: 'Milvus Vector Store',
  description: 'Stores documents in a Milvus collection and searches them by similarity',
  icon: 'simple:milvus',
  credentials: [{ name: 'milvusApi', required: true }],
  modes: DEFAULT_VECTOR_STORE_MODES,
  filter: 'none',
  properties: [],
  async open() {
    throw new Error('not implemented (L16)');
  },
});
