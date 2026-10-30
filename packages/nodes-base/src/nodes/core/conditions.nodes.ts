/** Routing nodes built on `filter` conditions: If, Filter and Switch. */
import {
  type DataObject,
  type ExecuteContext,
  type FilterValue,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { evaluateFilter, FilterError } from '../../utils/filter';
import { errorItem, errorMessage } from '../../utils/utilities';

export const defaultConditions: FilterValue = {
  conditions: [
    { id: 'condition-1', leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } },
  ],
  combinator: 'and',
  options: { caseSensitive: true, typeValidation: 'strict' },
};

const conditionsProperty: NodeProperty = {
  displayName: 'Conditions',
  name: 'conditions',
  type: 'filter',
  default: defaultConditions,
  description: 'Items that satisfy these conditions are routed to the matching output',
};

const looseTypeProperty: NodeProperty = {
  displayName: 'Convert Types Where Required',
  name: 'looseTypeValidation',
  type: 'boolean',
  default: false,
  description:
    'Whether to convert values before comparing them (for example the text "10" to the number 10). When off, a value of the wrong type stops the node.',
};

const ignoreCaseOption: NodeProperty = {
  displayName: 'Ignore Case',
  name: 'ignoreCase',
  type: 'boolean',
  default: false,
  description: 'Whether to ignore letter case when comparing text',
};

/** Evaluate the `conditions` filter for one item, turning type problems into node errors. */
export function itemMatches(
  ctx: ExecuteContext,
  itemIndex: number,
  parameter = 'conditions',
  looseParameter = 'looseTypeValidation',
  ignoreCaseParameter = 'options.ignoreCase',
): boolean {
  const filter = ctx.getNodeParameter(parameter, itemIndex, defaultConditions) as FilterValue;
  const loose = ctx.getNodeParameter(looseParameter, itemIndex, false) as boolean;
  const ignoreCase = ctx.getNodeParameter(ignoreCaseParameter, itemIndex, false) as boolean;
  try {
    return evaluateFilter(filter, {
      ...(loose ? { typeValidation: 'loose' } : {}),
      ...(ignoreCase ? { caseSensitive: false } : {}),
    });
  } catch (error) {
    if (error instanceof FilterError) {
      throw new NodeOperationError(ctx.getNode(), error.message, {
        itemIndex,
        description: error.description,
        parameter,
      });
    }
    throw error;
  }
}

function routed(item: Item, itemIndex: number): Item {
  return { ...item, pairedItem: { item: itemIndex } };
}

export const IfNode: NodeType = {
  description: {
    name: 'core.if',
    displayName: 'If',
    description: 'Route items to a true or false branch based on conditions',
    icon: 'lucide:split',
    iconColor: '#408000',
    group: ['transform'],
    version: 1,
    defaults: { name: 'If' },
    inputs: ['main'],
    outputs: [
      { type: 'main', displayName: 'true' },
      { type: 'main', displayName: 'false' },
    ],
    outputNames: ['true', 'false'],
    categories: ['Core', 'Flow'],
    alias: ['condition', 'conditional', 'branch', 'compare', 'boolean', 'logic'],
    properties: [
      conditionsProperty,
      looseTypeProperty,
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [ignoreCaseOption],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const trueItems: Item[] = [];
    const falseItems: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        (itemMatches(ctx, i) ? trueItems : falseItems).push(routed(items[i], i));
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        falseItems.push(errorItem(error, i, items[i].json));
      }
    }
    return [trueItems, falseItems];
  },
};

export const FilterNode: NodeType = {
  description: {
    name: 'core.filter',
    displayName: 'Filter',
    description: 'Keep only the items that match conditions',
    icon: 'lucide:filter',
    iconColor: '#229eff',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Filter' },
    inputs: ['main'],
    outputs: `={{ ($parameter.options ?? {}).allowFallthrough ? [{ type: 'main', displayName: 'Kept' }, { type: 'main', displayName: 'Discarded' }] : [{ type: 'main', displayName: 'Kept' }] }}`,
    categories: ['Core', 'Flow', 'Data transformation'],
    alias: ['where', 'remove', 'exclude', 'keep', 'condition'],
    properties: [
      conditionsProperty,
      looseTypeProperty,
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          ignoreCaseOption,
          {
            displayName: 'Output Discarded Items',
            name: 'allowFallthrough',
            type: 'boolean',
            default: false,
            description: 'Whether to send items that do not match to a second "Discarded" output',
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const kept: Item[] = [];
    const discarded: Item[] = [];
    const fallthrough = ctx.getNodeParameter('options.allowFallthrough', 0, false) as boolean;
    for (let i = 0; i < items.length; i++) {
      try {
        (itemMatches(ctx, i) ? kept : discarded).push(routed(items[i], i));
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        kept.push(errorItem(error, i, items[i].json));
      }
    }
    return fallthrough ? [kept, discarded] : [kept];
  },
};

// ---------------------------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------------------------

interface SwitchRule {
  conditions?: FilterValue;
  renameOutput?: boolean;
  outputKey?: string;
}

/**
 * Output ports as an expression of the node's own parameters, evaluated by the engine and the
 * editor (`$parameter` holds the raw, user-set parameters, so every default is spelled out).
 */
const switchOutputs = `={{ $parameter.mode === 'expression'
  ? Array.from({ length: Math.max(1, Number($parameter.numberOutputs ?? 4)) }, (_, i) => ({ type: 'main', displayName: String(i) }))
  : [
      ...((($parameter.rules ?? {}).values ?? []).map((rule, i) => ({ type: 'main', displayName: rule.renameOutput && rule.outputKey ? rule.outputKey : String(i) }))),
      ...((($parameter.options ?? {}).fallbackOutput === 'extra') ? [{ type: 'main', displayName: ($parameter.options.renameFallbackOutput || 'Fallback') }] : []),
    ] }}`;

export const SwitchNode: NodeType = {
  description: {
    name: 'core.switch',
    displayName: 'Switch',
    description: 'Route items to different outputs by rules or a computed output index',
    icon: 'lucide:signpost',
    iconColor: '#506000',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Switch' },
    inputs: ['main'],
    outputs: switchOutputs,
    categories: ['Core', 'Flow'],
    alias: ['router', 'case', 'if', 'branch', 'route', 'conditional'],
    subtitle: '={{ $parameter.mode === "expression" ? "mode: expression" : "mode: rules" }}',
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'rules',
        noDataExpression: true,
        options: [
          { name: 'Rules', value: 'rules', description: 'Build a matching rule for each output' },
          {
            name: 'Expression',
            value: 'expression',
            description: 'Compute the output index for each item with an expression',
          },
        ],
      },
      {
        displayName: 'Number of Outputs',
        name: 'numberOutputs',
        type: 'number',
        default: 4,
        noDataExpression: true,
        typeOptions: { minValue: 1, maxValue: 50 },
        displayOptions: { show: { mode: ['expression'] } },
      },
      {
        displayName: 'Output Index',
        name: 'output',
        type: 'number',
        default: '={{ 0 }}',
        description:
          'Zero-based index of the output the item goes to, e.g. {{ $json.priority === "high" ? 0 : 1 }}',
        displayOptions: { show: { mode: ['expression'] } },
      },
      {
        displayName: 'Routing Rules',
        name: 'rules',
        type: 'fixedCollection',
        placeholder: 'Add routing rule',
        default: { values: [{ conditions: defaultConditions }] },
        typeOptions: { multipleValues: true, sortable: true, multipleValueButtonText: 'Add routing rule' },
        displayOptions: { show: { mode: ['rules'] } },
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              { ...conditionsProperty, description: 'Items matching these conditions go to this output' },
              {
                displayName: 'Rename Output',
                name: 'renameOutput',
                type: 'boolean',
                default: false,
              },
              {
                displayName: 'Output Name',
                name: 'outputKey',
                type: 'string',
                default: '',
                displayOptions: { show: { renameOutput: [true] } },
                description: 'Label of this output on the canvas',
              },
            ],
          },
        ],
      },
      { ...looseTypeProperty, displayOptions: { show: { mode: ['rules'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { mode: ['rules'] } },
        options: [
          {
            displayName: 'Fallback Output',
            name: 'fallbackOutput',
            type: 'options',
            default: 'none',
            description: 'Where items that match no rule go',
            options: [
              { name: 'None (Drop Items)', value: 'none' },
              { name: 'Extra Output', value: 'extra', description: 'Adds a "Fallback" output' },
              { name: 'Output 0', value: 0 },
              { name: 'Output 1', value: 1 },
              { name: 'Output 2', value: 2 },
              { name: 'Output 3', value: 3 },
            ],
          },
          {
            displayName: 'Rename Fallback Output',
            name: 'renameFallbackOutput',
            type: 'string',
            default: '',
            placeholder: 'Fallback',
          },
          ignoreCaseOption,
          {
            displayName: 'Send Data to All Matching Outputs',
            name: 'allMatchingOutputs',
            type: 'boolean',
            default: false,
            description: 'Whether an item goes to every matching output instead of only the first one',
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const mode = ctx.getNodeParameter('mode', 0, 'rules') as string;

    if (mode === 'expression') {
      const count = Math.max(1, Number(ctx.getNodeParameter('numberOutputs', 0, 4)));
      const outputs: Item[][] = Array.from({ length: count }, () => []);
      for (let i = 0; i < items.length; i++) {
        try {
          const index = Number(ctx.getNodeParameter('output', i));
          if (!Number.isInteger(index) || index < 0 || index >= count) {
            throw new NodeOperationError(
              ctx.getNode(),
              `Output index ${String(index)} is not between 0 and ${count - 1}`,
              { itemIndex: i, parameter: 'output' },
            );
          }
          outputs[index].push(routed(items[i], i));
        } catch (error) {
          if (!ctx.continueOnFail()) throw error;
          outputs[0].push(errorItem(error, i, items[i].json));
        }
      }
      return outputs;
    }

    const rules = ((ctx.getNodeParameter('rules', 0, {}) as DataObject).values ?? []) as SwitchRule[];
    const fallback = ctx.getNodeParameter('options.fallbackOutput', 0, 'none') as string | number;
    const allMatching = ctx.getNodeParameter('options.allMatchingOutputs', 0, false) as boolean;
    const outputCount = rules.length + (fallback === 'extra' ? 1 : 0);
    const outputs: Item[][] = Array.from({ length: Math.max(1, outputCount) }, () => []);

    for (let i = 0; i < items.length; i++) {
      try {
        let matched = false;
        for (let r = 0; r < rules.length; r++) {
          if (!itemMatches(ctx, i, `rules.values[${r}].conditions`)) continue;
          matched = true;
          outputs[r].push(routed(items[i], i));
          if (!allMatching) break;
        }
        if (matched || fallback === 'none') continue;
        if (fallback === 'extra') {
          outputs[rules.length].push(routed(items[i], i));
        } else {
          const index = Number(fallback);
          if (!outputs[index]) {
            throw new NodeOperationError(ctx.getNode(), `Fallback output ${index} does not exist`, {
              itemIndex: i,
            });
          }
          outputs[index].push(routed(items[i], i));
        }
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        outputs[0].push(errorItem(error, i, { ...items[i].json, error: errorMessage(error) }));
      }
    }
    return outputs;
  },
};
