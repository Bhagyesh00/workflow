/** MongoDB Chat Memory: chat history in a MongoDB collection. Stub: L12 fills it. */
import type { NodeType } from '@workflow/workflow';
import { mongoDbConnectionTest } from '../../shared/mongo';
import { memoryDescription } from './memory-shared';

export const MemoryMongoDbChatNode: NodeType = {
  description: memoryDescription(
    {
      name: 'ai.memoryMongoDbChat',
      displayName: 'MongoDB Chat Memory',
      description: 'Stores chat history in a MongoDB collection',
      icon: 'simple:mongodb',
      credentials: [{ name: 'mongoDb', required: true, testedBy: 'mongoDbConnectionTest' }],
    },
    [],
  ),
  methods: { credentialTest: { mongoDbConnectionTest } },
  async supplyData() {
    throw new Error('not implemented (L12)');
  },
};
