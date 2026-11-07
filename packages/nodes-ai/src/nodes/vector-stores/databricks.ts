/** Databricks Vector Store (stub, filled by L16). */
import { createVectorStoreNode, DEFAULT_VECTOR_STORE_MODES } from './vector-store-factory';

export const VectorStoreDatabricksNode = createVectorStoreNode({
  name: 'ai.vectorStoreDatabricks',
  displayName: 'Databricks Vector Store',
  description: 'Stores documents in a Databricks Vector Search index and searches them by similarity',
  icon: 'simple:databricks',
  credentials: [{ name: 'databricksOAuth2Api', required: true }],
  modes: DEFAULT_VECTOR_STORE_MODES,
  filter: 'json',
  properties: [],
  async open() {
    throw new Error('not implemented (L16)');
  },
});
