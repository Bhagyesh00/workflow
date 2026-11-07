/** Pinecone Vector Store (stub, filled by L10). */
import { createVectorStoreNode, DEFAULT_VECTOR_STORE_MODES } from './vector-store-factory';

export const VectorStorePineconeNode = createVectorStoreNode({
  name: 'ai.vectorStorePinecone',
  displayName: 'Pinecone Vector Store',
  description: 'Stores documents in a Pinecone index and searches them by similarity',
  icon: 'simple:pinecone',
  credentials: [{ name: 'pineconeApi', required: true }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'metadata',
  properties: [],
  async open() {
    throw new Error('not implemented (L10)');
  },
});
