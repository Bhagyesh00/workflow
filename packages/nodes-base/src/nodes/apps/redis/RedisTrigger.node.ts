/** Stub of Redis Trigger: final name and description; L15 (P4-10) builds it. */
import type { NodeType } from '@workflow/workflow';

export const RedisTriggerNode: NodeType = {
  description: {
    name: 'app.redisTrigger',
    displayName: 'Redis Trigger',
    description: 'Starts a run on pub/sub messages',
    icon: 'simple:redis',
    iconColor: '#dc382d',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Redis Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Data & Storage', 'Triggers'],
    credentials: [{ name: 'redis', required: true }],
    properties: [],
  },

  async trigger() {
    throw new Error('Not built yet');
  },
};
