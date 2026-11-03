/**
 * Flow control: Loop Over Items, Wait, Execute Workflow (+ its trigger), Error Trigger and
 * Stop and Error.
 */
import {
  type DataObject,
  deepCopy,
  type ExecuteContext,
  type ExecuteWorkflowSource,
  type Item,
  isPlainObject,
  type ListSearchResult,
  NodeOperationError,
  type NodeType,
  type PairedItem,
  type SourceData,
  sleep,
  type WebhookContext,
  type WebhookResponseData,
  type WorkflowDefinition,
} from '@workflow/workflow';
import { DateTime } from 'luxon';
import { parseDate } from '../../utils/filter';
import { errorItem, parseJsonParameter, withItemIndex } from '../../utils/utilities';
import { convertFieldValue, pairToInput } from './simple.nodes';

// ---------------------------------------------------------------------------------------------
// Loop Over Items
// ---------------------------------------------------------------------------------------------

interface LoopState extends DataObject {
  remaining?: Array<{ json: DataObject; binary?: Item['binary']; index: number }>;
  processed?: Array<{
    json: DataObject;
    binary?: Item['binary'];
    index: number;
    source: SourceData | null;
    /** run of the loop node that received the item */
    run: number;
  }>;
  /** where the first run's input came from: every item in `remaining` is an item of that input */
  source?: SourceData | null;
}

/**
 * The engine resolves `pairedItem` against the inputs of the *current* run, but a loop emits items
 * of an earlier run's input (later batches, and the done items collected over all runs), so each
 * item names the input it belongs to. An item of an earlier run whose input had no source (the loop
 * started the execution) points at an input the node does not have, so expressions that follow it
 * fail instead of resolving against the loop-back input.
 */
function loopPairedItem(
  item: number,
  source: SourceData | null | undefined,
  earlierRun: boolean,
): PairedItem {
  if (source) return { item, sourceOverwrite: source };
  return earlierRun ? { item, input: 1 } : { item };
}

export const SplitInBatchesNode: NodeType = {
  description: {
    name: 'core.splitInBatches',
    displayName: 'Loop Over Items (Split in Batches)',
    description: 'Process items in batches: loop through the "loop" branch until all are done',
    icon: 'lucide:repeat',
    iconColor: '#007755',
    group: ['organization'],
    version: 1,
    defaults: { name: 'Loop Over Items' },
    inputs: ['main'],
    outputs: [
      { type: 'main', displayName: 'done' },
      { type: 'main', displayName: 'loop' },
    ],
    outputNames: ['done', 'loop'],
    categories: ['Core', 'Flow'],
    alias: ['loop', 'batch', 'split', 'iterate', 'for each', 'repeat', 'chunk'],
    properties: [
      {
        displayName:
          'Connect the end of the loop back to this node. Inside the loop, read the current item with $("Loop Over Items").item.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Batch Size',
        name: 'batchSize',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 1 },
        description: 'Number of items sent through the loop branch per round',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Reset',
            name: 'reset',
            type: 'boolean',
            default: false,
            description:
              'Whether to treat incoming items as a new set instead of loop results (for example when paging an API until it returns nothing)',
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const state = ctx.getContext('node') as LoopState;
    const items = ctx.getInputData();
    const batchSize = Math.max(1, Math.floor(Number(ctx.getNodeParameter('batchSize', 0, 1)) || 1));
    const reset = ctx.getNodeParameter('options.reset', 0, false) as boolean;

    const run = ctx.getRunIndex();
    let remaining = reset ? undefined : state.remaining;
    const fresh = !remaining;
    if (!remaining) {
      remaining = items.map((item, index) => ({ json: item.json, binary: item.binary, index }));
      state.remaining = remaining;
      state.processed = [];
      state.source = deepCopy(ctx.getInputSourceData());
    } else {
      const source = deepCopy(ctx.getInputSourceData());
      state.processed!.push(
        ...items.map((item, index) => ({ json: item.json, binary: item.binary, index, source, run })),
      );
    }
    const batch = remaining.splice(0, batchSize);

    if (!batch.length) {
      const done = (state.processed ?? []).map(
        (p): Item => ({
          json: p.json,
          ...(p.binary ? { binary: p.binary } : {}),
          pairedItem: loopPairedItem(p.index, p.source, p.run !== run),
        }),
      );
      // forget the finished loop so the node starts fresh when an outer loop runs it again
      for (const key of Object.keys(state)) delete state[key];
      return [done, []];
    }
    return [
      [],
      batch.map((b) => ({
        json: b.json,
        ...(b.binary ? { binary: b.binary } : {}),
        pairedItem: loopPairedItem(b.index, state.source, !fresh),
      })),
    ];
  },
};

// ---------------------------------------------------------------------------------------------
// Wait
// ---------------------------------------------------------------------------------------------

/** waits up to this long run in-process; longer ones persist the execution and resume later */
export const IN_PROCESS_WAIT_LIMIT_MS = 65_000;
/** "wait forever" for webhook resumes without a time limit */
const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z');

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

function intervalMs(ctx: ExecuteContext, amountParam: string, unitParam: string): number {
  const amount = Number(ctx.getNodeParameter(amountParam, 0, 1));
  const unit = ctx.getNodeParameter(unitParam, 0, 'seconds') as string;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new NodeOperationError(ctx.getNode(), 'The wait amount must be a positive number', {
      parameter: amountParam,
    });
  }
  return amount * (UNIT_MS[unit] ?? 1000);
}

function waitDate(ctx: ExecuteContext, param: string): Date {
  const value = ctx.getNodeParameter(param, 0, '');
  const date = parseDate(value, true, ctx.getTimezone());
  if (!date?.isValid) {
    throw new NodeOperationError(ctx.getNode(), `"${String(value)}" is not a valid date`, {
      parameter: param,
    });
  }
  return date.toJSDate();
}

const timeUnitOptions = [
  { name: 'Seconds', value: 'seconds' },
  { name: 'Minutes', value: 'minutes' },
  { name: 'Hours', value: 'hours' },
  { name: 'Days', value: 'days' },
];

export const WaitNode: NodeType = {
  description: {
    name: 'core.wait',
    displayName: 'Wait',
    description: 'Pause the workflow for a time, until a date, or until a webhook call resumes it',
    icon: 'lucide:hourglass',
    iconColor: '#804050',
    group: ['organization'],
    version: 1,
    defaults: { name: 'Wait' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Flow'],
    alias: ['pause', 'sleep', 'delay', 'timeout', 'resume', 'approval'],
    webhooks: [
      {
        name: 'default',
        httpMethod: '={{ $parameter.httpMethod || "POST" }}',
        path: '={{ ($parameter.options ?? {}).webhookSuffix || "" }}',
        responseMode: 'onReceived',
        restartWebhook: true,
        isFullPath: true,
      },
    ],
    properties: [
      {
        displayName: 'Resume',
        name: 'resume',
        type: 'options',
        default: 'timeInterval',
        noDataExpression: true,
        options: [
          {
            name: 'After Time Interval',
            value: 'timeInterval',
            description: 'Waits for a set amount of time',
          },
          { name: 'At Specified Time', value: 'specificTime', description: 'Waits until a date and time' },
          {
            name: 'On Webhook Call',
            value: 'webhook',
            description: 'Waits until $execution.resumeUrl is called',
          },
        ],
      },
      {
        displayName: 'Wait Amount',
        name: 'amount',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0, numberPrecision: 2 },
        displayOptions: { show: { resume: ['timeInterval'] } },
      },
      {
        displayName: 'Wait Unit',
        name: 'unit',
        type: 'options',
        default: 'hours',
        options: timeUnitOptions,
        displayOptions: { show: { resume: ['timeInterval'] } },
      },
      {
        displayName: 'Date and Time',
        name: 'dateTime',
        type: 'dateTime',
        default: '',
        required: true,
        description: 'Uses the workflow timezone when the date has no offset',
        displayOptions: { show: { resume: ['specificTime'] } },
      },
      {
        displayName:
          'The execution continues when {{ $execution.resumeUrl }} is called. Send that URL to the system that should resume the workflow.',
        name: 'webhookNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { resume: ['webhook'] } },
      },
      {
        displayName: 'HTTP Method',
        name: 'httpMethod',
        type: 'options',
        default: 'POST',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m })),
        displayOptions: { show: { resume: ['webhook'] } },
      },
      {
        displayName: 'Limit Wait Time',
        name: 'limitWaitTime',
        type: 'boolean',
        default: false,
        description: 'Whether the workflow resumes automatically after a time limit without a webhook call',
        displayOptions: { show: { resume: ['webhook'] } },
      },
      {
        displayName: 'Limit Type',
        name: 'limitType',
        type: 'options',
        default: 'afterTimeInterval',
        displayOptions: { show: { resume: ['webhook'], limitWaitTime: [true] } },
        options: [
          { name: 'After Time Interval', value: 'afterTimeInterval' },
          { name: 'At Specified Time', value: 'atSpecifiedTime' },
        ],
      },
      {
        displayName: 'Amount',
        name: 'resumeAmount',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0, numberPrecision: 2 },
        displayOptions: {
          show: { resume: ['webhook'], limitWaitTime: [true], limitType: ['afterTimeInterval'] },
        },
      },
      {
        displayName: 'Unit',
        name: 'resumeUnit',
        type: 'options',
        default: 'hours',
        options: timeUnitOptions,
        displayOptions: {
          show: { resume: ['webhook'], limitWaitTime: [true], limitType: ['afterTimeInterval'] },
        },
      },
      {
        displayName: 'Max Date and Time',
        name: 'maxDateAndTime',
        type: 'dateTime',
        default: '',
        displayOptions: {
          show: { resume: ['webhook'], limitWaitTime: [true], limitType: ['atSpecifiedTime'] },
        },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { resume: ['webhook'] } },
        options: [
          {
            displayName: 'Webhook Suffix',
            name: 'webhookSuffix',
            type: 'string',
            default: '',
            placeholder: 'approve',
            description: 'Appended to the resume URL, so one execution can wait for different calls',
          },
          { displayName: 'Ignore Bots', name: 'ignoreBots', type: 'boolean', default: false },
          {
            displayName: 'Binary Property Prefix',
            name: 'binaryPropertyName',
            type: 'string',
            default: 'data',
            description: 'Prefix for uploaded files (data0, data1, ...)',
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const resume = ctx.getNodeParameter('resume', 0) as string;
    let until: Date;
    if (resume === 'timeInterval') {
      until = new Date(Date.now() + intervalMs(ctx, 'amount', 'unit'));
    } else if (resume === 'specificTime') {
      until = waitDate(ctx, 'dateTime');
    } else {
      const limit = ctx.getNodeParameter('limitWaitTime', 0, false) as boolean;
      if (!limit) until = WAIT_INDEFINITELY;
      else if (ctx.getNodeParameter('limitType', 0, 'afterTimeInterval') === 'atSpecifiedTime') {
        until = waitDate(ctx, 'maxDateAndTime');
      } else {
        until = new Date(Date.now() + intervalMs(ctx, 'resumeAmount', 'resumeUnit'));
      }
      // webhook resumes always persist the execution, however short the limit
      await ctx.putExecutionToWait(until);
      return [pairToInput(items)];
    }

    const ms = until.getTime() - Date.now();
    if (ms <= IN_PROCESS_WAIT_LIMIT_MS) {
      if (ms > 0) await sleep(ms, ctx.signal);
    } else {
      await ctx.putExecutionToWait(until);
    }
    return [pairToInput(items)];
  },

  async webhook(ctx: WebhookContext): Promise<WebhookResponseData> {
    // a time-based wait has a resume URL too, but only the time may end it
    if (ctx.getNodeParameter('resume', 0) !== 'webhook') {
      return {
        webhookResponse: {
          statusCode: 404,
          body: { message: 'This execution is not waiting for a webhook call' },
        },
      };
    }
    const req = ctx.getRequestObject();
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const userAgent = String(ctx.getHeaderData()['user-agent'] ?? '');
    if (options.ignoreBots && /bot|crawler|spider|preview/i.test(userAgent)) {
      return { webhookResponse: { statusCode: 403, body: { message: 'Bots are ignored' } } };
    }
    const item: Item = {
      json: {
        headers: req.headers as DataObject,
        params: req.params,
        query: req.query,
        body: (req.body ?? {}) as DataObject,
      },
      pairedItem: { item: 0 },
    };
    if (req.files?.length) {
      const prefix = String(options.binaryPropertyName ?? 'data');
      item.binary = {};
      for (const [i, file] of req.files.entries()) {
        item.binary[req.files.length === 1 ? prefix : `${prefix}${i}`] = await ctx.helpers.prepareBinaryData(
          file.data,
          file.fileName,
          file.mimeType,
        );
      }
    }
    return { workflowData: [[item]] };
  },
};

// ---------------------------------------------------------------------------------------------
// Execute Workflow / Execute Workflow Trigger
// ---------------------------------------------------------------------------------------------

function subWorkflowSource(ctx: ExecuteContext, itemIndex: number): ExecuteWorkflowSource {
  const source = ctx.getNodeParameter('source', itemIndex, 'database') as string;
  if (source === 'parameter') {
    const parsed = parseJsonParameter(
      ctx,
      ctx.getNodeParameter('workflowJson', itemIndex, ''),
      'Workflow JSON',
      itemIndex,
    );
    if (
      !isPlainObject(parsed) ||
      !Array.isArray(parsed.nodes) ||
      (parsed.connections !== undefined && !isPlainObject(parsed.connections))
    ) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Workflow JSON must be an object with "nodes" and "connections"',
        {
          itemIndex,
          parameter: 'workflowJson',
        },
      );
    }
    const workflow = { name: 'Inline sub-workflow', connections: {}, ...parsed } as WorkflowDefinition;
    return { source: 'parameter', workflow };
  }
  const workflowId = String(
    ctx.getNodeParameter('workflowId', itemIndex, '', { extractValue: true }) ?? '',
  ).trim();
  if (!workflowId) {
    throw new NodeOperationError(ctx.getNode(), 'Select the workflow to call', {
      itemIndex,
      parameter: 'workflowId',
    });
  }
  return { source: 'database', workflowId };
}

function forSubWorkflow(item: Item): Item {
  return { json: item.json, ...(item.binary ? { binary: item.binary } : {}) };
}

/**
 * The item sent to the called workflow (P3-05, as n8n's workflowInputs): the item's fields plus the
 * "Workflow Inputs" values evaluated for this item. No inputs: the item as it is.
 */
function withWorkflowInputs(ctx: ExecuteContext, item: Item, itemIndex: number): Item {
  const base = forSubWorkflow(item);
  const values = ctx.getNodeParameter('workflowInputs.values', itemIndex, []) as unknown;
  if (!Array.isArray(values) || values.length === 0) return base;
  const json: DataObject = { ...base.json };
  let mapped = false;
  for (const entry of values as Array<{ name?: unknown; value?: unknown }>) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    json[name] = entry.value === undefined ? null : (deepCopy(entry.value) as DataObject[string]);
    mapped = true;
  }
  return mapped ? { ...base, json } : base;
}

export const ExecuteWorkflowNode: NodeType = {
  description: {
    name: 'core.executeWorkflow',
    displayName: 'Execute Workflow',
    description: 'Call another workflow and use its output',
    icon: 'lucide:workflow',
    iconColor: '#ff6d5a',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Execute Workflow' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Flow'],
    alias: ['sub-workflow', 'subworkflow', 'call', 'run workflow', 'function', 'reuse'],
    subtitle:
      '={{ $parameter.source === "parameter" ? "inline workflow" : "workflow " + ($parameter.workflowId?.value ?? "") }}',
    properties: [
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        default: 'database',
        noDataExpression: true,
        options: [
          { name: 'Workflow From This Workspace', value: 'database', description: 'Pick a saved workflow' },
          { name: 'Workflow JSON', value: 'parameter', description: 'Paste the workflow definition' },
        ],
      },
      {
        displayName: 'Workflow',
        name: 'workflowId',
        type: 'resourceLocator',
        default: { __rl: true, mode: 'list', value: '' },
        required: true,
        displayOptions: { show: { source: ['database'] } },
        modes: [
          {
            displayName: 'From List',
            name: 'list',
            type: 'list',
            placeholder: 'Select a workflow...',
            typeOptions: { searchListMethod: 'searchWorkflows', searchable: true },
          },
          { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'Workflow ID' },
          {
            displayName: 'By URL',
            name: 'url',
            type: 'string',
            placeholder: 'https://app.example.com/workflow/abc123',
            extractValue: { type: 'regex', regex: '/workflows?/([0-9a-zA-Z_-]+)' },
          },
        ],
      },
      {
        displayName: 'Workflow JSON',
        name: 'workflowJson',
        type: 'json',
        default: '{\n  "nodes": [],\n  "connections": {}\n}',
        typeOptions: { rows: 10 },
        displayOptions: { show: { source: ['parameter'] } },
      },
      {
        displayName: 'Workflow Inputs',
        name: 'workflowInputs',
        type: 'fixedCollection',
        default: { values: [] },
        placeholder: 'Add input',
        description:
          'Fields to send to the called workflow, evaluated per item and added to its fields. A "When Executed by Another Workflow" trigger with typed inputs keeps only the fields it declares.',
        typeOptions: { multipleValues: true, sortable: true },
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '', placeholder: 'customerId' },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'once',
        noDataExpression: true,
        options: [
          { name: 'Run Once with All Items', value: 'once', description: 'Pass all items in one call' },
          { name: 'Run Once for Each Item', value: 'each', description: 'Call the workflow per item' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Wait for Sub-Workflow Completion',
            name: 'waitForSubWorkflow',
            type: 'boolean',
            default: true,
            description:
              'Whether to wait for the called workflow and output its result. When off, the input items are passed through right away.',
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const mode = ctx.getNodeParameter('mode', 0, 'once') as string;
    const wait = ctx.getNodeParameter('options.waitForSubWorkflow', 0, true) !== false;

    if (mode === 'once') {
      try {
        const sent = items.map((item, i) => withWorkflowInputs(ctx, item, i));
        const result = await ctx.executeWorkflow(subWorkflowSource(ctx, 0), sent, {
          doNotWaitToFinish: !wait,
        });
        if (!wait) return [items.map((item, i) => ({ ...item, pairedItem: { item: i } }))];
        const output = result.data?.[0] ?? [];
        const allInputs = items.map((_, i) => ({ item: i }));
        return [
          output.map((item, i) => ({
            ...forSubWorkflow(item),
            pairedItem:
              output.length === items.length
                ? { item: i }
                : allInputs.length === 1
                  ? allInputs[0]
                  : allInputs,
          })),
        ];
      } catch (error) {
        if (ctx.continueOnFail()) return [[errorItem(error, 0)]];
        throw error;
      }
    }

    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const result = await ctx.executeWorkflow(
          subWorkflowSource(ctx, i),
          [withWorkflowInputs(ctx, items[i], i)],
          {
            doNotWaitToFinish: !wait,
          },
        );
        if (!wait) {
          out.push({ ...items[i], pairedItem: { item: i } });
          continue;
        }
        for (const item of result.data?.[0] ?? [])
          out.push({ ...forSubWorkflow(item), pairedItem: { item: i } });
      } catch (error) {
        if (!ctx.continueOnFail()) throw withItemIndex(ctx, error, i);
        out.push(errorItem(error, i));
      }
    }
    return [out];
  },

  methods: {
    listSearch: {
      async searchWorkflows(ctx, filter, paginationToken): Promise<ListSearchResult> {
        if (!ctx.listWorkflows)
          throw new NodeOperationError(ctx.getNode(), 'This host cannot list workflows');
        const page = await ctx.listWorkflows({
          filter: filter?.trim() || undefined,
          paginationToken,
          excludeId: ctx.getWorkflow().id,
        });
        const base = ctx.getInstanceBaseUrl().replace(/\/+$/, '');
        return {
          results: page.workflows.map((w) => ({
            name: w.name,
            value: w.id,
            url: `${base}/workflow/${w.id}`,
          })),
          paginationToken: page.paginationToken,
        };
      },
    },
  },
};

type InputFieldType = 'any' | 'string' | 'number' | 'boolean' | 'array' | 'object';

export const ExecuteWorkflowTriggerNode: NodeType = {
  description: {
    name: 'core.executeWorkflowTrigger',
    displayName: 'When Executed by Another Workflow',
    description: 'Start this workflow when another workflow calls it with Execute Workflow',
    icon: 'lucide:log-in',
    iconColor: '#ff6d5a',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'When Executed by Another Workflow' },
    inputs: [],
    outputs: ['main'],
    maxNodes: 1,
    categories: ['Core', 'Triggers'],
    alias: ['sub-workflow', 'subworkflow', 'called', 'execute workflow trigger', 'function input'],
    properties: [
      {
        displayName: 'Input Data Mode',
        name: 'inputSource',
        type: 'options',
        default: 'passthrough',
        noDataExpression: true,
        options: [
          {
            name: 'Accept All Data',
            value: 'passthrough',
            description: 'Use the items the caller sends as they are',
          },
          {
            name: 'Define Using Fields Below',
            value: 'workflowInputs',
            description: 'Declare typed input fields; other fields are dropped',
          },
        ],
      },
      {
        displayName: 'Workflow Input Schema',
        name: 'workflowInputs',
        type: 'fixedCollection',
        default: { values: [] },
        placeholder: 'Add field',
        typeOptions: { multipleValues: true, sortable: true },
        displayOptions: { show: { inputSource: ['workflowInputs'] } },
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '', placeholder: 'customerId' },
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                default: 'string',
                options: [
                  { name: 'Allow Any Type', value: 'any' },
                  { name: 'String', value: 'string' },
                  { name: 'Number', value: 'number' },
                  { name: 'Boolean', value: 'boolean' },
                  { name: 'Array', value: 'array' },
                  { name: 'Object', value: 'object' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const inputSource = ctx.getNodeParameter('inputSource', 0, 'passthrough') as string;
    if (inputSource !== 'workflowInputs') return [items.length ? items : [{ json: {} }]];
    const fields = ((ctx.getNodeParameter('workflowInputs', 0, {}) as DataObject).values ?? []) as Array<{
      name: string;
      type: InputFieldType;
    }>;
    const source = items.length ? items : [{ json: {} }];
    const out: Item[] = [];
    for (let i = 0; i < source.length; i++) {
      try {
        const json: DataObject = {};
        for (const field of fields) {
          if (!field.name) continue;
          const value = source[i].json[field.name];
          json[field.name] =
            value === undefined
              ? null
              : field.type === 'any'
                ? deepCopy(value)
                : convertFieldValue(deepCopy(value), field.type, field.name, ctx, i, false);
        }
        out.push({
          json,
          ...(source[i].binary ? { binary: source[i].binary } : {}),
          pairedItem: { item: i },
        });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        out.push(errorItem(error, i));
      }
    }
    return [out];
  },
};

// ---------------------------------------------------------------------------------------------
// Error Trigger / Stop and Error
// ---------------------------------------------------------------------------------------------

export const ErrorTriggerNode: NodeType = {
  description: {
    name: 'core.errorTrigger',
    displayName: 'Error Trigger',
    description: 'Start this workflow when another workflow that uses it as error workflow fails',
    icon: 'lucide:triangle-alert',
    iconColor: '#ff3d3d',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Error Trigger' },
    inputs: [],
    outputs: ['main'],
    maxNodes: 1,
    categories: ['Core', 'Triggers'],
    alias: ['failure', 'exception', 'alert', 'on error'],
    properties: [
      {
        displayName:
          'Select this workflow as "Error workflow" in the settings of the workflows to watch. When one of them fails, this workflow receives the error.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const hasData = items.some((item) => Object.keys(item.json).length > 0);
    if (hasData) return [items.map((item, i) => ({ ...item, pairedItem: { item: i } }))];
    // manual test run: emit an example so the rest of the workflow can be built
    const now = DateTime.now().toISO();
    return [
      [
        {
          json: {
            execution: {
              id: 'example-execution-id',
              url: `${ctx.getInstanceBaseUrl()}/executions/example-execution-id`,
              retryOf: null,
              error: { name: 'NodeOperationError', message: 'Example error message', timestamp: now },
              lastNodeExecuted: 'Node With Error',
              mode: 'manual',
            },
            workflow: { id: 'example-workflow-id', name: 'Example Workflow' },
          },
          pairedItem: { item: 0 },
        },
      ],
    ];
  },
};

export const StopAndErrorNode: NodeType = {
  description: {
    name: 'core.stopAndError',
    displayName: 'Stop and Error',
    description: 'Stop the workflow with an error (runs the error workflow when one is set)',
    icon: 'lucide:octagon-x',
    iconColor: '#ff3d3d',
    group: ['organization'],
    version: 1,
    defaults: { name: 'Stop and Error' },
    inputs: ['main'],
    outputs: [],
    categories: ['Core', 'Flow'],
    alias: ['throw', 'fail', 'exception', 'abort', 'raise'],
    properties: [
      {
        displayName: 'Error Type',
        name: 'errorType',
        type: 'options',
        default: 'errorMessage',
        options: [
          { name: 'Error Message', value: 'errorMessage' },
          { name: 'Error Object', value: 'errorObject', description: 'JSON with message, description, ...' },
        ],
      },
      {
        displayName: 'Error Message',
        name: 'errorMessage',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { errorType: ['errorMessage'] } },
      },
      {
        displayName: 'Error Object',
        name: 'errorObject',
        type: 'json',
        default:
          '{\n  "code": "404",\n  "message": "Customer not found",\n  "description": "No customer matches the email address"\n}',
        typeOptions: { rows: 6 },
        displayOptions: { show: { errorType: ['errorObject'] } },
      },
    ],
  },
  async execute(ctx) {
    const errorType = ctx.getNodeParameter('errorType', 0, 'errorMessage') as string;
    if (errorType === 'errorObject') {
      const parsed = parseJsonParameter(ctx, ctx.getNodeParameter('errorObject', 0, '{}'), 'Error Object', 0);
      const obj = isPlainObject(parsed) ? parsed : { message: String(parsed) };
      const message = String(
        obj.message ?? obj.error ?? obj.description ?? 'Workflow stopped by Stop and Error',
      );
      const error = new NodeOperationError(ctx.getNode(), message, {
        description: typeof obj.description === 'string' ? obj.description : undefined,
        code:
          typeof obj.code === 'string' || typeof obj.code === 'number'
            ? `USER_${String(obj.code)}`
            : 'USER_ERROR',
      });
      error.context.errorObject = obj;
      throw error;
    }
    const message = String(
      ctx.getNodeParameter('errorMessage', 0, '') || 'Workflow stopped by Stop and Error',
    );
    throw new NodeOperationError(ctx.getNode(), message, { code: 'USER_ERROR' });
  },
};
