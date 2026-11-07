/**
 * Databricks AI Agent: the AI Agent with a trace of every run exported to a Databricks MLflow experiment.
 * Export is off by default, because a trace holds prompts and tool results. Not usable as a tool, as n8n's
 * node. The node has one version, so (as the AI Agent Tool) the output parser switch always shows and the
 * parser port follows it, where n8n's Agent keeps the switch from its second version on.
 */
import { NodeOperationError, type NodeProperty, type NodeType } from '@workflow/workflow';
import { agentInputs, agentProperties, executeAgent } from '../../agent/Agent.node';
import { createMlflowObserver, readExperiment } from './mlflow';

const CREDENTIAL = 'databricksOAuth2Api';

const SHARED = agentProperties.map((property) =>
  property.name === 'hasOutputParser' ? { ...property, displayOptions: undefined } : property,
);

const exportProperties: NodeProperty[] = [
  {
    displayName: 'Export Traces to MLflow',
    name: 'exportTraces',
    type: 'boolean',
    default: false,
    noDataExpression: true,
    description:
      'Whether to send a trace of every item to a Databricks MLflow experiment. A trace holds the prompt, the answer and the tool results.',
  },
  {
    displayName: 'Experiment',
    name: 'experiment',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'name', value: '' },
    description:
      'The MLflow experiment that receives the traces. A blank name uses one named after the workflow; a name that does not exist yet is created.',
    displayOptions: { show: { exportTraces: [true] } },
    modes: [
      { displayName: 'By Name', name: 'name', type: 'string', placeholder: '/Shared/my-agent-traces' },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: '1234567890123456' },
    ],
  },
];

export const DatabricksAiAgentNode: NodeType = {
  description: {
    name: 'ai.databricksAiAgent',
    displayName: 'Databricks AI Agent',
    description: 'An AI Agent that can export a trace of every run to a Databricks MLflow experiment',
    icon: 'simple:databricks',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Databricks AI Agent' },
    inputs: agentInputs,
    outputs: ['main'],
    credentials: [{ name: CREDENTIAL, required: false }],
    categories: ['AI', 'Vendors'],
    alias: ['mlflow', 'agent', 'tracing'],
    properties: [...SHARED, ...exportProperties],
  },

  async execute(ctx) {
    if (ctx.getNodeParameter('exportTraces', 0, false) !== true) return executeAgent(ctx);
    if (!ctx.getNode().credentials?.[CREDENTIAL]) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Select a Databricks credential to export traces to MLflow',
      );
    }
    const credentials = await ctx.getCredentials<{ host?: string }>(CREDENTIAL, 0);
    const experiment = readExperiment(ctx.getNodeParameter('experiment', 0, ''), ctx.getWorkflow().id);
    return executeAgent(ctx, createMlflowObserver(ctx, String(credentials.host ?? ''), experiment));
  },
};
