/** SearXNG tool: web search through a SearXNG instance. Stub: L25 fills it. */
import type { NodeType } from '@workflow/workflow';

export const ToolSearXngNode: NodeType = {
  description: {
    name: 'ai.toolSearXng',
    displayName: 'SearXNG',
    description: 'Searches the web through a SearXNG instance',
    icon: 'simple:searxng',
    group: ['transform'],
    version: 1,
    defaults: { name: 'SearXNG' },
    inputs: [],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    categories: ['AI', 'Tools'],
    credentials: [{ name: 'searXngApi', required: true }],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L25)');
  },
};
