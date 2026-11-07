/** Supabase Vector Store (stub, filled by L10). */
import { createVectorStoreNode, DEFAULT_VECTOR_STORE_MODES } from './vector-store-factory';

export const VectorStoreSupabaseNode = createVectorStoreNode({
  name: 'ai.vectorStoreSupabase',
  displayName: 'Supabase Vector Store',
  description: 'Stores documents in a Supabase table with pgvector and searches them by similarity',
  icon: 'simple:supabase',
  credentials: [{ name: 'supabaseApi', required: true }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'metadata',
  properties: [],
  async open() {
    throw new Error('not implemented (L10)');
  },
});
