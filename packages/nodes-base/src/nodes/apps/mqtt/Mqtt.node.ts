/** Stub of MQTT: final name and description; L20 (P4-27) builds it. */
import type { NodeType } from '@workflow/workflow';

export const MqttNode: NodeType = {
  description: {
    name: 'app.mqtt',
    displayName: 'MQTT',
    description: 'Publishes messages to an MQTT topic',
    icon: 'simple:mqtt',
    iconColor: '#660066',
    group: ['input'],
    version: 1,
    defaults: { name: 'MQTT' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Developer tools', 'Communication'],
    alias: ['mqtt', 'iot', 'publish', 'message', 'broker'],
    credentials: [{ name: 'mqtt', required: true }],
    properties: [],
  },

  async execute() {
    throw new Error('Not built yet');
  },
};
