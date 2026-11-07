/**
 * AI Agent Tool: an agent with its own model, memory and tools that another agent calls as a tool.
 *
 * It has no main input. The engine turns a node with `execute` and an `ai_tool` output into a tool
 * (`createNodeAsTool`): each call runs `executeAgent` with the model's arguments as the one input item, so
 * `text` is read with `$fromAI` and the sub-agent answers in `output`.
 */
import type { NodeProperty, NodeType } from '@workflow/workflow';
import { agentProperties, executeAgent, modelPort } from './Agent.node';

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
    description:
      'Tells the calling model what this agent does; a specific description gets the agent called at the right time',
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

/** the Agent's parameters, except its own prompt source; this node has one version, so the parser switch always shows */
const SHARED = agentProperties
  .filter(({ name }) => !['promptType', 'text'].includes(name))
  .map((property) =>
    property.name === 'hasOutputParser' ? { ...property, displayOptions: undefined } : property,
  );

/** the Agent's inputs without `main`; the fallback model is the second chat-model port, as on the Agent */
const AGENT_TOOL_INPUTS = `={{ [${JSON.stringify(modelPort('Chat Model'))}, ...($parameter.needsFallback === true ? [${JSON.stringify(modelPort('Fallback Model'))}] : []), { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }, { type: 'ai_tool', displayName: 'Tool' }, ...($parameter.hasOutputParser !== false ? [{ type: 'ai_outputParser', displayName: 'Output Parser', maxConnections: 1 }] : [])] }}`;

export const AgentToolNode: NodeType = {
  description: {
    name: 'ai.agentTool',
    displayName: 'AI Agent Tool',
    description: 'An agent with its own model and tools that another agent calls as a tool',
    icon: 'lucide:bot',
    group: ['transform'],
    version: 1,
    defaults: { name: 'AI Agent Tool' },
    inputs: AGENT_TOOL_INPUTS,
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    categories: ['AI', 'Tools'],
    alias: ['sub-agent', 'subagent', 'agent as tool', 'multi agent'],
    properties: [...PROMPT_PROPERTIES, ...SHARED],
  },
  execute: executeAgent,
};
