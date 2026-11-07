/** Chat Memory Manager: reads, inserts or deletes the messages of a connected memory. Stub: L19 fills it. */
import type { NodeType } from '@workflow/workflow';

export const MemoryManagerNode: NodeType = {
  description: {
    name: 'ai.memoryManager',
    displayName: 'Chat Memory Manager',
    description: 'Loads, inserts or deletes the messages of a chat memory',
    icon: 'lucide:database',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Chat Memory Manager' },
    inputs: ['main', { type: 'ai_memory', displayName: 'Memory', required: true, maxConnections: 1 }],
    outputs: ['main'],
    categories: ['AI', 'Memory'],
    alias: ['chat history', 'conversation', 'memory'],
    properties: [],
  },
  async execute() {
    throw new Error('not implemented (L19)');
  },
};
