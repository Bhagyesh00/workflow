/**
 * Item-list transformations: Aggregate, Split Out, Sort, Limit, Remove Duplicates, Summarize,
 * Rename Keys and Compare Datasets. None of them mutate input items; outputs are fresh copies.
 */
import {
  type DataObject,
  deepCopy,
  type ExecuteContext,
  type Item,
  isPlainObject,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  type PairedItem,
} from '@workflow/workflow';
import { DateTime } from 'luxon';
import {
  deepEqual,
  errorItem,
  fieldList,
  getField,
  looseEqual,
  setField,
  stableStringify,
  unsetField,
} from '../../utils/utilities';

const dotNotationOption: NodeProperty = {
  displayName: 'Disable Dot Notation',
  name: 'disableDotNotation',
  type: 'boolean',
  default: false,
  description: 'Whether "a.b" refers to a field literally named "a.b" instead of the nested field b of a',
};

function dotNotation(ctx: ExecuteContext): boolean {
  return !(ctx.getNodeParameter('options.disableDotNotation', 0, false) as boolean);
}

function allPaired(items: Item[]): PairedItem[] {
  return items.map((_, i) => ({ item: i }));
}

// ---------------------------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------------------------

export const AggregateNode: NodeType = {
  description: {
    name: 'core.aggregate',
    displayName: 'Aggregate',
    description: 'Combine a field from many items, or whole items, into a list on one item',
    icon: 'lucide:layers',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Aggregate' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['combine', 'collect', 'group', 'list', 'array', 'concatenate', 'join items'],
    properties: [
      {
        displayName: 'Aggregate',
        name: 'aggregate',
        type: 'options',
        default: 'aggregateIndividualFields',
        options: [
          { name: 'Individual Fields', value: 'aggregateIndividualFields' },
          { name: 'All Item Data (Into a Single List)', value: 'aggregateAllItemData' },
        ],
      },
      {
        displayName: 'Fields to Aggregate',
        name: 'fieldsToAggregate',
        type: 'fixedCollection',
        default: { fieldToAggregate: [{ fieldToAggregate: '', renameField: false }] },
        placeholder: 'Add field to aggregate',
        typeOptions: { multipleValues: true },
        displayOptions: { show: { aggregate: ['aggregateIndividualFields'] } },
        options: [
          {
            displayName: 'Field',
            name: 'fieldToAggregate',
            values: [
              {
                displayName: 'Input Field Name',
                name: 'fieldToAggregate',
                type: 'string',
                default: '',
                placeholder: 'email',
              },
              { displayName: 'Rename Field', name: 'renameField', type: 'boolean', default: false },
              {
                displayName: 'Output Field Name',
                name: 'outputFieldName',
                type: 'string',
                default: '',
                displayOptions: { show: { renameField: [true] } },
              },
            ],
          },
        ],
      },
      {
        displayName: 'Put Output in Field',
        name: 'destinationFieldName',
        type: 'string',
        default: 'data',
        displayOptions: { show: { aggregate: ['aggregateAllItemData'] } },
      },
      {
        displayName: 'Include',
        name: 'include',
        type: 'options',
        default: 'allFields',
        displayOptions: { show: { aggregate: ['aggregateAllItemData'] } },
        options: [
          { name: 'All Fields', value: 'allFields' },
          { name: 'Specified Fields', value: 'specifiedFields' },
          { name: 'All Fields Except', value: 'allFieldsExcept' },
        ],
      },
      {
        displayName: 'Fields',
        name: 'fields',
        type: 'string',
        default: '',
        placeholder: 'id, name',
        description: 'Comma-separated field names',
        displayOptions: {
          show: { aggregate: ['aggregateAllItemData'], include: ['specifiedFields', 'allFieldsExcept'] },
        },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          dotNotationOption,
          {
            displayName: 'Merge Lists',
            name: 'mergeLists',
            type: 'boolean',
            default: false,
            description: 'Whether list values are flattened into one list instead of a list of lists',
            displayOptions: { show: { '/aggregate': ['aggregateIndividualFields'] } },
          },
          {
            displayName: 'Keep Missing and Null Values',
            name: 'keepMissing',
            type: 'boolean',
            default: false,
            description: 'Whether to add null for items that lack the field',
            displayOptions: { show: { '/aggregate': ['aggregateIndividualFields'] } },
          },
          {
            displayName: 'Include Binaries',
            name: 'includeBinaries',
            type: 'boolean',
            default: false,
            description: 'Whether binary files of all items are added to the output item',
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const dots = dotNotation(ctx);
    const mode = ctx.getNodeParameter('aggregate', 0) as string;
    const json: DataObject = {};

    if (mode === 'aggregateAllItemData') {
      const destination = (ctx.getNodeParameter('destinationFieldName', 0, 'data') as string) || 'data';
      const include = ctx.getNodeParameter('include', 0, 'allFields') as string;
      const fields = fieldList(ctx.getNodeParameter('fields', 0, ''));
      const list = items.map((item) => {
        if (include === 'specifiedFields') {
          const picked: DataObject = {};
          for (const f of fields) {
            const value = getField(item.json, f, dots);
            if (value !== undefined) setField(picked, f, deepCopy(value), dots);
          }
          return picked;
        }
        const copy = deepCopy(item.json);
        if (include === 'allFieldsExcept') for (const f of fields) unsetField(copy, f, dots);
        return copy;
      });
      setField(json, destination, list, dots);
    } else {
      const entries = ((ctx.getNodeParameter('fieldsToAggregate', 0, {}) as DataObject).fieldToAggregate ??
        []) as Array<{ fieldToAggregate: string; renameField?: boolean; outputFieldName?: string }>;
      const mergeLists = ctx.getNodeParameter('options.mergeLists', 0, false) as boolean;
      const keepMissing = ctx.getNodeParameter('options.keepMissing', 0, false) as boolean;
      for (const entry of entries) {
        if (!entry.fieldToAggregate) continue;
        const output =
          entry.renameField && entry.outputFieldName ? entry.outputFieldName : entry.fieldToAggregate;
        let found = false;
        const values: unknown[] = [];
        for (const item of items) {
          const value = getField(item.json, entry.fieldToAggregate, dots);
          if (value !== undefined) found = true;
          if (value === undefined || value === null) {
            if (keepMissing) values.push(null);
            continue;
          }
          if (mergeLists && Array.isArray(value)) values.push(...deepCopy(value));
          else values.push(deepCopy(value));
        }
        if (!found && items.length) {
          throw new NodeOperationError(
            ctx.getNode(),
            `The field "${entry.fieldToAggregate}" is not in any input item`,
            {
              description: 'Check the field name, or turn on dot notation for nested fields',
            },
          );
        }
        setField(json, output, values, dots);
      }
    }

    const out: Item = { json, pairedItem: items.length ? allPaired(items) : { item: 0 } };
    if (ctx.getNodeParameter('options.includeBinaries', 0, false)) {
      const binary: NonNullable<Item['binary']> = {};
      let n = 0;
      for (const item of items) {
        for (const value of Object.values(item.binary ?? {})) binary[`data_${n++}`] = value;
      }
      if (n) out.binary = binary;
    }
    return [[out]];
  },
};

// ---------------------------------------------------------------------------------------------
// Split Out
// ---------------------------------------------------------------------------------------------

export const SplitOutNode: NodeType = {
  description: {
    name: 'core.splitOut',
    displayName: 'Split Out',
    description: 'Turn a list inside an item into separate items',
    icon: 'lucide:ungroup',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Split Out' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['explode', 'unwind', 'flatten', 'split', 'array to items', 'separate'],
    properties: [
      {
        displayName: 'Fields to Split Out',
        name: 'fieldToSplitOut',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'line_items',
        description: 'List field to split; several comma-separated list fields are split side by side',
      },
      {
        displayName: 'Include',
        name: 'include',
        type: 'options',
        default: 'noOtherFields',
        options: [
          { name: 'No Other Fields', value: 'noOtherFields' },
          { name: 'All Other Fields', value: 'allOtherFields' },
          { name: 'Selected Other Fields', value: 'selectedOtherFields' },
        ],
      },
      {
        displayName: 'Fields to Include',
        name: 'fieldsToInclude',
        type: 'string',
        default: '',
        placeholder: 'id, customer',
        displayOptions: { show: { include: ['selectedOtherFields'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          dotNotationOption,
          {
            displayName: 'Destination Field Name',
            name: 'destinationFieldName',
            type: 'string',
            default: '',
            description:
              'Field that holds each split value. When empty, object values are spread into the item and other values keep the original field name.',
          },
          {
            displayName: 'Include Binary',
            name: 'includeBinary',
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const dots = dotNotation(ctx);
    const out: Item[] = [];
    // an item without the field is an empty list; a field that no item has only adds a hint
    const asked = new Set<string>();
    const found = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      try {
        const fields = fieldList(ctx.getNodeParameter('fieldToSplitOut', i));
        if (!fields.length)
          throw new NodeOperationError(ctx.getNode(), 'Enter the field to split out', { itemIndex: i });
        const include = ctx.getNodeParameter('include', i, 'noOtherFields') as string;
        const destination = ctx.getNodeParameter('options.destinationFieldName', i, '') as string;
        const includeBinary = ctx.getNodeParameter('options.includeBinary', i, false) as boolean;
        const json = items[i].json;
        const lists = fields.map((field) => {
          asked.add(field);
          const value = getField(json, field, dots);
          if (value === undefined) return [];
          found.add(field);
          if (Array.isArray(value)) return value;
          if (isPlainObject(value)) return Object.values(value);
          return [value];
        });
        let base: DataObject = {};
        if (include === 'allOtherFields') {
          base = deepCopy(json);
          for (const f of fields) unsetField(base, f, dots);
        } else if (include === 'selectedOtherFields') {
          for (const f of fieldList(ctx.getNodeParameter('fieldsToInclude', i, ''))) {
            const value = getField(json, f, dots);
            if (value !== undefined) setField(base, f, deepCopy(value), dots);
          }
        }
        const length = Math.max(...lists.map((l) => l.length));
        for (let n = 0; n < length; n++) {
          const entry: DataObject = deepCopy(base);
          fields.forEach((field, f) => {
            // a field sets entries only for its own elements; a null element stays null
            if (n >= lists[f].length) return;
            const value = deepCopy(lists[f][n]);
            if (fields.length === 1 && !destination && isPlainObject(value)) Object.assign(entry, value);
            else setField(entry, fields.length === 1 && destination ? destination : field, value, dots);
          });
          out.push({
            json: entry,
            ...(includeBinary && items[i].binary ? { binary: items[i].binary } : {}),
            pairedItem: { item: i },
          });
        }
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        out.push(errorItem(error, i));
      }
    }
    const notFound = [...asked].filter((field) => !found.has(field));
    ctx.addExecutionHints(
      ...notFound.map((field) => ({
        message: `The field '${field}' wasn't found in any input item`,
        level: 'info' as const,
      })),
    );
    return [out];
  },
};

// ---------------------------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------------------------

/** natural ordering for mixed values: nullish last, numbers numerically, dates by time, else text */
export function compareValues(a: unknown, b: unknown): number {
  const nil = (v: unknown) => v === undefined || v === null || v === '';
  if (nil(a) || nil(b)) return nil(a) === nil(b) ? 0 : nil(a) ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (DateTime.isDateTime(a) && DateTime.isDateTime(b)) {
    return (a as DateTime).toMillis() - (b as DateTime).toMillis();
  }
  if (typeof a === 'object' || typeof b === 'object')
    return stableStringify(a).localeCompare(stableStringify(b));
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export const SortNode: NodeType = {
  description: {
    name: 'core.sort',
    displayName: 'Sort',
    description: 'Change the order of items',
    icon: 'lucide:arrow-down-wide-narrow',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Sort' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['order', 'arrange', 'shuffle', 'random', 'reorder', 'rank'],
    properties: [
      {
        displayName: 'Type',
        name: 'type',
        type: 'options',
        default: 'simple',
        options: [
          { name: 'Simple', value: 'simple', description: 'Sort by one or more fields' },
          { name: 'Random', value: 'random', description: 'Shuffle the items' },
          {
            name: 'Expression',
            value: 'expression',
            description: 'Sort by a value computed per item, e.g. {{ $json.lastName + $json.firstName }}',
          },
        ],
      },
      {
        displayName: 'Fields to Sort By',
        name: 'sortFieldsUi',
        type: 'fixedCollection',
        default: { sortField: [{ fieldName: '', order: 'ascending' }] },
        placeholder: 'Add field to sort by',
        typeOptions: { multipleValues: true, sortable: true },
        displayOptions: { show: { type: ['simple'] } },
        options: [
          {
            displayName: 'Field',
            name: 'sortField',
            values: [
              { displayName: 'Field Name', name: 'fieldName', type: 'string', default: '', required: true },
              {
                displayName: 'Order',
                name: 'order',
                type: 'options',
                default: 'ascending',
                options: [
                  { name: 'Ascending', value: 'ascending' },
                  { name: 'Descending', value: 'descending' },
                ],
              },
            ],
          },
        ],
      },
      {
        displayName: 'Sort Key',
        name: 'sortKey',
        type: 'string',
        default: '',
        placeholder: '={{ $json.priority }}',
        description: 'Expression evaluated for every item; items are ordered by the result',
        displayOptions: { show: { type: ['expression'] } },
      },
      {
        displayName: 'Order',
        name: 'order',
        type: 'options',
        default: 'ascending',
        displayOptions: { show: { type: ['expression'] } },
        options: [
          { name: 'Ascending', value: 'ascending' },
          { name: 'Descending', value: 'descending' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { type: ['simple'] } },
        options: [dotNotationOption],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const type = ctx.getNodeParameter('type', 0, 'simple') as string;
    const indexed = items.map((item, i) => ({ item, i }));

    if (type === 'random') {
      for (let n = indexed.length - 1; n > 0; n--) {
        const j = Math.floor(Math.random() * (n + 1));
        [indexed[n], indexed[j]] = [indexed[j], indexed[n]];
      }
    } else if (type === 'expression') {
      const order = ctx.getNodeParameter('order', 0, 'ascending') === 'descending' ? -1 : 1;
      const keys = items.map((_, i) => ctx.getNodeParameter('sortKey', i, ''));
      indexed.sort((a, b) => order * compareValues(keys[a.i], keys[b.i]) || a.i - b.i);
    } else {
      const dots = dotNotation(ctx);
      const fields = ((ctx.getNodeParameter('sortFieldsUi', 0, {}) as DataObject).sortField ?? []) as Array<{
        fieldName: string;
        order: string;
      }>;
      const active = fields.filter((f) => f.fieldName);
      if (!active.length) throw new NodeOperationError(ctx.getNode(), 'Add at least one field to sort by');
      if (
        items.length &&
        active.every((f) => items.every((item) => getField(item.json, f.fieldName, dots) === undefined))
      ) {
        throw new NodeOperationError(
          ctx.getNode(),
          `None of the items has the field "${active[0].fieldName}"`,
        );
      }
      indexed.sort((a, b) => {
        for (const f of active) {
          const r = compareValues(
            getField(a.item.json, f.fieldName, dots),
            getField(b.item.json, f.fieldName, dots),
          );
          if (r) return f.order === 'descending' ? -r : r;
        }
        return a.i - b.i;
      });
    }
    return [indexed.map(({ item, i }) => ({ ...item, pairedItem: { item: i } }))];
  },
};

// ---------------------------------------------------------------------------------------------
// Limit
// ---------------------------------------------------------------------------------------------

export const LimitNode: NodeType = {
  description: {
    name: 'core.limit',
    displayName: 'Limit',
    description: 'Keep only the first or last items',
    icon: 'lucide:list-end',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Limit' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['first', 'last', 'top', 'head', 'tail', 'truncate', 'max items'],
    properties: [
      {
        displayName: 'Max Items',
        name: 'maxItems',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0 },
      },
      {
        displayName: 'Keep',
        name: 'keep',
        type: 'options',
        default: 'firstItems',
        options: [
          { name: 'First Items', value: 'firstItems' },
          { name: 'Last Items', value: 'lastItems' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const max = Number(ctx.getNodeParameter('maxItems', 0, 1));
    if (!Number.isInteger(max) || max < 0) {
      throw new NodeOperationError(ctx.getNode(), 'Max Items must be a whole number of 0 or more', {
        parameter: 'maxItems',
      });
    }
    const keepLast = ctx.getNodeParameter('keep', 0, 'firstItems') === 'lastItems';
    const start = keepLast ? Math.max(0, items.length - max) : 0;
    const end = keepLast ? items.length : Math.min(items.length, max);
    const out: Item[] = [];
    for (let i = start; i < end; i++) out.push({ ...items[i], pairedItem: { item: i } });
    return [out];
  },
};

// ---------------------------------------------------------------------------------------------
// Remove Duplicates
// ---------------------------------------------------------------------------------------------

export const RemoveDuplicatesNode: NodeType = {
  description: {
    name: 'core.removeDuplicates',
    displayName: 'Remove Duplicates',
    description: 'Drop items that repeat earlier items',
    icon: 'lucide:copy-minus',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Remove Duplicates' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['dedupe', 'deduplicate', 'unique', 'distinct', 'duplicates'],
    properties: [
      {
        displayName: 'Compare',
        name: 'compare',
        type: 'options',
        default: 'allFields',
        options: [
          { name: 'All Fields', value: 'allFields' },
          { name: 'All Fields Except', value: 'allFieldsExcept' },
          { name: 'Selected Fields', value: 'selectedFields' },
        ],
      },
      {
        displayName: 'Fields to Exclude',
        name: 'fieldsToExclude',
        type: 'string',
        default: '',
        placeholder: 'updatedAt, id',
        displayOptions: { show: { compare: ['allFieldsExcept'] } },
      },
      {
        displayName: 'Fields to Compare',
        name: 'fieldsToCompare',
        type: 'string',
        default: '',
        placeholder: 'email',
        displayOptions: { show: { compare: ['selectedFields'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          dotNotationOption,
          {
            displayName: 'Remove Other Fields',
            name: 'removeOtherFields',
            type: 'boolean',
            default: false,
            description: 'Whether to output only the compared fields',
            displayOptions: { show: { '/compare': ['selectedFields'] } },
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const compare = ctx.getNodeParameter('compare', 0, 'allFields') as string;
    const dots = dotNotation(ctx);
    const removeOther = ctx.getNodeParameter('options.removeOtherFields', 0, false) as boolean;
    const selected = fieldList(ctx.getNodeParameter('fieldsToCompare', 0, ''));
    const excluded = fieldList(ctx.getNodeParameter('fieldsToExclude', 0, ''));
    if (compare === 'selectedFields' && !selected.length) {
      throw new NodeOperationError(ctx.getNode(), 'Enter at least one field to compare', {
        parameter: 'fieldsToCompare',
      });
    }
    if (compare === 'selectedFields' && items.length) {
      const missing = selected.find((f) => items.every((item) => getField(item.json, f, dots) === undefined));
      if (missing)
        throw new NodeOperationError(ctx.getNode(), `The field "${missing}" is not in any input item`);
    }
    const seen = new Set<string>();
    const out: Item[] = [];
    items.forEach((item, i) => {
      let key: string;
      if (compare === 'selectedFields')
        key = stableStringify(selected.map((f) => getField(item.json, f, dots) ?? null));
      else if (compare === 'allFieldsExcept') {
        const copy = deepCopy(item.json);
        for (const f of excluded) unsetField(copy, f, dots);
        key = stableStringify(copy);
      } else key = stableStringify(item.json);
      if (seen.has(key)) return;
      seen.add(key);
      if (compare === 'selectedFields' && removeOther) {
        const json: DataObject = {};
        for (const f of selected) setField(json, f, deepCopy(getField(item.json, f, dots) ?? null), dots);
        out.push({ json, pairedItem: { item: i } });
      } else out.push({ ...item, pairedItem: { item: i } });
    });
    return [out];
  },
};

// ---------------------------------------------------------------------------------------------
// Summarize
// ---------------------------------------------------------------------------------------------

type Aggregation = 'count' | 'countUnique' | 'sum' | 'average' | 'min' | 'max' | 'concatenate';

interface SummaryField {
  aggregation: Aggregation;
  field: string;
  separator?: string;
  includeEmpty?: boolean;
}

const OUTPUT_PREFIX: Record<Aggregation, string> = {
  count: 'count',
  countUnique: 'unique_count',
  sum: 'sum',
  average: 'average',
  min: 'min',
  max: 'max',
  concatenate: 'concatenated',
};

function summarizeValues(values: unknown[], spec: SummaryField, ctx: ExecuteContext): unknown {
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  const present = spec.includeEmpty ? values : values.filter((v) => !empty(v));
  const numbers = () =>
    present
      .filter((v) => !empty(v))
      .map((v) => {
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isNaN(n)) {
          throw new NodeOperationError(
            ctx.getNode(),
            `The field "${spec.field}" has a value that is not a number: ${JSON.stringify(v)}`,
          );
        }
        return n;
      });
  switch (spec.aggregation) {
    case 'count':
      return present.length;
    case 'countUnique':
      return new Set(present.map((v) => stableStringify(v))).size;
    case 'sum':
      return numbers().reduce((a, b) => a + b, 0);
    case 'average': {
      const n = numbers();
      return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
    }
    case 'min':
    case 'max': {
      const list = present.filter((v) => !empty(v));
      if (!list.length) return null;
      const sorted = [...list].sort(compareValues);
      return spec.aggregation === 'min' ? sorted[0] : sorted[sorted.length - 1];
    }
    case 'concatenate':
      return present
        .map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')))
        .join(spec.separator ?? ', ');
    default:
      throw new NodeOperationError(ctx.getNode(), `Unknown aggregation "${String(spec.aggregation)}"`);
  }
}

export const SummarizeNode: NodeType = {
  description: {
    name: 'core.summarize',
    displayName: 'Summarize',
    description: 'Count, sum, average and more, optionally grouped by fields (like a pivot table)',
    icon: 'lucide:sigma',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Summarize' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['group by', 'pivot', 'sum', 'count', 'average', 'statistics', 'aggregate', 'totals'],
    properties: [
      {
        displayName: 'Fields to Summarize',
        name: 'fieldsToSummarize',
        type: 'fixedCollection',
        default: { values: [{ aggregation: 'count', field: '' }] },
        placeholder: 'Add field',
        typeOptions: { multipleValues: true },
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              {
                displayName: 'Aggregation',
                name: 'aggregation',
                type: 'options',
                default: 'count',
                options: [
                  { name: 'Count', value: 'count' },
                  { name: 'Count Unique', value: 'countUnique' },
                  { name: 'Sum', value: 'sum' },
                  { name: 'Average', value: 'average' },
                  { name: 'Min', value: 'min' },
                  { name: 'Max', value: 'max' },
                  { name: 'Concatenate', value: 'concatenate' },
                ],
              },
              { displayName: 'Field', name: 'field', type: 'string', default: '', placeholder: 'amount' },
              {
                displayName: 'Separator',
                name: 'separator',
                type: 'string',
                default: ', ',
                displayOptions: { show: { aggregation: ['concatenate'] } },
              },
              {
                displayName: 'Include Empty Values',
                name: 'includeEmpty',
                type: 'boolean',
                default: false,
                displayOptions: { show: { aggregation: ['count', 'countUnique', 'concatenate'] } },
              },
            ],
          },
        ],
      },
      {
        displayName: 'Fields to Split By',
        name: 'fieldsToSplitBy',
        type: 'string',
        default: '',
        placeholder: 'country, status',
        description: 'Comma-separated fields to group by; one output row per distinct combination',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          dotNotationOption,
          {
            displayName: 'Continue If Field Not Found',
            name: 'continueIfFieldNotFound',
            type: 'boolean',
            default: false,
          },
          {
            displayName: 'Output Format',
            name: 'outputFormat',
            type: 'options',
            default: 'separateItems',
            options: [
              { name: 'Each Group in a Separate Item', value: 'separateItems' },
              { name: 'All Groups in a Single Item', value: 'singleItem' },
            ],
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const dots = dotNotation(ctx);
    const specs = (
      ((ctx.getNodeParameter('fieldsToSummarize', 0, {}) as DataObject).values ?? []) as SummaryField[]
    ).filter((s) => s.field || s.aggregation === 'count');
    const splitBy = fieldList(ctx.getNodeParameter('fieldsToSplitBy', 0, ''));
    const continueIfMissing = ctx.getNodeParameter('options.continueIfFieldNotFound', 0, false) as boolean;
    if (!specs.length) throw new NodeOperationError(ctx.getNode(), 'Add at least one field to summarize');

    if (!continueIfMissing && items.length) {
      for (const f of [...specs.map((s) => s.field).filter(Boolean), ...splitBy]) {
        if (items.every((item) => getField(item.json, f, dots) === undefined)) {
          throw new NodeOperationError(ctx.getNode(), `The field "${f}" is not in any input item`, {
            description: "Fix the field name, or turn on 'Continue If Field Not Found'",
          });
        }
      }
    }

    const groups = new Map<string, { keys: unknown[]; indices: number[] }>();
    items.forEach((item, i) => {
      const keys = splitBy.map((f) => getField(item.json, f, dots) ?? null);
      const id = stableStringify(keys);
      const group = groups.get(id) ?? { keys, indices: [] };
      group.indices.push(i);
      groups.set(id, group);
    });
    if (!groups.size && !splitBy.length) groups.set('[]', { keys: [], indices: [] });

    const rows: Item[] = [];
    for (const group of groups.values()) {
      const json: DataObject = {};
      splitBy.forEach((f, k) => {
        setField(json, f, deepCopy(group.keys[k]), dots);
      });
      for (const spec of specs) {
        const values = group.indices.map((i) =>
          spec.field ? getField(items[i].json, spec.field, dots) : true,
        );
        const name = `${OUTPUT_PREFIX[spec.aggregation]}_${spec.field || 'items'}`.replace(/\./g, '_');
        json[name] = summarizeValues(values, spec, ctx);
      }
      rows.push({
        json,
        pairedItem: group.indices.length ? group.indices.map((i) => ({ item: i })) : { item: 0 },
      });
    }

    if (ctx.getNodeParameter('options.outputFormat', 0, 'separateItems') === 'singleItem') {
      return [[{ json: { data: rows.map((r) => r.json) }, pairedItem: allPaired(items) }]];
    }
    return [rows];
  },
};

// ---------------------------------------------------------------------------------------------
// Rename Keys
// ---------------------------------------------------------------------------------------------

function renameByRegex(
  value: unknown,
  regex: RegExp,
  replacement: string,
  depth: number,
  level = 0,
): unknown {
  if (Array.isArray(value)) return value.map((v) => renameByRegex(v, regex, replacement, depth, level));
  if (!isPlainObject(value)) return value;
  const out: DataObject = {};
  for (const [key, v] of Object.entries(value)) {
    const renamed = depth === -1 || level <= depth ? key.replace(regex, replacement) : key;
    const safe =
      renamed === '__proto__' || renamed === 'constructor' || renamed === 'prototype' ? key : renamed;
    out[safe] = depth === -1 || level < depth ? renameByRegex(v, regex, replacement, depth, level + 1) : v;
  }
  return out;
}

export const RenameKeysNode: NodeType = {
  description: {
    name: 'core.renameKeys',
    displayName: 'Rename Keys',
    description: 'Rename item fields, one by one or with a regular expression',
    icon: 'lucide:text-cursor-input',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Rename Keys' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['rename', 'fields', 'columns', 'keys', 'map'],
    properties: [
      {
        displayName: 'Keys',
        name: 'keys',
        type: 'fixedCollection',
        default: { key: [] },
        placeholder: 'Add new key',
        typeOptions: { multipleValues: true, sortable: true },
        options: [
          {
            displayName: 'Key',
            name: 'key',
            values: [
              {
                displayName: 'Current Key Name',
                name: 'currentKey',
                type: 'string',
                default: '',
                placeholder: 'user.first_name',
              },
              {
                displayName: 'New Key Name',
                name: 'newKey',
                type: 'string',
                default: '',
                placeholder: 'firstName',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Additional Options',
        name: 'additionalOptions',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Regex Replacement',
            name: 'regexReplacement',
            type: 'fixedCollection',
            default: { replacements: [] },
            typeOptions: { multipleValues: true },
            options: [
              {
                displayName: 'Replacement',
                name: 'replacements',
                values: [
                  {
                    displayName: 'Regular Expression',
                    name: 'searchRegex',
                    type: 'string',
                    default: '',
                    placeholder: '^old_',
                  },
                  {
                    displayName: 'Replace With',
                    name: 'replaceRegex',
                    type: 'string',
                    default: '',
                    placeholder: 'new_',
                  },
                  {
                    displayName: 'Case Insensitive',
                    name: 'caseInsensitive',
                    type: 'boolean',
                    default: false,
                  },
                  {
                    displayName: 'Max Depth',
                    name: 'depth',
                    type: 'number',
                    default: -1,
                    description: '-1 renames keys at every level, 0 only top-level keys',
                  },
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
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        let json = deepCopy(items[i].json);
        const keys = ((ctx.getNodeParameter('keys', i, {}) as DataObject).key ?? []) as Array<{
          currentKey: string;
          newKey: string;
        }>;
        for (const { currentKey, newKey } of keys) {
          if (!currentKey || !newKey || currentKey === newKey) continue;
          const value = getField(json, currentKey);
          if (value === undefined) continue;
          unsetField(json, currentKey);
          setField(json, newKey, value);
        }
        const replacements = ((
          ctx.getNodeParameter('additionalOptions.regexReplacement', i, {}) as DataObject
        ).replacements ?? []) as Array<{
          searchRegex: string;
          replaceRegex: string;
          caseInsensitive?: boolean;
          depth?: number;
        }>;
        for (const r of replacements) {
          if (!r.searchRegex) continue;
          let regex: RegExp;
          try {
            regex = new RegExp(r.searchRegex, r.caseInsensitive ? 'gi' : 'g');
          } catch (error) {
            throw new NodeOperationError(ctx.getNode(), `Invalid regular expression "${r.searchRegex}"`, {
              itemIndex: i,
              description: (error as Error).message,
            });
          }
          json = renameByRegex(json, regex, r.replaceRegex ?? '', Number(r.depth ?? -1)) as DataObject;
        }
        out.push({ ...items[i], json, pairedItem: { item: i } });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        out.push(errorItem(error, i));
      }
    }
    return [out];
  },
};

// ---------------------------------------------------------------------------------------------
// Compare Datasets
// ---------------------------------------------------------------------------------------------

export const CompareDatasetsNode: NodeType = {
  description: {
    name: 'core.compareDatasets',
    displayName: 'Compare Datasets',
    description: 'Compare two inputs and route items to: in A only, same, different, in B only',
    icon: 'lucide:git-compare',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Compare Datasets' },
    inputs: [
      { type: 'main', displayName: 'Input A' },
      { type: 'main', displayName: 'Input B' },
    ],
    outputs: [
      { type: 'main', displayName: 'In A only' },
      { type: 'main', displayName: 'Same' },
      { type: 'main', displayName: 'Different' },
      { type: 'main', displayName: 'In B only' },
    ],
    outputNames: ['In A only', 'Same', 'Different', 'In B only'],
    categories: ['Core', 'Data transformation'],
    alias: ['diff', 'sync', 'reconcile', 'compare', 'changes', 'delta'],
    properties: [
      {
        displayName: 'Fields to Match',
        name: 'mergeByFields',
        type: 'fixedCollection',
        default: { values: [{ field1: '', field2: '' }] },
        placeholder: 'Add fields to match',
        typeOptions: { multipleValues: true },
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              {
                displayName: 'Input A Field',
                name: 'field1',
                type: 'string',
                default: '',
                placeholder: 'id',
              },
              {
                displayName: 'Input B Field',
                name: 'field2',
                type: 'string',
                default: '',
                placeholder: 'id',
              },
            ],
          },
        ],
      },
      {
        displayName: 'When There Are Differences',
        name: 'resolve',
        type: 'options',
        default: 'includeBoth',
        options: [
          {
            name: 'Include Both Versions',
            value: 'includeBoth',
            description: 'Output keys, same and differing fields',
          },
          { name: 'Use Input A Version', value: 'preferInput1' },
          { name: 'Use Input B Version', value: 'preferInput2' },
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
            displayName: 'Fields to Skip Comparing',
            name: 'skipFields',
            type: 'string',
            default: '',
            placeholder: 'updatedAt, etag',
          },
          {
            displayName: 'Fuzzy Compare',
            name: 'fuzzyCompare',
            type: 'boolean',
            default: false,
            description: 'Whether 1 and "1" (and similar) count as the same value',
          },
          dotNotationOption,
        ],
      },
    ],
  },
  async execute(ctx) {
    const a = ctx.getInputData(0) ?? [];
    const b = ctx.getInputData(1) ?? [];
    const dots = dotNotation(ctx);
    const pairs = (
      ((ctx.getNodeParameter('mergeByFields', 0, {}) as DataObject).values ?? []) as Array<{
        field1: string;
        field2: string;
      }>
    ).filter((p) => p.field1 && p.field2);
    if (!pairs.length)
      throw new NodeOperationError(ctx.getNode(), 'Add at least one pair of fields to match');
    const resolve = ctx.getNodeParameter('resolve', 0, 'includeBoth') as string;
    const fuzzy = ctx.getNodeParameter('options.fuzzyCompare', 0, false) as boolean;
    const skip = new Set(fieldList(ctx.getNodeParameter('options.skipFields', 0, '')));
    const equal = (x: unknown, y: unknown) => (fuzzy ? looseEqual(x, y) : deepEqual(x, y));

    const keyB = new Map<string, number[]>();
    const keyOf = (item: Item, side: 'field1' | 'field2') =>
      pairs.map((p) => {
        const v = getField(item.json, p[side], dots);
        return fuzzy && v !== undefined && v !== null && typeof v !== 'object'
          ? String(v).trim().toLowerCase()
          : v;
      });
    b.forEach((item, j) => {
      const key = stableStringify(keyOf(item, 'field2'));
      keyB.set(key, [...(keyB.get(key) ?? []), j]);
    });

    const onlyA: Item[] = [];
    const same: Item[] = [];
    const different: Item[] = [];
    const usedB = new Set<number>();

    a.forEach((itemA, i) => {
      const key = keyOf(itemA, 'field1');
      const candidates = key.some((v) => v === undefined)
        ? []
        : (keyB.get(stableStringify(key)) ?? []).filter((j) => !usedB.has(j));
      if (!candidates.length) {
        onlyA.push({ ...itemA, pairedItem: { item: i, input: 0 } });
        return;
      }
      const j = candidates[0];
      usedB.add(j);
      const itemB = b[j];
      const fields = new Set([...Object.keys(itemA.json), ...Object.keys(itemB.json)]);
      const differences: DataObject = {};
      const sameFields: DataObject = {};
      for (const field of fields) {
        if (skip.has(field)) continue;
        const va = itemA.json[field];
        const vb = itemB.json[field];
        if (equal(va, vb)) sameFields[field] = deepCopy(va);
        else differences[field] = { inputA: deepCopy(va) ?? null, inputB: deepCopy(vb) ?? null };
      }
      const pairedItem: PairedItem[] = [
        { item: i, input: 0 },
        { item: j, input: 1 },
      ];
      if (!Object.keys(differences).length) {
        same.push({ json: deepCopy(itemA.json), pairedItem });
        return;
      }
      if (resolve === 'preferInput1') different.push({ json: deepCopy(itemA.json), pairedItem });
      else if (resolve === 'preferInput2') different.push({ json: deepCopy(itemB.json), pairedItem });
      else {
        const keys: DataObject = {};
        pairs.forEach((p) => {
          keys[p.field1] = deepCopy(getField(itemA.json, p.field1, dots));
        });
        different.push({ json: { keys, same: sameFields, different: differences }, pairedItem });
      }
    });

    const onlyB = b.flatMap((item, j) =>
      usedB.has(j) ? [] : [{ ...item, pairedItem: { item: j, input: 1 } }],
    );
    return [onlyA, same, different, onlyB];
  },
};
