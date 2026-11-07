/** Redis Vector Store (stub, filled by L14). */
import { createVectorStoreNode, DEFAULT_VECTOR_STORE_MODES } from './vector-store-factory';

export const VectorStoreRedisNode = createVectorStoreNode({
  name: 'ai.vectorStoreRedis',
  displayName: 'Redis Vector Store',
  description: 'Stores documents in a Redis vector index and searches them by similarity',
  icon: 'simple:redis',
  credentials: [{ name: 'redis', required: true }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'none',
  properties: [],
  async open() {
    throw new Error('not implemented (L14)');
  },
});
