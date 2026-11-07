/** Chroma Vector Store (stub, filled by L15). */
import { createVectorStoreNode, DEFAULT_VECTOR_STORE_MODES } from './vector-store-factory';

export const VectorStoreChromaDBNode = createVectorStoreNode({
  name: 'ai.vectorStoreChromaDB',
  displayName: 'Chroma Vector Store',
  description: 'Stores documents in a Chroma collection, self-hosted or in Chroma Cloud',
  icon: 'simple:chroma',
  credentials: [
    {
      name: 'chromaSelfHostedApi',
      required: true,
      displayOptions: { show: { authentication: ['chromaSelfHostedApi'] } },
    },
    {
      name: 'chromaCloudApi',
      required: true,
      displayOptions: { show: { authentication: ['chromaCloudApi'] } },
    },
  ],
  modes: DEFAULT_VECTOR_STORE_MODES,
  filter: 'metadata',
  properties: [],
  async open() {
    throw new Error('not implemented (L15)');
  },
});
