/** AI Agent Tool: an agent that other agents call as a tool. Stub: L5 fills it. */
import type { NodeType } from '@workflow/workflow';
import { COMPLETION_MODEL_NODES } from '../../shared/ai-inputs';

export const AgentToolNode: NodeType = {
  description: {
    name: 'ai.agentTool',
    displayName: 'AI Agent Tool',
    description: 'An agent with its own model and tools that another agent calls as a tool',
    icon: 'lucide:bot',
    group: ['transform'],
    version: 1,
    defaults: { name: 'AI Agent Tool' },
    inputs: [
      {
        type: 'ai_languageModel',
        displayName: 'Chat Model',
        required: true,
        maxConnections: 1,
        filter: { excludedNodes: COMPLETION_MODEL_NODES },
      },
      { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tool' },
      { type: 'ai_outputParser', displayName: 'Output Parser', maxConnections: 1 },
    ],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    categories: ['AI', 'Tools'],
    alias: ['sub-agent', 'subagent', 'agent as tool', 'multi agent'],
    properties: [],
  },
  async execute() {
    throw new Error('not implemented (L5)');
  },
};
