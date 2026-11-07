/**
 * Evaluation Trigger (P5-02, n8n "Evaluation Trigger"): reads the rows of a dataset (a Data table, or a
 * Google Sheet) one at a time when run from the editor, and all of them up to the limit when an evaluation
 * run forces `DATASET_GET_ROWS` (`RunOptions.forceOperation`). Each row is an item with `row_number` (the
 * place in the dataset, the sheet row for a sheet) and, for a table, `row_id`; the Evaluation node writes
 * its outputs back by them.
 */
import {
  DATASET_GET_ROWS,
  type DataObject,
  EVALUATION_TRIGGER_TYPE,
  type ExecuteContext,
  MAX_EVALUATION_ROWS,
  NodeOperationError,
  type NodeOutput,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { DataTableNode } from './DataTable.node';
import { buildFilter } from './data-table/filters';
import {
  type DatasetRow,
  datasetSource,
  sheetDataset,
  sheetLocators,
  tableDataset,
  tableLocator,
} from './evaluation/dataset';

const onSheets = { source: ['googleSheets'] };
const onTable = { source: ['dataTable'] };

const CONDITIONS = [
  { name: 'Equals', value: 'eq' },
  { name: 'Not Equal', value: 'neq' },
  { name: 'Contains (Case-Sensitive)', value: 'like' },
  { name: 'Contains (Case-Insensitive)', value: 'ilike' },
  { name: 'Greater Than', value: 'gt' },
  { name: 'Greater Than or Equal', value: 'gte' },
  { name: 'Less Than', value: 'lt' },
  { name: 'Less Than or Equal', value: 'lte' },
  { name: 'Is Empty', value: 'isEmpty' },
  { name: 'Is Not Empty', value: 'isNotEmpty' },
  { name: 'Is True', value: 'isTrue' },
  { name: 'Is False', value: 'isFalse' },
];

const properties: NodeProperty[] = [
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
  tableLocator(onTable, 'The data table that holds the test cases'),
  ...sheetLocators(onSheets),
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
    typeOptions: { minValue: 1, maxValue: MAX_EVALUATION_ROWS },
    displayOptions: { show: { limitRows: [true] } },
  },
  {
    displayName: 'Filter Rows',
    name: 'filterRows',
    type: 'boolean',
    default: false,
    description: 'Whether to read only the rows that match the conditions',
  },
  {
    displayName: 'Match Type',
    name: 'matchType',
    type: 'options',
    default: 'anyCondition',
    options: [
      { name: 'Any Condition', value: 'anyCondition' },
      { name: 'All Conditions', value: 'allConditions' },
    ],
    displayOptions: { show: { ...onTable, filterRows: [true] } },
  },
  {
    displayName: 'Conditions',
    name: 'filters',
    type: 'fixedCollection',
    default: {},
    placeholder: 'Add condition',
    typeOptions: { multipleValues: true },
    displayOptions: { show: { ...onTable, filterRows: [true] } },
    options: [
      {
        displayName: 'Condition',
        name: 'conditions',
        values: [
          {
            displayName: 'Column',
            name: 'keyName',
            type: 'options',
            default: '',
            typeOptions: { loadOptionsMethod: 'getColumns', loadOptionsDependsOn: ['dataTableId.value'] },
          },
          {
            displayName: 'Condition',
            name: 'condition',
            type: 'options',
            default: 'eq',
            options: CONDITIONS,
          },
          {
            displayName: 'Value',
            name: 'keyValue',
            type: 'string',
            default: '',
            description: 'Not used by Is Empty, Is Not Empty, Is True and Is False',
          },
        ],
      },
    ],
  },
  {
    displayName: 'Filters',
    name: 'filtersUI',
    type: 'fixedCollection',
    default: { values: [] },
    placeholder: 'Add filter',
    typeOptions: { multipleValues: true },
    displayOptions: { show: { ...onSheets, filterRows: [true] } },
    options: [
      {
        displayName: 'Filter',
        name: 'values',
        values: [
          { displayName: 'Column', name: 'lookupColumn', type: 'string', default: '' },
          { displayName: 'Value', name: 'lookupValue', type: 'string', default: '' },
        ],
      },
    ],
  },
  {
    displayName: 'Combine Filters',
    name: 'combineFilters',
    type: 'options',
    default: 'AND',
    options: [
      { name: 'AND', value: 'AND', description: 'Rows matching every filter' },
      { name: 'OR', value: 'OR', description: 'Rows matching any filter' },
    ],
    displayOptions: { show: { ...onSheets, filterRows: [true] } },
  },
];

/** the rows of the dataset, in order, with the filter and the limit applied */
async function loadRows(ctx: ExecuteContext): Promise<DatasetRow[]> {
  return datasetSource(ctx) === 'dataTable'
    ? tableDataset(ctx, (table) => buildFilter(ctx, table, 0, false))
    : sheetDataset(ctx);
}

/** the place of the row the previous run gave, from the first input item (none on a first run) */
function previousKey(ctx: ExecuteContext): number | undefined {
  const json: DataObject = ctx.getInputData()[0]?.json ?? {};
  const raw = datasetSource(ctx) === 'dataTable' ? json.row_id : json.row_number;
  const key = typeof raw === 'number' ? raw : Number(raw);
  return raw === undefined || raw === null || raw === '' || !Number.isFinite(key) ? undefined : key;
}

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
    properties,
  },

  /** the first row after the one the previous run gave (the first row on a first run) */
  async execute(ctx: ExecuteContext): Promise<NodeOutput> {
    const rows = await loadRows(ctx);
    const previous = previousKey(ctx);
    const at = rows.findIndex((row) => previous === undefined || row.key > previous);
    if (at < 0) throw new NodeOperationError(ctx.getNode(), 'No row found');
    return [[{ json: { ...rows[at].json, _rowsLeft: rows.length - at - 1 } }]];
  },

  /** every row up to the limit, for the test runner */
  customOperations: {
    [DATASET_GET_ROWS]: async (ctx: ExecuteContext): Promise<NodeOutput> => {
      const rows = await loadRows(ctx);
      return [rows.map((row) => ({ json: row.json }))];
    },
  },

  methods: {
    listSearch: { tableSearch: DataTableNode.methods!.listSearch!.tableSearch },
    loadOptions: { getColumns: DataTableNode.methods!.loadOptions!.getColumns },
  },
};
