/** Wikipedia tool: looks up Wikipedia articles. Stub: L25 fills it. */
import type { NodeType } from '@workflow/workflow';

export const ToolWikipediaNode: NodeType = {
  description: {
    name: 'ai.toolWikipedia',
    displayName: 'Wikipedia',
    description: 'Looks up Wikipedia articles',
    icon: 'simple:wikipedia',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Wikipedia' },
    inputs: [],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    categories: ['AI', 'Tools'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L25)');
  },
};
