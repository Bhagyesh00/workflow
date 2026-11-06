/** Stub of RSS Feed Trigger: final name and description; L16 (P4-29) builds it. */
import type { NodeType } from '@workflow/workflow';

export const RssFeedReadTriggerNode: NodeType = {
  description: {
    name: 'core.rssFeedReadTrigger',
    displayName: 'RSS Feed Trigger',
    description: 'Starts a run for each new item of a feed',
    icon: 'lucide:rss',
    iconColor: '#f26522',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'RSS Feed Trigger' },
    inputs: [],
    outputs: ['main'],
    polling: true,
    categories: ['Core', 'Triggers'],
    properties: [],
  },

  async poll() {
    throw new Error('Not built yet');
  },
};
