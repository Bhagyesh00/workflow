/** The filter of one column, with the conditions of its type (P4-05). Dates are entered in UTC. */
import type { DataTableColumnType, DataTableFilterClause } from '@workflow/workflow';
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormField, Select, TextInput } from '../ui/Field';

export interface ColumnFilterValue {
  condition: string;
  /** what was typed, kept so the dialog reopens with it */
  value?: string;
  to?: string;
  clauses: DataTableFilterClause[];
}

interface ConditionOption {
  id: string;
  label: string;
  /** how many values it takes */
  inputs: 0 | 1 | 2;
  build: (column: string, from: string | number, to: string | number) => DataTableFilterClause[];
}

const one =
  (condition: DataTableFilterClause['condition']) =>
  (columnName: string, value: string | number): DataTableFilterClause[] => [
    { columnName, condition, value },
  ];
const between = (columnName: string, from: string | number, to: string | number): DataTableFilterClause[] => [
  { columnName, condition: 'gte', value: from },
  { columnName, condition: 'lte', value: to },
];
const IS_NULL: ConditionOption = {
  id: 'isNull',
  label: 'Is null',
  inputs: 0,
  build: (columnName) => [{ columnName, condition: 'eq', value: null }],
};
const IS_NOT_NULL: ConditionOption = {
  id: 'isNotNull',
  label: 'Is not null',
  inputs: 0,
  build: (columnName) => [{ columnName, condition: 'neq', value: null }],
};

const TEXT: ConditionOption[] = [
  { id: 'contains', label: 'Contains', inputs: 1, build: one('ilike') },
  { id: 'equals', label: 'Equals', inputs: 1, build: one('eq') },
  { id: 'notEquals', label: 'Does not equal', inputs: 1, build: one('neq') },
  {
    id: 'isEmpty',
    label: 'Is empty',
    inputs: 0,
    build: (columnName) => [{ columnName, condition: 'isEmpty' }],
  },
  {
    id: 'isNotEmpty',
    label: 'Is not empty',
    inputs: 0,
    build: (columnName) => [{ columnName, condition: 'isNotEmpty' }],
  },
  IS_NULL,
  IS_NOT_NULL,
];

const NUMBER: ConditionOption[] = [
  { id: 'equals', label: 'Equals', inputs: 1, build: one('eq') },
  { id: 'notEquals', label: 'Does not equal', inputs: 1, build: one('neq') },
  { id: 'gt', label: 'Greater than', inputs: 1, build: one('gt') },
  { id: 'gte', label: 'Greater than or equal', inputs: 1, build: one('gte') },
  { id: 'lt', label: 'Less than', inputs: 1, build: one('lt') },
  { id: 'lte', label: 'Less than or equal', inputs: 1, build: one('lte') },
  { id: 'between', label: 'Between', inputs: 2, build: between },
  IS_NULL,
  IS_NOT_NULL,
];

const DATE: ConditionOption[] = [
  { id: 'equals', label: 'On', inputs: 1, build: one('eq') },
  { id: 'notEquals', label: 'Not on', inputs: 1, build: one('neq') },
  { id: 'gt', label: 'After', inputs: 1, build: one('gt') },
  { id: 'gte', label: 'On or after', inputs: 1, build: one('gte') },
  { id: 'lt', label: 'Before', inputs: 1, build: one('lt') },
  { id: 'lte', label: 'On or before', inputs: 1, build: one('lte') },
  { id: 'between', label: 'Between', inputs: 2, build: between },
  IS_NULL,
  IS_NOT_NULL,
];

const BOOLEAN: ConditionOption[] = [
  {
    id: 'true',
    label: 'Is true',
    inputs: 0,
    build: (columnName) => [{ columnName, condition: 'eq', value: true }],
  },
  {
    id: 'false',
    label: 'Is false',
    inputs: 0,
    build: (columnName) => [{ columnName, condition: 'eq', value: false }],
  },
  IS_NULL,
  IS_NOT_NULL,
];

const OPTIONS: Record<DataTableColumnType, ConditionOption[]> = {
  string: TEXT,
  number: NUMBER,
  date: DATE,
  boolean: BOOLEAN,
};

/** the short text of a filter chip */
export function filterSummary(type: DataTableColumnType, filter: ColumnFilterValue): string {
  const option = OPTIONS[type].find((o) => o.id === filter.condition);
  const label = (option?.label ?? filter.condition).toLowerCase();
  if (option?.inputs === 2) return `${label} ${filter.value} and ${filter.to}`;
  return option?.inputs === 1 ? `${label} ${filter.value}` : label;
}

export function ColumnFilter({
  column,
  type,
  current,
  onApply,
  onClear,
  onClose,
}: {
  column: string;
  type: DataTableColumnType;
  current?: ColumnFilterValue;
  onApply: (filter: ColumnFilterValue) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const options = OPTIONS[type];
  const [conditionId, setConditionId] = useState(current?.condition ?? options[0].id);
  const [value, setValue] = useState(current?.value ?? '');
  const [to, setTo] = useState(current?.to ?? '');
  const [error, setError] = useState<string | null>(null);
  const option = options.find((o) => o.id === conditionId) ?? options[0];

  /** the value to send, or undefined when it is not one */
  const parse = (text: string): string | number | undefined => {
    if (type === 'string') return text;
    if (!text.trim()) return undefined;
    if (type === 'number') {
      const number = Number(text);
      return Number.isFinite(number) ? number : undefined;
    }
    const date = new Date(`${text}Z`);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };

  const apply = () => {
    const from = option.inputs >= 1 ? parse(value) : '';
    const until = option.inputs === 2 ? parse(to) : '';
    if (from === undefined || until === undefined) {
      setError(type === 'number' ? 'Enter a number' : 'Enter a date');
      return;
    }
    onApply({
      condition: option.id,
      value: option.inputs >= 1 ? value : undefined,
      to: option.inputs === 2 ? to : undefined,
      clauses: option.build(column, from, until),
    });
  };

  const input = (label: string, text: string, set: (next: string) => void) => (
    <FormField label={label} error={error}>
      {(id) => (
        <TextInput
          id={id}
          type={type === 'date' ? 'datetime-local' : 'text'}
          step={type === 'date' ? 1 : undefined}
          inputMode={type === 'number' ? 'decimal' : undefined}
          value={text}
          onChange={(event) => {
            set(event.target.value);
            setError(null);
          }}
        />
      )}
    </FormField>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Filter ${column}`}
      description={type === 'date' ? 'Dates are in UTC.' : undefined}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClear}>
            Clear filter
          </Button>
          <Button variant="primary" type="submit" form="data-table-column-filter">
            Apply
          </Button>
        </>
      }
    >
      <form
        id="data-table-column-filter"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <FormField label="Condition">
          {(id) => (
            <Select
              id={id}
              value={option.id}
              onChange={(event) => {
                setConditionId(event.target.value);
                setError(null);
              }}
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {option.inputs === 1 && input('Value', value, setValue)}
        {option.inputs === 2 && (
          <>
            {input('From', value, setValue)}
            {input('To', to, setTo)}
          </>
        )}
      </form>
    </Dialog>
  );
}
