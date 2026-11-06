/** Stub of Redis: final name and description; L15 (P4-24) builds it. */
import type { NodeType } from '@workflow/workflow';

export const RedisNode: NodeType = {
  description: {
    name: 'app.redis',
    displayName: 'Redis',
    description: 'Delete, get, increment, info, keys, list length, pop, publish, push and set in Redis',
    icon: 'simple:redis',
    iconColor: '#dc382d',
    group: ['input'],
    version: 1,
    defaults: { name: 'Redis' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Data & Storage', 'Developer tools'],
    alias: ['redis', 'cache', 'key value', 'pubsub', 'list'],
    credentials: [{ name: 'redis', required: true }],
    properties: [],
  },

  async execute() {
    throw new Error('Not built yet');
  },
};
