/**
 * Condition builder for `filter` parameters (IF / Filter / Switch): left value, operator picked by
 * data type (single-value operators hide the right value), right value, AND/OR combinator and options.
 */
import type { FilterCondition, FilterOperation, FilterOperatorType, FilterValue } from '@workflow/workflow';
import { Plus, Trash2 } from 'lucide-react';
import { newId } from '../../lib/ids';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { Checkbox, Select } from '../ui/Field';
import { useParameterContext } from './context';
import { SmartInput } from './ExpressionInput';
import type { InputProps } from './inputs';

export interface OperatorDef {
  type: FilterOperatorType;
  operation: FilterOperation;
  label: string;
  singleValue?: boolean;
}

const common = (type: FilterOperatorType): OperatorDef[] => [
  { type, operation: 'exists', label: 'exists', singleValue: true },
  { type, operation: 'notExists', label: 'does not exist', singleValue: true },
  { type, operation: 'empty', label: 'is empty', singleValue: true },
  { type, operation: 'notEmpty', label: 'is not empty', singleValue: true },
];

export const FILTER_OPERATORS: Record<FilterOperatorType, OperatorDef[]> = {
  string: [
    ...common('string'),
    { type: 'string', operation: 'equals', label: 'is equal to' },
    { type: 'string', operation: 'notEquals', label: 'is not equal to' },
    { type: 'string', operation: 'contains', label: 'contains' },
    { type: 'string', operation: 'notContains', label: 'does not contain' },
    { type: 'string', operation: 'startsWith', label: 'starts with' },
    { type: 'string', operation: 'notStartsWith', label: 'does not start with' },
    { type: 'string', operation: 'endsWith', label: 'ends with' },
    { type: 'string', operation: 'notEndsWith', label: 'does not end with' },
    { type: 'string', operation: 'regex', label: 'matches regex' },
    { type: 'string', operation: 'notRegex', label: 'does not match regex' },
  ],
  number: [
    ...common('number'),
    { type: 'number', operation: 'equals', label: 'is equal to' },
    { type: 'number', operation: 'notEquals', label: 'is not equal to' },
    { type: 'number', operation: 'gt', label: 'is greater than' },
    { type: 'number', operation: 'lt', label: 'is less than' },
    { type: 'number', operation: 'gte', label: 'is greater than or equal to' },
    { type: 'number', operation: 'lte', label: 'is less than or equal to' },
  ],
  dateTime: [
    ...common('dateTime'),
    { type: 'dateTime', operation: 'equals', label: 'is equal to' },
    { type: 'dateTime', operation: 'notEquals', label: 'is not equal to' },
    { type: 'dateTime', operation: 'after', label: 'is after' },
    { type: 'dateTime', operation: 'before', label: 'is before' },
    { type: 'dateTime', operation: 'afterOrEquals', label: 'is after or equal to' },
    { type: 'dateTime', operation: 'beforeOrEquals', label: 'is before or equal to' },
  ],
  boolean: [
    ...common('boolean'),
    { type: 'boolean', operation: 'true', label: 'is true', singleValue: true },
    { type: 'boolean', operation: 'false', label: 'is false', singleValue: true },
    { type: 'boolean', operation: 'equals', label: 'is equal to' },
    { type: 'boolean', operation: 'notEquals', label: 'is not equal to' },
  ],
  array: [
    ...common('array'),
    { type: 'array', operation: 'contains', label: 'contains' },
    { type: 'array', operation: 'notContains', label: 'does not contain' },
    { type: 'array', operation: 'lengthEquals', label: 'length equal to' },
    { type: 'array', operation: 'lengthNotEquals', label: 'length not equal to' },
    { type: 'array', operation: 'lengthGt', label: 'length greater than' },
    { type: 'array', operation: 'lengthLt', label: 'length less than' },
    { type: 'array', operation: 'lengthGte', label: 'length greater than or equal to' },
    { type: 'array', operation: 'lengthLte', label: 'length less than or equal to' },
  ],
  object: common('object'),
  any: common('any'),
};

const TYPE_LABELS: Record<FilterOperatorType, string> = {
  string: 'String',
  number: 'Number',
  dateTime: 'Date & time',
  boolean: 'Boolean',
  array: 'Array',
  object: 'Object',
  any: 'Any',
};

const TYPE_ORDER: FilterOperatorType[] = ['string', 'number', 'dateTime', 'boolean', 'array', 'object'];

export function findOperator(type: FilterOperatorType, operation: FilterOperation): OperatorDef | undefined {
  return FILTER_OPERATORS[type]?.find((o) => o.operation === operation);
}

export function operatorKey(o: { type: FilterOperatorType; operation: FilterOperation }): string {
  return `${o.type}:${o.operation}`;
}

export function emptyCondition(): FilterCondition {
  return { id: newId(), leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } };
}

export function normalizeFilter(value: unknown): FilterValue {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<FilterValue>;
  return {
    conditions: Array.isArray(v.conditions) && v.conditions.length ? v.conditions : [emptyCondition()],
    combinator: v.combinator === 'or' ? 'or' : 'and',
    options: v.options ?? { caseSensitive: true, typeValidation: 'strict' },
  };
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
  canRemove,
  index,
}: {
  condition: FilterCondition;
  onChange: (c: FilterCondition) => void;
  onRemove: () => void;
  canRemove: boolean;
  index: number;
}) {
  const ctx = useParameterContext();
  const operator = findOperator(condition.operator.type, condition.operator.operation);
  const single = operator?.singleValue ?? condition.operator.singleValue ?? false;
  return (
    <div className="flex items-start gap-1.5" data-testid="filter-condition">
      <div className="grid min-w-0 flex-1 grid-cols-1 gap-1.5 @md:grid-cols-[1fr_auto_1fr]">
        <SmartInput
          value={condition.leftValue}
          onChange={(v) => onChange({ ...condition, leftValue: v })}
          ariaLabel={`Condition ${index + 1} value 1`}
          placeholder="value1"
        />
        <Select
          aria-label={`Condition ${index + 1} operator`}
          className="@md:w-52"
          value={operatorKey(condition.operator)}
          disabled={ctx.readOnly}
          onChange={(e) => {
            const [type, operation] = e.target.value.split(':') as [FilterOperatorType, FilterOperation];
            const def = findOperator(type, operation);
            onChange({
              ...condition,
              operator: { type, operation, ...(def?.singleValue ? { singleValue: true } : {}) },
              rightValue: def?.singleValue ? undefined : (condition.rightValue ?? ''),
            });
          }}
        >
          {TYPE_ORDER.map((type) => (
            <optgroup key={type} label={TYPE_LABELS[type]}>
              {FILTER_OPERATORS[type].map((o) => (
                <option key={operatorKey(o)} value={operatorKey(o)}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        {!single && (
          <SmartInput
            value={condition.rightValue}
            onChange={(v) => onChange({ ...condition, rightValue: v })}
            ariaLabel={`Condition ${index + 1} value 2`}
            placeholder="value2"
          />
        )}
      </div>
      {canRemove && !ctx.readOnly && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove condition ${index + 1}`}
          className="mt-1 grid size-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-err"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

export function FilterInput({ prop, value, onChange }: InputProps) {
  const ctx = useParameterContext();
  const filter = normalizeFilter(value);
  const update = (patch: Partial<FilterValue>) => onChange({ ...filter, ...patch });
  return (
    <fieldset
      className="@container flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-2.5"
      aria-label={prop.displayName}
    >
      {filter.conditions.map((condition, index) => (
        <div key={condition.id} className="flex flex-col gap-2">
          {index > 0 && (
            <div className="flex items-center gap-2">
              <span className="h-px flex-1 bg-line" />
              <button
                type="button"
                disabled={ctx.readOnly}
                onClick={() => update({ combinator: filter.combinator === 'and' ? 'or' : 'and' })}
                aria-label={`Combine conditions with ${filter.combinator === 'and' ? 'OR' : 'AND'}`}
                className={cx(
                  'rounded-full border px-2.5 py-0.5 text-2xs font-bold',
                  filter.combinator === 'and'
                    ? 'border-brand-line bg-brand-soft text-brand'
                    : 'border-warn/40 bg-warn-soft text-warn',
                )}
              >
                {filter.combinator === 'and' ? 'AND' : 'OR'}
              </button>
              <span className="h-px flex-1 bg-line" />
            </div>
          )}
          <ConditionRow
            index={index}
            condition={condition}
            canRemove={filter.conditions.length > 1}
            onChange={(c) => update({ conditions: filter.conditions.map((x) => (x.id === c.id ? c : x)) })}
            onRemove={() => update({ conditions: filter.conditions.filter((x) => x.id !== condition.id) })}
          />
        </div>
      ))}
      {!ctx.readOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={13} />}
            onClick={() => update({ conditions: [...filter.conditions, emptyCondition()] })}
          >
            Add condition
          </Button>
          <Checkbox
            label="Case sensitive"
            checked={filter.options?.caseSensitive !== false}
            onChange={(e) => update({ options: { ...filter.options, caseSensitive: e.target.checked } })}
          />
          <Checkbox
            label="Convert types where needed"
            checked={filter.options?.typeValidation === 'loose'}
            onChange={(e) =>
              update({
                options: { ...filter.options, typeValidation: e.target.checked ? 'loose' : 'strict' },
              })
            }
          />
        </div>
      )}
    </fieldset>
  );
}
