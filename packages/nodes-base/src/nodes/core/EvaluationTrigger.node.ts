/**
 * Evaluation Trigger (P5-02, n8n "Evaluation Trigger"): reads the rows of a dataset (a Data table, or a
 * Google Sheet) one at a time when run from the editor, and all of them up to the limit when an evaluation
 * run forces `DATASET_GET_ROWS` (`RunOptions.forceOperation`). Stub from C0: lane L7 writes it.
 */
import { DATASET_GET_ROWS, EVALUATION_TRIGGER_TYPE, type NodeType } from '@workflow/workflow';

const onSheets = { source: ['googleSheets'] };

export const EvaluationTriggerNode: NodeType = {
  description: {
    name: EVALUATION_TRIGGER_TYPE,
    displayName: 'Evaluation Trigger',
    description: 'Runs the workflow once for each row of a dataset, to evaluate it',
    icon: 'lucide:flask-conical',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'When fetching a dataset row' },
    inputs: [],
    outputs: ['main'],
    categories: ['Core', 'Evaluation'],
    alias: ['evaluation', 'eval', 'test', 'dataset'],
    credentials: [
      {
        name: 'googleApi',
        required: true,
        displayOptions: { show: { ...onSheets, authentication: ['serviceAccount'] } },
      },
      {
        name: 'googleSheetsOAuth2Api',
        required: true,
        displayOptions: { show: { ...onSheets, authentication: ['oAuth2'] } },
      },
    ],
    properties: [
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        default: 'dataTable',
        noDataExpression: true,
        options: [
          { name: 'Data Table', value: 'dataTable' },
          { name: 'Google Sheets', value: 'googleSheets' },
        ],
      },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'oAuth2',
        options: [
          { name: 'Service Account', value: 'serviceAccount' },
          { name: 'OAuth2', value: 'oAuth2' },
        ],
        displayOptions: { show: onSheets },
      },
      {
        displayName: 'Limit Rows',
        name: 'limitRows',
        type: 'boolean',
        default: false,
        description: 'Whether to read only the first rows of the dataset',
      },
      {
        displayName: 'Max Rows to Process',
        name: 'maxRows',
        type: 'number',
        default: 10,
        typeOptions: { minValue: 1 },
        displayOptions: { show: { limitRows: [true] } },
      },
    ],
  },

  async execute() {
    throw new Error('not implemented (L7)');
  },

  customOperations: {
    [DATASET_GET_ROWS]: async () => {
      throw new Error('not implemented (L7)');
    },
  },
};
