/** Stub of SSE Trigger: final name and description; L16 (P4-11) builds it. */
import type { NodeType } from '@workflow/workflow';

export const SseTriggerNode: NodeType = {
  description: {
    name: 'core.sseTrigger',
    displayName: 'SSE Trigger',
    description: 'Starts a run on each server-sent event from a URL',
    icon: 'lucide:radio',
    iconColor: '#225577',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'SSE Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Core', 'Triggers'],
    properties: [],
  },

  async trigger() {
    throw new Error('Not built yet');
  },
};
