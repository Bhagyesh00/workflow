/**
 * Model Selector sub-node: connects 2 to 10 chat models and hands the parent the first one whose rule
 * matches the current item. Rules are tried top to bottom. The inputs carry no node filter (as n8n), so a
 * text completion model passes through and the parent that needs a chat model refuses it.
 */
import { evaluateFilter, FilterError } from '@workflow/nodes-base/utils/filter';
import { type FilterValue, NodeOperationError, type NodeProperty, type NodeType } from '@workflow/workflow';

const MAX_INPUTS = 10;

const defaultConditions: FilterValue = {
  conditions: [
    { id: 'condition-1', leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } },
  ],
  combinator: 'and',
  options: { caseSensitive: true, typeValidation: 'strict' },
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const properties: NodeProperty[] = [
  {
    displayName: 'Number of Inputs',
    name: 'numberInputs',
    type: 'options',
    noDataExpression: true,
    default: 2,
    options: range(2, MAX_INPUTS).map((n) => ({ name: String(n), value: n })),
    description: 'How many models are connected to this node',
  },
  {
    displayName: 'Rules',
    name: 'rules',
    type: 'fixedCollection',
    placeholder: 'Add rule',
    default: {},
    typeOptions: { multipleValues: true, sortable: true, multipleValueButtonText: 'Add rule' },
    description: 'The first rule whose conditions are true picks the model for the current item',
    options: [
      {
        displayName: 'Rule',
        name: 'rule',
        values: [
          {
            displayName: 'Model',
            name: 'model',
            type: 'options',
            default: 1,
            options: range(1, MAX_INPUTS).map((n) => ({ name: `Model ${n}`, value: n })),
            description: 'The model input this rule picks',
          },
          {
            displayName: 'Conditions',
            name: 'conditions',
            type: 'filter',
            default: defaultConditions,
            description: 'When these conditions are true, the rule picks its model',
          },
        ],
      },
    ],
  },
];

interface Rule {
  model?: number | string;
  conditions?: FilterValue;
}

export const ModelSelectorNode: NodeType = {
  description: {
    name: 'ai.modelSelector',
    displayName: 'Model Selector',
    description: 'Chooses one of the connected chat models by rules on the current item',
    icon: 'lucide:shuffle',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Model Selector' },
    inputs: `={{ Array.from({ length: Math.min(10, Math.max(2, Number($parameter.numberInputs ?? 2))) }, (_, i) => ({ type: 'ai_languageModel', displayName: 'Model ' + (i + 1), required: true, maxConnections: 1 })) }}`,
    outputs: ['ai_languageModel'],
    outputNames: ['Model'],
    categories: ['AI', 'Language Models'],
    alias: ['router', 'switch', 'fallback', 'llm'],
    properties,
  },
  async supplyData(ctx, itemIndex) {
    const node = ctx.getNode();
    const fail = (message: string, description: string): never => {
      throw new NodeOperationError(node, message, { description, itemIndex });
    };

    const raw = await ctx.getInputConnectionData('ai_languageModel', itemIndex);
    // several ports give one value per port, in order; an empty port is undefined
    const models = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).map((m) =>
      Array.isArray(m) ? m[0] : m,
    );
    if (!models.some((m) => m !== undefined && m !== null)) {
      return fail('No models connected', 'No models found in input connections');
    }

    const rules = ((ctx.getNodeParameter('rules', itemIndex, {}) as { rule?: Rule[] } | undefined)?.rule ??
      []) as Rule[];
    if (!rules.length) return fail('No rules defined', 'At least one rule must be defined to select a model');

    for (const [ruleIndex, rule] of rules.entries()) {
      let matched: boolean;
      try {
        matched = evaluateFilter(rule.conditions ?? defaultConditions, { zone: ctx.getTimezone() });
      } catch (error) {
        if (error instanceof FilterError) {
          throw new NodeOperationError(node, `${error.message} [rule ${ruleIndex + 1}]`, {
            description: error.description,
            itemIndex,
            cause: error,
          });
        }
        throw error;
      }
      if (!matched) continue;
      const index = Number(rule.model ?? 1);
      if (!Number.isInteger(index) || index < 1 || index > models.length) {
        return fail(`Invalid model index ${index}`, `Model index must be between 1 and ${models.length}`);
      }
      const model = models[index - 1];
      if (model === undefined || model === null) {
        return fail(`Invalid model index ${index}`, `Model ${index} is not connected`);
      }
      return { response: model };
    }
    return fail('No matching rule found', 'None of the defined rules matched the workflow data');
  },
};
