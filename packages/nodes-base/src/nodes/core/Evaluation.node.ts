/**
 * Evaluation (P5-02, n8n "Evaluation"): Set Outputs (writes back to the dataset row), Set Inputs, Set
 * Metrics (custom, AI judged or computed scores) and Check If Evaluating (two outputs). A language model
 * input shows only for the AI judged metrics. Stub from C0: lane L7 writes it.
 */
import { EVALUATION_NODE_TYPE, type NodeType } from '@workflow/workflow';

const MODEL_INPUT = "{ type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 }";

export const EvaluationNode: NodeType = {
  description: {
    name: EVALUATION_NODE_TYPE,
    displayName: 'Evaluation',
    description: 'Sets the inputs, outputs and metrics of an evaluation run',
    icon: 'lucide:clipboard-check',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Evaluation' },
    inputs: `={{ ['main', ...($parameter.operation === 'setMetrics' && ($parameter.metric === 'correctness' || $parameter.metric === 'helpfulness') ? [${MODEL_INPUT}] : [])] }}`,
    outputs: `={{ $parameter.operation === 'checkIfEvaluating' ? [{ type: 'main', displayName: 'Evaluation' }, { type: 'main', displayName: 'Normal' }] : ['main'] }}`,
    categories: ['Core', 'Evaluation'],
    alias: ['evaluation', 'eval', 'metric', 'score', 'test'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'setOutputs',
        noDataExpression: true,
        options: [
          { name: 'Set Outputs', value: 'setOutputs', action: 'Set outputs' },
          { name: 'Set Inputs', value: 'setInputs', action: 'Set inputs' },
          { name: 'Set Metrics', value: 'setMetrics', action: 'Set metrics' },
          { name: 'Check If Evaluating', value: 'checkIfEvaluating', action: 'Check if evaluating' },
        ],
      },
      {
        displayName: 'Metric',
        name: 'metric',
        type: 'options',
        default: 'correctness',
        noDataExpression: true,
        options: [
          { name: 'Correctness (AI-Based)', value: 'correctness' },
          { name: 'Helpfulness (AI-Based)', value: 'helpfulness' },
          { name: 'String Similarity', value: 'stringSimilarity' },
          { name: 'Categorization', value: 'categorization' },
          { name: 'Tools Used', value: 'toolsUsed' },
          { name: 'Custom Metrics', value: 'customMetrics' },
        ],
        displayOptions: { show: { operation: ['setMetrics'] } },
      },
    ],
  },

  async execute() {
    throw new Error('not implemented (L7)');
  },
};
