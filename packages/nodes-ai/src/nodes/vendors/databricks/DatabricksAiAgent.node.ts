/**
 * Databricks AI Agent: the AI Agent with traces exported to MLflow. Stub with the final name, the Agent's
 * inputs and properties and the optional credential; L8 fills it (Export Traces, Experiment, and
 * `execute` as `executeAgent(ctx, observer)`). Not usable as a tool, as n8n's node.
 */
import type { NodeType } from '@workflow/workflow';
import { agentInputs, agentProperties } from '../../agent/Agent.node';

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
    credentials: [{ name: 'databricksOAuth2Api', required: false }],
    categories: ['AI', 'Vendors'],
    alias: ['mlflow', 'agent', 'tracing'],
    properties: agentProperties,
  },

  async execute() {
    throw new Error('not implemented (L8)');
  },
};
