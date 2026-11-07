/**
 * Evaluation (P5-02, n8n "Evaluation"): Set Outputs (writes back to the dataset row), Set Inputs, Set
 * Metrics (custom, AI judged or computed scores) and Check If Evaluating (two outputs). A language model
 * input shows only for the AI judged metrics. `Item.evaluationData` is set only in mode `evaluation`: the
 * test runner reads the inputs, outputs and metrics of a case from it.
 */
import {
  type AiChatModel,
  type AssignmentCollectionValue,
  type DataObject,
  EVALUATION_NODE_TYPE,
  EVALUATION_TRIGGER_TYPE,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeOutput,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { errorItem, withItemIndex } from '../../utils/utilities';
import { DataTableNode } from './DataTable.node';
import {
  datasetSource,
  sheetLocators,
  tableLocator,
  writeSheetOutputs,
  writeTableOutputs,
} from './evaluation/dataset';
import {
  categorizationScore,
  customMetricScores,
  EvaluationError,
  judgeScore,
  METRIC_NAMES,
  stringSimilarityScore,
  toolsUsedScore,
} from './evaluation/metrics';

const MODEL_INPUT = "{ type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 }";

const onMetric = (...metrics: string[]) => ({ show: { operation: ['setMetrics'], metric: metrics } });
const forOutputs = { operation: ['setOutputs'] };

const NOT_FROM_TRIGGER = (what: string) =>
  `No ${what} were set since the execution didn't start from an evaluation trigger`;

const properties: NodeProperty[] = [
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
  // ---- inputs ----
  {
    displayName: 'Inputs',
    name: 'inputs',
    type: 'assignmentCollection',
    default: { assignments: [] },
    description: 'The inputs of this test case, kept with its result',
    displayOptions: { show: { operation: ['setInputs'] } },
  },
  // ---- outputs ----
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
    description: 'Where the dataset of the evaluation trigger is, to write the outputs into',
    displayOptions: { show: forOutputs },
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
    displayOptions: { show: { ...forOutputs, source: ['googleSheets'] } },
  },
  tableLocator({ ...forOutputs, source: ['dataTable'] }, 'The data table to write the outputs into'),
  ...sheetLocators({ ...forOutputs, source: ['googleSheets'] }),
  {
    displayName: 'Outputs',
    name: 'outputs',
    type: 'assignmentCollection',
    default: { assignments: [] },
    description: 'The outputs of this test case, written into its dataset row',
    displayOptions: { show: forOutputs },
  },
  // ---- metrics ----
  {
    displayName: 'Metrics to Return',
    name: 'metrics',
    type: 'assignmentCollection',
    default: { assignments: [] },
    description: 'Each value must be a number',
    displayOptions: onMetric('customMetrics'),
  },
  {
    displayName: 'Expected Answer',
    name: 'expectedAnswer',
    type: 'string',
    default: '',
    displayOptions: onMetric('correctness', 'stringSimilarity', 'categorization'),
  },
  {
    displayName: 'Actual Answer',
    name: 'actualAnswer',
    type: 'string',
    default: '',
    displayOptions: onMetric('correctness', 'stringSimilarity', 'categorization'),
  },
  {
    displayName: 'User Query',
    name: 'userQuery',
    type: 'string',
    default: '',
    description: 'The question or task the answer is for',
    displayOptions: onMetric('correctness', 'helpfulness'),
  },
  {
    displayName: 'Response',
    name: 'actualAnswer',
    type: 'string',
    default: '',
    displayOptions: onMetric('helpfulness'),
  },
  {
    displayName: 'Expected Tools',
    name: 'expectedTools',
    type: 'string',
    default: '',
    description: 'Names of the tools the agent should use, separated by commas',
    displayOptions: onMetric('toolsUsed'),
  },
  {
    displayName: 'Intermediate Steps',
    name: 'intermediateSteps',
    type: 'string',
    default: '={{ $json.intermediateSteps }}',
    description: 'The steps the agent took (turn on Return Intermediate Steps in the agent)',
    displayOptions: onMetric('toolsUsed'),
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    displayOptions: onMetric('correctness', 'helpfulness'),
    options: [
      {
        displayName: 'Metric Name',
        name: 'metricName',
        type: 'string',
        default: '',
        description: 'The name of the metric in the results',
      },
      {
        displayName: 'Prompt',
        name: 'inputPrompt',
        type: 'string',
        default: '',
        typeOptions: { rows: 6 },
        description:
          'Your own prompt for the judge. Put {actual_answer}, {expected_answer} and {user_query} where the values go',
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    displayOptions: onMetric('stringSimilarity', 'categorization', 'toolsUsed'),
    options: [
      {
        displayName: 'Metric Name',
        name: 'metricName',
        type: 'string',
        default: '',
        description: 'The name of the metric in the results',
      },
    ],
  },
];

/** a node name as a double quoted JS string with no braces, so it cannot end the expression it sits in */
function nameLiteral(name: string): string {
  return JSON.stringify(name).replace(/[{}]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`);
}

/**
 * The evaluation trigger this run came from: a parent trigger that has run in this execution (a run of mode
 * `evaluation` is always one: the runner pins the trigger's row). undefined when none.
 */
function runTrigger(ctx: ExecuteContext): string | undefined {
  const triggers = ctx.getParentNodes().filter((node) => node.type === EVALUATION_TRIGGER_TYPE);
  if (ctx.getMode() === 'evaluation') return triggers[0]?.name;
  return triggers.find(
    (node) => ctx.evaluateExpression(`={{ $(${nameLiteral(node.name)}).isExecuted }}`, 0) === true,
  )?.name;
}

/** a field of the trigger's row in this execution */
function triggerRowValue(ctx: ExecuteContext, trigger: string, field: 'row_id' | 'row_number'): unknown {
  try {
    return ctx.evaluateExpression(`={{ $(${nameLiteral(trigger)}).first().json.${field} }}`, 0);
  } catch {
    return undefined;
  }
}

/** the name and value pairs of an assignment list, the first item's values */
function assignedValues(ctx: ExecuteContext, parameter: string, empty: string): DataObject {
  const { assignments = [] } = ctx.getNodeParameter(parameter, 0, {}) as Partial<AssignmentCollectionValue>;
  const values: DataObject = {};
  for (const a of assignments) {
    const name = String(a.name ?? '').trim();
    if (name) values[name] = a.value as DataObject[string];
  }
  if (!Object.keys(values).length) {
    throw new NodeOperationError(ctx.getNode(), empty, { parameter });
  }
  return values;
}

/** the items with `evaluationData` on the first one, in mode `evaluation` only */
function withEvaluationData(ctx: ExecuteContext, items: Item[], operation: string, data: DataObject): Item[] {
  if (ctx.getMode() !== 'evaluation' || !items.length) return items;
  return [{ ...items[0], evaluationData: { operation, data } }, ...items.slice(1)];
}

function hint(ctx: ExecuteContext, message: string) {
  ctx.addExecutionHints({ message, level: 'info' });
}

async function writeOutputs(ctx: ExecuteContext, trigger: string, outputs: DataObject): Promise<void> {
  if (datasetSource(ctx) === 'dataTable') {
    const rowId = triggerRowValue(ctx, trigger, 'row_id');
    if (typeof rowId !== 'number' || !Number.isFinite(rowId)) {
      throw new NodeOperationError(ctx.getNode(), "The evaluation trigger's row has no row_id", {
        description: 'Set the source of the evaluation trigger to a data table',
      });
    }
    await writeTableOutputs(ctx, outputs, rowId);
    return;
  }
  const rowNumber = triggerRowValue(ctx, trigger, 'row_number');
  if (typeof rowNumber !== 'number' || !Number.isFinite(rowNumber) || rowNumber < 1) {
    throw new NodeOperationError(ctx.getNode(), "The evaluation trigger's row has no row_number", {
      description: 'Set the source of the evaluation trigger to Google Sheets',
    });
  }
  await writeSheetOutputs(ctx, outputs, rowNumber);
}

async function languageModel(ctx: ExecuteContext, i: number): Promise<AiChatModel | undefined> {
  const supplied = await ctx.getInputConnectionData('ai_languageModel', i);
  const model = Array.isArray(supplied) ? supplied[0] : supplied;
  return model ? (model as AiChatModel) : undefined;
}

/** the metrics of input item `i` */
async function itemMetrics(ctx: ExecuteContext, metric: string, i: number): Promise<Record<string, number>> {
  const param = (name: string) => ctx.getNodeParameter(name, i, undefined);
  const options = (ctx.getNodeParameter('options', i, {}) ?? {}) as DataObject;
  const named = (fallback: string) => {
    const wanted = typeof options.metricName === 'string' ? options.metricName.trim() : '';
    return wanted || fallback;
  };
  switch (metric) {
    case 'customMetrics': {
      const { assignments = [] } = ctx.getNodeParameter(
        'metrics',
        i,
        {},
      ) as Partial<AssignmentCollectionValue>;
      return customMetricScores(assignments);
    }
    case 'correctness':
    case 'helpfulness':
      return {
        [named(METRIC_NAMES[metric])]: await judgeScore({
          metric,
          model: await languageModel(ctx, i),
          actualAnswer: param('actualAnswer'),
          expectedAnswer: metric === 'correctness' ? param('expectedAnswer') : undefined,
          userQuery: param('userQuery'),
          inputPrompt: options.inputPrompt,
          signal: ctx.signal,
        }),
      };
    case 'stringSimilarity':
      return {
        [named(METRIC_NAMES.stringSimilarity)]: stringSimilarityScore(
          param('expectedAnswer'),
          param('actualAnswer'),
        ),
      };
    case 'categorization':
      return {
        [named(METRIC_NAMES.categorization)]: categorizationScore(
          param('expectedAnswer'),
          param('actualAnswer'),
        ),
      };
    case 'toolsUsed':
      return {
        [named(METRIC_NAMES.toolsUsed)]: toolsUsedScore(param('expectedTools'), param('intermediateSteps')),
      };
    default:
      throw new NodeOperationError(ctx.getNode(), `Unknown metric "${metric}"`, { parameter: 'metric' });
  }
}

async function setMetrics(ctx: ExecuteContext, items: Item[]): Promise<Item[]> {
  const metric = String(ctx.getNodeParameter('metric', 0, 'correctness'));
  const evaluating = ctx.getMode() === 'evaluation';
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const metrics = await itemMetrics(ctx, metric, i);
      out.push({
        json: metrics,
        pairedItem: { item: i },
        ...(evaluating ? { evaluationData: { operation: 'setMetrics', data: metrics } } : {}),
      });
    } catch (error) {
      if (!ctx.continueOnFail()) {
        if (error instanceof EvaluationError) {
          throw new NodeOperationError(ctx.getNode(), error.message, {
            itemIndex: i,
            description: error.description,
          });
        }
        throw withItemIndex(ctx, error, i);
      }
      out.push(errorItem(error, i));
    }
  }
  return out;
}

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
    credentials: [
      {
        name: 'googleApi',
        required: true,
        displayOptions: {
          show: { ...forOutputs, source: ['googleSheets'], authentication: ['serviceAccount'] },
        },
      },
      {
        name: 'googleSheetsOAuth2Api',
        required: true,
        displayOptions: { show: { ...forOutputs, source: ['googleSheets'], authentication: ['oAuth2'] } },
      },
    ],
    properties,
  },

  async execute(ctx: ExecuteContext): Promise<NodeOutput> {
    const operation = String(ctx.getNodeParameter('operation', 0, 'setOutputs'));
    const items = ctx.getInputData();
    switch (operation) {
      case 'checkIfEvaluating':
        return runTrigger(ctx) ? [items, []] : [[], items];
      case 'setInputs': {
        const inputs = assignedValues(ctx, 'inputs', 'No inputs to set');
        if (!runTrigger(ctx)) {
          hint(ctx, NOT_FROM_TRIGGER('inputs'));
          return [items];
        }
        return [withEvaluationData(ctx, items, 'setInputs', inputs)];
      }
      case 'setOutputs': {
        const outputs = assignedValues(ctx, 'outputs', 'No outputs to set');
        const trigger = runTrigger(ctx);
        if (!trigger) {
          hint(ctx, NOT_FROM_TRIGGER('outputs'));
          return [items];
        }
        await writeOutputs(ctx, trigger, outputs);
        return [withEvaluationData(ctx, items, 'setOutputs', outputs)];
      }
      case 'setMetrics':
        return [await setMetrics(ctx, items)];
      default:
        throw new NodeOperationError(ctx.getNode(), `Unknown operation "${operation}"`, {
          parameter: 'operation',
        });
    }
  },

  methods: {
    listSearch: { tableSearch: DataTableNode.methods!.listSearch!.tableSearch },
    loadOptions: { getColumns: DataTableNode.methods!.loadOptions!.getColumns },
  },
};
