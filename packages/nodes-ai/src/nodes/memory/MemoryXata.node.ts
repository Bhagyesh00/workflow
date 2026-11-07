/** Xata memory: chat history in a Xata table. Stub: L20 fills it. */
import type { NodeType } from '@workflow/workflow';
import { memoryDescription } from './memory-shared';

export const MemoryXataNode: NodeType = {
  description: memoryDescription(
    {
      name: 'ai.memoryXata',
      displayName: 'Xata',
      description: 'Stores chat history in a Xata database table',
      icon: 'simple:xata',
      credentials: [{ name: 'xataApi', required: true }],
    },
    [],
  ),
  async supplyData() {
    throw new Error('not implemented (L20)');
  },
};
