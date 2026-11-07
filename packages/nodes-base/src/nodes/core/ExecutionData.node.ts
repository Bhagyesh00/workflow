/**
 * Execution Data (P5-61, n8n "Execution Data"): saves key and value pairs of each item as the execution's
 * highlighted data (`ctx.setCustomData`, the engine's caps), so executions can be filtered by them, and
 * passes its input through. Stub from C0: lane L6 writes it.
 */
import type { NodeType } from '@workflow/workflow';

export const ExecutionDataNode: NodeType = {
  description: {
    name: 'core.executionData',
    displayName: 'Execution Data',
    description: 'Saves data on the execution so you can filter executions by it',
    icon: 'lucide:highlighter',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Execution Data' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['highlighted data', 'custom data', 'execution data', 'save data', 'tag'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'save',
        noDataExpression: true,
        options: [{ name: 'Save Highlighted Data', value: 'save', action: 'Save highlighted data' }],
      },
    ],
  },

  async execute() {
    throw new Error('not implemented (L6)');
  },
};
