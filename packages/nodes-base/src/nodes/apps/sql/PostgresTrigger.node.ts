/** Stub of Postgres Trigger: final name and description; L14 (P4-09) builds it. */
import type { NodeType } from '@workflow/workflow';

export const PostgresTriggerNode: NodeType = {
  description: {
    name: 'app.postgresTrigger',
    displayName: 'Postgres Trigger',
    description: 'Starts a run on table row events or a LISTEN/NOTIFY channel',
    icon: 'simple:postgresql',
    iconColor: '#336791',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Postgres Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Data & Storage', 'Triggers'],
    credentials: [{ name: 'postgres', required: true }],
    properties: [],
  },

  async trigger() {
    throw new Error('Not built yet');
  },
};
