/** Stub of Kafka Trigger: final name and description; L18 (P4-13) builds it. */
import type { NodeType } from '@workflow/workflow';

export const KafkaTriggerNode: NodeType = {
  description: {
    name: 'app.kafkaTrigger',
    displayName: 'Kafka Trigger',
    description: 'Consumes a topic with a group',
    icon: 'simple:apachekafka',
    iconColor: '#231f20',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Kafka Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Developer tools', 'Triggers'],
    credentials: [{ name: 'kafka', required: true }],
    properties: [],
  },

  async trigger() {
    throw new Error('Not built yet');
  },
};
