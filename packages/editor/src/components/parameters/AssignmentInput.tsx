/**
 * Field assignments for `assignmentCollection` parameters (Edit Fields): name / type / value rows.
 * Dropping a field from the input pane adds a row that maps it.
 */
import type { AssignmentCollectionValue, AssignmentValue } from '@workflow/workflow';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { newId } from '../../lib/ids';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { Select } from '../ui/Field';
import { FIELD_DRAG_TYPE, useParameterContext } from './context';
import { SmartInput } from './ExpressionInput';
import type { InputProps } from './inputs';

const TYPES: Array<{ value: AssignmentValue['type']; label: string }> = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'array', label: 'Array' },
  { value: 'object', label: 'Object' },
];

export function normalizeAssignments(value: unknown): AssignmentCollectionValue {
  const v = value as Partial<AssignmentCollectionValue> | undefined;
  return { assignments: Array.isArray(v?.assignments) ? v.assignments : [] };
}

/** `{{ $json.customer.email }}` -> `email` */
export function fieldNameFromExpression(expression: string): string {
  const match = expression.match(/(?:\.([A-Za-z_$][\w$]*)|\["([^"]+)"\])\s*\}\}\s*$/);
  return match?.[1] ?? match?.[2] ?? 'field';
}

export function AssignmentInput({ prop, value, onChange }: InputProps) {
  const ctx = useParameterContext();
  const { assignments } = normalizeAssignments(value);
  const [dragOver, setDragOver] = useState(false);
  const update = (next: AssignmentValue[]) => onChange({ assignments: next });
  const patch = (id: string, change: Partial<AssignmentValue>) =>
    update(assignments.map((a) => (a.id === id ? { ...a, ...change } : a)));

  return (
    <section
      aria-label={prop.displayName}
      className={cx(
        'flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-2.5 transition-colors',
        dragOver && 'border-brand bg-brand-soft',
      )}
      onDragOver={(event) => {
        if (ctx.readOnly || !event.dataTransfer.types.includes(FIELD_DRAG_TYPE)) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        setDragOver(false);
        const dropped = event.dataTransfer.getData(FIELD_DRAG_TYPE);
        if (!dropped || ctx.readOnly) return;
        event.preventDefault();
        update([
          ...assignments,
          { id: newId(), name: fieldNameFromExpression(dropped), value: `=${dropped}`, type: 'string' },
        ]);
      }}
    >
      {assignments.length === 0 && (
        <p className="px-1 py-2 text-center text-sm text-ink-3">
          Drag fields from the input here, or add a field.
        </p>
      )}
      {assignments.map((a, index) => (
        <div key={a.id} className="flex items-start gap-1.5" data-testid="assignment-row">
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_7rem] gap-1.5">
            <input
              className="wf-field"
              aria-label={`Field ${index + 1} name`}
              placeholder="name"
              value={a.name}
              readOnly={ctx.readOnly}
              onChange={(e) => patch(a.id, { name: e.target.value })}
            />
            <Select
              aria-label={`Field ${index + 1} type`}
              value={a.type}
              disabled={ctx.readOnly}
              onChange={(e) => patch(a.id, { type: e.target.value as AssignmentValue['type'] })}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
            <div className="col-span-2">
              <SmartInput
                value={a.value}
                onChange={(v) => patch(a.id, { value: v })}
                ariaLabel={`Field ${index + 1} value`}
                placeholder="value"
              />
            </div>
          </div>
          {!ctx.readOnly && (
            <button
              type="button"
              onClick={() => update(assignments.filter((x) => x.id !== a.id))}
              aria-label={`Remove field ${index + 1}`}
              className="mt-1 grid size-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-err"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
      {!ctx.readOnly && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={13} />}
            onClick={() => update([...assignments, { id: newId(), name: '', value: '', type: 'string' }])}
          >
            Add field
          </Button>
        </div>
      )}
    </section>
  );
}
