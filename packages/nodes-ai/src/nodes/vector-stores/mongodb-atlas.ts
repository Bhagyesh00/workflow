/** MongoDB Atlas Vector Store (stub, filled by L13). */
import { mongoDbConnectionTest } from '../../shared/mongo';
import { createVectorStoreNode, DEFAULT_VECTOR_STORE_MODES } from './vector-store-factory';

export const VectorStoreMongoDBAtlasNode = createVectorStoreNode({
  name: 'ai.vectorStoreMongoDBAtlas',
  displayName: 'MongoDB Atlas Vector Store',
  description: 'Stores documents in a MongoDB Atlas collection and searches them with $vectorSearch',
  icon: 'simple:mongodb',
  credentials: [{ name: 'mongoDb', required: true, testedBy: 'mongoDbConnectionTest' }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'metadata',
  methods: { credentialTest: { mongoDbConnectionTest } },
  properties: [],
  async open() {
    throw new Error('not implemented (L13)');
  },
});
