/** Stub of MQTT Trigger: final name and description; L20 (P4-15) builds it. */
import type { NodeType } from '@workflow/workflow';

export const MqttTriggerNode: NodeType = {
  description: {
    name: 'app.mqttTrigger',
    displayName: 'MQTT Trigger',
    description: 'Subscribes to topics with per-topic QoS',
    icon: 'simple:mqtt',
    iconColor: '#660066',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'MQTT Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Developer tools', 'Communication', 'Triggers'],
    credentials: [{ name: 'mqtt', required: true }],
    properties: [],
  },

  async trigger() {
    throw new Error('Not built yet');
  },
};
