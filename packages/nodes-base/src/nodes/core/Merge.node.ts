/**
 * Merge: combine the data of 2-10 inputs. Every output item keeps `pairedItem` links (with the
 * input index) to the items it came from, so `$('Node').item` keeps working after a merge.
 */
import {
  type DataObject,
  deepCopy,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeType,
  type PairedItem,
} from '@workflow/workflow';
import { deepEqual, getField, looseEqual, stableStringify } from '../../utils/utilities';

type ClashHandling = 'preferInput2' | 'preferInput1' | 'addSuffix';

interface FieldPair {
  field1: string;
  field2: string;
}

function mergeJson(sources: DataObject[], clash: ClashHandling, deep: boolean): DataObject {
  if (clash === 'addSuffix') {
    const out: DataObject = {};
    const counts = new Map<string, number>();
    for (const source of sources)
      for (const key of Object.keys(source)) counts.set(key, (counts.get(key) ?? 0) + 1);
    sources.forEach((source, i) => {
      for (const [key, value] of Object.entries(source)) {
        out[(counts.get(key) ?? 0) > 1 ? `${key}_${i + 1}` : key] = deepCopy(value);
      }
    });
    return out;
  }
  const ordered = clash === 'preferInput1' ? [...sources].reverse() : sources;
  let out: DataObject = {};
  for (const source of ordered) out = deep ? deepMerge(out, source) : Object.assign(out, deepCopy(source));
  return out;
}

function deepMerge(target: DataObject, source: DataObject): DataObject {
  const out: DataObject = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    out[key] =
      existing && value && typeof existing === 'object' && typeof value === 'object' && !Array.isArray(value)
        ? deepMerge(existing as DataObject, value as DataObject)
        : deepCopy(value);
  }
  return out;
}

function mergeBinary(items: Array<Item | undefined>, clash: ClashHandling): Item['binary'] {
  const present = items.filter((i): i is Item => !!i?.binary);
  if (!present.length) return undefined;
  const ordered = clash === 'preferInput1' ? [...present].reverse() : present;
  return Object.assign({}, ...ordered.map((i) => i.binary));
}

function combine(
  parts: Array<{ item: Item; index: number; input: number } | undefined>,
  clash: ClashHandling,
  deep: boolean,
): Item {
  const present = parts.filter((p): p is { item: Item; index: number; input: number } => !!p);
  const json = mergeJson(
    present.map((p) => p.item.json),
    clash,
    deep,
  );
  const item: Item = {
    json,
    pairedItem: present.map((p) => ({ item: p.index, input: p.input })),
  };
  const binary = mergeBinary(
    present.map((p) => p.item),
    clash,
  );
  if (binary) item.binary = binary;
  return item;
}

function tag(item: Item, index: number, input: number): Item {
  return { ...item, pairedItem: { item: index, input } };
}

const clashOption = {
  displayName: 'Clashing Field Values',
  name: 'clashHandling',
  type: 'options' as const,
  default: 'preferInput2',
  description: 'What to do when both inputs have a field with the same name',
  options: [
    { name: 'Prefer Input 2 Version', value: 'preferInput2' },
    { name: 'Prefer Input 1 Version', value: 'preferInput1' },
    { name: 'Always Add Input Number to Field Names', value: 'addSuffix' },
  ],
};

export const MergeNode: NodeType = {
  description: {
    name: 'core.merge',
    displayName: 'Merge',
    description: 'Combine data from several inputs: append, join on fields, by position or as combinations',
    icon: 'lucide:merge',
    iconColor: '#00bbcc',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Merge' },
    inputs: `={{ Array.from({ length: Math.min(10, Math.max(2, Number($parameter.numberInputs ?? 2))) }, (_, i) => ({ type: 'main', displayName: 'Input ' + (i + 1) })) }}`,
    outputs: ['main'],
    categories: ['Core', 'Flow', 'Data transformation'],
    alias: ['join', 'concatenate', 'combine', 'wait', 'union', 'zip', 'lookup', 'enrich'],
    subtitle: '={{ $parameter.mode }}',
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'append',
        noDataExpression: true,
        options: [
          {
            name: 'Append',
            value: 'append',
            description: 'Output the items of each input, one input after another',
          },
          {
            name: 'Combine by Matching Fields',
            value: 'combineByMatchingFields',
            description: 'Join items of input 1 and 2 whose fields match (like a database join)',
          },
          {
            name: 'Combine by Position',
            value: 'combineByPosition',
            description: 'Merge the first items of every input together, then the second ones, ...',
          },
          {
            name: 'Combine All Combinations',
            value: 'combineAllCombinations',
            description: 'Every item of input 1 combined with every item of input 2',
          },
          {
            name: 'Choose Branch',
            value: 'chooseBranch',
            description: 'Wait for all inputs, then output the data of one of them',
          },
        ],
      },
      {
        displayName: 'Number of Inputs',
        name: 'numberInputs',
        type: 'options',
        default: 2,
        noDataExpression: true,
        displayOptions: { show: { mode: ['append', 'combineByPosition', 'chooseBranch'] } },
        options: [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ name: String(n), value: n })),
        description: 'Number of inputs shown on the node',
      },
      {
        displayName: 'Fields to Match',
        name: 'fieldsToMatch',
        type: 'fixedCollection',
        default: { values: [{ field1: '', field2: '' }] },
        placeholder: 'Add fields to match',
        typeOptions: { multipleValues: true },
        displayOptions: { show: { mode: ['combineByMatchingFields'] } },
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              {
                displayName: 'Input 1 Field',
                name: 'field1',
                type: 'string',
                default: '',
                placeholder: 'id',
              },
              {
                displayName: 'Input 2 Field',
                name: 'field2',
                type: 'string',
                default: '',
                placeholder: 'userId',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Output Type',
        name: 'joinMode',
        type: 'options',
        default: 'inner',
        displayOptions: { show: { mode: ['combineByMatchingFields'] } },
        options: [
          { name: 'Keep Matches (Inner Join)', value: 'inner', description: 'Only items that match' },
          {
            name: 'Enrich Input 1 (Left Join)',
            value: 'left',
            description: 'All items of input 1, with data of matching input 2 items added',
          },
          {
            name: 'Enrich Input 2 (Right Join)',
            value: 'right',
            description: 'All items of input 2, with data of matching input 1 items added',
          },
          {
            name: 'Keep Everything (Outer Join)',
            value: 'outer',
            description: 'Matches merged, plus every item that did not match',
          },
          {
            name: 'Keep Non-Matches of Input 1 (Anti Join)',
            value: 'antiLeft',
            description: 'Items of input 1 that have no match in input 2',
          },
          {
            name: 'Keep Non-Matches of Input 2 (Anti Join)',
            value: 'antiRight',
            description: 'Items of input 2 that have no match in input 1',
          },
        ],
      },
      {
        displayName: 'Output Data From',
        name: 'outputDataFrom',
        type: 'options',
        default: 'both',
        displayOptions: { show: { mode: ['combineByMatchingFields'], joinMode: ['inner'] } },
        options: [
          { name: 'Both Inputs Merged Together', value: 'both' },
          { name: 'Input 1', value: 'input1' },
          { name: 'Input 2', value: 'input2' },
        ],
      },
      {
        displayName: 'Output Data of Input',
        name: 'useDataOfInput',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 1, maxValue: 10 },
        displayOptions: { show: { mode: ['chooseBranch'], chooseBranchMode: ['specifiedInput'] } },
        description: 'Number of the input whose items are output (1 is the first input)',
      },
      {
        displayName: 'Output',
        name: 'chooseBranchMode',
        type: 'options',
        default: 'specifiedInput',
        displayOptions: { show: { mode: ['chooseBranch'] } },
        options: [
          { name: 'Data of Specified Input', value: 'specifiedInput' },
          { name: 'A Single, Empty Item', value: 'empty' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: {
          show: { mode: ['combineByMatchingFields', 'combineByPosition', 'combineAllCombinations'] },
        },
        options: [
          clashOption,
          {
            displayName: 'Merge Nested Fields',
            name: 'deepMerge',
            type: 'boolean',
            default: false,
            description: 'Whether nested objects are merged key by key instead of replaced',
          },
          {
            displayName: 'Fuzzy Compare',
            name: 'fuzzyCompare',
            type: 'boolean',
            default: false,
            description: 'Whether to treat values like 1 and "1" as equal when matching',
          },
          {
            displayName: 'Multiple Matches',
            name: 'multipleMatches',
            type: 'options',
            default: 'all',
            options: [
              { name: 'Include All Matches', value: 'all', description: 'One output item per match' },
              { name: 'Include First Match Only', value: 'first' },
            ],
          },
          {
            displayName: 'Include Any Unpaired Items',
            name: 'includeUnpaired',
            type: 'boolean',
            default: false,
            description: 'Whether items without a partner at the same position are output (by position)',
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    const mode = ctx.getNodeParameter('mode', 0) as string;
    const inputCount =
      mode === 'combineByMatchingFields' || mode === 'combineAllCombinations'
        ? 2
        : Math.min(10, Math.max(2, Number(ctx.getNodeParameter('numberInputs', 0, 2))));
    const inputs = Array.from({ length: inputCount }, (_, i) => ctx.getInputData(i) ?? []);
    const clash = ctx.getNodeParameter('options.clashHandling', 0, 'preferInput2') as ClashHandling;
    const deep = ctx.getNodeParameter('options.deepMerge', 0, false) as boolean;

    switch (mode) {
      case 'append':
        return [inputs.flatMap((items, input) => items.map((item, i) => tag(item, i, input)))];

      case 'combineByPosition': {
        const includeUnpaired = ctx.getNodeParameter('options.includeUnpaired', 0, false) as boolean;
        const lengths = inputs.map((items) => items.length);
        const count = includeUnpaired ? Math.max(...lengths) : Math.min(...lengths);
        const out: Item[] = [];
        for (let i = 0; i < count; i++) {
          out.push(
            combine(
              inputs.map((items, input) => (items[i] ? { item: items[i], index: i, input } : undefined)),
              clash,
              deep,
            ),
          );
        }
        return [out];
      }

      case 'combineAllCombinations': {
        const out: Item[] = [];
        inputs[0].forEach((a, i) => {
          inputs[1].forEach((b, j) => {
            out.push(
              combine(
                [
                  { item: a, index: i, input: 0 },
                  { item: b, index: j, input: 1 },
                ],
                clash,
                deep,
              ),
            );
          });
        });
        return [out];
      }

      case 'chooseBranch': {
        const chooseMode = ctx.getNodeParameter('chooseBranchMode', 0, 'specifiedInput') as string;
        if (chooseMode === 'empty') {
          const paired: PairedItem[] = inputs.flatMap((items, input) =>
            items.map((_, i) => ({ item: i, input })),
          );
          return [[{ json: {}, pairedItem: paired.length ? paired : { item: 0 } }]];
        }
        const which = Number(ctx.getNodeParameter('useDataOfInput', 0, 1));
        if (!Number.isInteger(which) || which < 1 || which > inputCount) {
          throw new NodeOperationError(ctx.getNode(), `Input ${which} does not exist on this node`, {
            parameter: 'useDataOfInput',
          });
        }
        return [inputs[which - 1].map((item, i) => tag(item, i, which - 1))];
      }

      case 'combineByMatchingFields':
        return [joinByFields(ctx, inputs[0], inputs[1], clash, deep)];

      default:
        throw new NodeOperationError(ctx.getNode(), `Unknown mode "${mode}"`);
    }
  },
};

function joinByFields(
  ctx: ExecuteContext,
  input1: Item[],
  input2: Item[],
  clash: ClashHandling,
  deep: boolean,
): Item[] {
  const pairs = (
    ((ctx.getNodeParameter('fieldsToMatch', 0, {}) as DataObject).values ?? []) as FieldPair[]
  ).filter((p) => p.field1 && p.field2);
  if (!pairs.length) {
    throw new NodeOperationError(ctx.getNode(), 'Add at least one pair of fields to match', {
      parameter: 'fieldsToMatch',
    });
  }
  const joinMode = ctx.getNodeParameter('joinMode', 0, 'inner') as string;
  const outputDataFrom = ctx.getNodeParameter('outputDataFrom', 0, 'both') as string;
  const fuzzy = ctx.getNodeParameter('options.fuzzyCompare', 0, false) as boolean;
  const firstOnly = ctx.getNodeParameter('options.multipleMatches', 0, 'all') === 'first';

  const keyOf = (item: Item, side: 'field1' | 'field2') => pairs.map((p) => getField(item.json, p[side]));
  const keysMatch = (a: unknown[], b: unknown[]) =>
    a.every(
      (v, i) => v !== undefined && b[i] !== undefined && (fuzzy ? looseEqual(v, b[i]) : deepEqual(v, b[i])),
    );

  // exact matching uses a hash index; fuzzy matching falls back to a scan
  const index = new Map<string, number[]>();
  const keys2 = input2.map((item) => keyOf(item, 'field2'));
  if (!fuzzy) {
    keys2.forEach((key, j) => {
      if (key.some((v) => v === undefined)) return;
      const h = stableStringify(key);
      index.set(h, [...(index.get(h) ?? []), j]);
    });
  }
  const matchesFor = (key: unknown[]): number[] => {
    if (key.some((v) => v === undefined)) return [];
    const found = fuzzy
      ? keys2.flatMap((k, j) => (keysMatch(key, k) ? [j] : []))
      : (index.get(stableStringify(key)) ?? []).filter((j) => keysMatch(key, keys2[j]));
    // for a right join "first match" applies per input 2 item, below
    return firstOnly && joinMode !== 'right' ? found.slice(0, 1) : found;
  };

  const out: Item[] = [];
  const matched2 = new Map<number, number[]>();
  const one = (item: Item, index: number, input: number) => ({ item, index, input });
  const copy = (item: Item, pairedItem: PairedItem[]): Item => ({
    ...item,
    json: deepCopy(item.json),
    pairedItem,
  });

  input1.forEach((a, i) => {
    const matches = matchesFor(keyOf(a, 'field1'));
    for (const j of matches) matched2.set(j, [...(matched2.get(j) ?? []), i]);
    switch (joinMode) {
      case 'inner':
        if (!matches.length || outputDataFrom === 'input2') break;
        if (outputDataFrom === 'input1') {
          out.push(copy(a, [{ item: i, input: 0 }, ...matches.map((j) => ({ item: j, input: 1 }))]));
        } else {
          for (const j of matches) out.push(combine([one(a, i, 0), one(input2[j], j, 1)], clash, deep));
        }
        break;
      case 'left':
      case 'outer':
        if (!matches.length) out.push(copy(a, [{ item: i, input: 0 }]));
        for (const j of matches) out.push(combine([one(a, i, 0), one(input2[j], j, 1)], clash, deep));
        break;
      case 'antiLeft':
        if (!matches.length) out.push(tag(a, i, 0));
        break;
      default:
        break;
    }
  });

  switch (joinMode) {
    case 'inner':
      if (outputDataFrom === 'input2') {
        input2.forEach((b, j) => {
          const from = matched2.get(j);
          if (from) out.push(copy(b, [...from.map((i) => ({ item: i, input: 0 })), { item: j, input: 1 }]));
        });
      }
      return out;
    case 'right': {
      const right: Item[] = [];
      input2.forEach((b, j) => {
        let from = matched2.get(j) ?? [];
        if (firstOnly) from = from.slice(0, 1);
        if (!from.length) right.push(copy(b, [{ item: j, input: 1 }]));
        for (const i of from) right.push(combine([one(input1[i], i, 0), one(b, j, 1)], clash, deep));
      });
      return right;
    }
    case 'outer':
    case 'antiRight':
      input2.forEach((b, j) => {
        if (!matched2.has(j)) out.push(tag(b, j, 1));
      });
      return out;
    default:
      return out;
  }
}
