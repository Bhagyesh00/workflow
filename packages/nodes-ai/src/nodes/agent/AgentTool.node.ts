/**
 * AI Agent Tool: an agent with its own model, memory and tools that another agent calls as a tool.
 *
 * It has no main input. The engine turns a node with `execute` and an `ai_tool` output into a tool
 * (`createNodeAsTool`): each call runs `executeAgent` with the model's arguments as the one input item, so
 * `text` is read with `$fromAI` and the sub-agent answers in `output`.
 */
import type { NodeProperty, NodeType } from '@workflow/workflow';
import { COMPLETION_MODEL_NODES } from '../../shared/ai-inputs';
import { agentProperties, executeAgent } from './Agent.node';

const TOOL_DESCRIPTION = 'AI Agent that can call other tools';

/** the prompt is always the `text` parameter, so `promptType` is fixed and hidden */
const PROMPT_PROPERTIES: NodeProperty[] = [
  { displayName: 'Prompt Source', name: 'promptType', type: 'hidden', default: 'define' },
  {
    displayName: 'Description',
    name: 'toolDescription',
    type: 'string',
    default: TOOL_DESCRIPTION,
    required: true,
    typeOptions: { rows: 2 },
    description: 'Tells the calling model what this agent does; a specific description gets the agent called at the right time',
  },
  {
    displayName: 'Prompt (User Message)',
    name: 'text',
    type: 'string',
    default: "={{ $fromAI('input', 'The prompt to send to the agent') }}",
    required: true,
    typeOptions: { rows: 2 },
    description: 'The message the agent answers; by default the model fills it in',
  },
];

/** the Agent's parameters, except what a tool cannot have: its own prompt source and the port-changing switches */
const SHARED = agentProperties.filter(
  ({ name }) => !['promptType', 'text', 'hasOutputParser', 'needsFallback'].includes(name),
);

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
    properties: [...PROMPT_PROPERTIES, ...SHARED],
  },
  execute: executeAgent,
};
