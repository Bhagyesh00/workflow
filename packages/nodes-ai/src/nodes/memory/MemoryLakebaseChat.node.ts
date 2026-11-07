/** Lakebase Chat Memory: chat history in a Databricks Lakebase table. Stub: L20 fills it. */
import type { NodeType } from '@workflow/workflow';
import { memoryDescription } from './memory-shared';

export const MemoryLakebaseChatNode: NodeType = {
  description: memoryDescription(
    {
      name: 'ai.memoryLakebaseChat',
      displayName: 'Lakebase Chat Memory',
      description: 'Stores chat history in a Databricks Lakebase table',
      icon: 'simple:databricks',
      credentials: [{ name: 'databricksOAuth2Api', required: true }],
    },
    [],
  ),
  async supplyData() {
    throw new Error('not implemented (L20)');
  },
};
