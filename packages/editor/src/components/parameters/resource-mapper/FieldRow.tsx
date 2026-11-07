/** One field of the resource mapper: a type-aware input, the expression toggle and the remove button. */
import type { NodeProperty, ResourceMapperField } from '@workflow/workflow';
import { Braces, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ParameterPath } from '../../../lib/workflow-ops';
import { IconButton } from '../../ui/Button';
import { Select, Switch } from '../../ui/Field';
import { isExpressionValue, useParameterContext } from '../context';
import { ExpressionInput } from '../ExpressionInput';
import { FromAiOverride } from '../FromAiOverride';

const PROPERTY_TYPE: Record<NonNullable<ResourceMapperField['type']>, NodeProperty['type']> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  dateTime: 'dateTime',
  array: 'json',
  object: 'json',
  options: 'options',
};

/** the field as a parameter, which is what the model-fill override works on */
export function fieldProperty(field: ResourceMapperField): NodeProperty {
  return {
    displayName: field.displayName,
    name: field.id,
    type: PROPERTY_TYPE[field.type ?? 'string'],
    default: '',
    ...(field.options ? { options: field.options } : {}),
  };
}

function JsonField({
  id,
  label,
  value,
  readOnly,
  onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}) {
  const text =
    typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  return (
    <textarea
      id={id}
      aria-label={label}
      className="wf-field font-mono text-xs"
      rows={2}
      value={draft}
      readOnly={readOnly}
      onChange={(e) => {
        setDraft(e.target.value);
        try {
          onChange(JSON.parse(e.target.value));
        } catch {
          onChange(e.target.value);
        }
      }}
    />
  );
}

function FixedInput({
  field,
  id,
  value,
  readOnly,
  onChange,
}: {
  field: ResourceMapperField;
  id: string;
  value: unknown;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = field.displayName;
  const disabled = readOnly || field.readOnly === true;
  switch (field.type) {
    case 'boolean':
      return (
        <Switch id={id} label={label} checked={value === true} disabled={disabled} onChange={onChange} />
      );
    case 'number':
      return (
        <input
          id={id}
          aria-label={label}
          className="wf-field"
          type="number"
          value={typeof value === 'number' || typeof value === 'string' ? value : ''}
          readOnly={disabled}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'dateTime':
      return (
        <input
          id={id}
          aria-label={label}
          className="wf-field"
          type="datetime-local"
          value={typeof value === 'string' ? value : ''}
          readOnly={disabled}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'options': {
      const options = field.options ?? [];
      const index = options.findIndex((o) => o.value === value);
      return (
        <Select
          id={id}
          aria-label={label}
          value={index >= 0 ? String(index) : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? null : options[Number(e.target.value)]?.value)}
        >
          <option value="">Choose…</option>
          {options.map((o, i) => (
            <option key={`${String(o.value)}-${o.name}`} value={String(i)}>
              {o.name}
            </option>
          ))}
        </Select>
      );
    }
    case 'array':
    case 'object':
      return <JsonField id={id} label={label} value={value} readOnly={disabled} onChange={onChange} />;
    default:
      return (
        <input
          id={id}
          aria-label={label}
          className="wf-field"
          value={value === null || value === undefined ? '' : String(value)}
          readOnly={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export interface FieldRowProps {
  field: ResourceMapperField;
  id: string;
  value: unknown;
  /** path of this field's value inside the node parameters */
  path: ParameterPath;
  onChange: (value: unknown) => void;
  /** left out for a required field and for a matching column */
  onRemove?: () => void;
  isMatch?: boolean;
}

export function FieldRow({ field, id, value, path, onChange, onRemove, isMatch }: FieldRowProps) {
  const ctx = useParameterContext();
  const expression = isExpressionValue(value);
  const toggleLabel = expression
    ? `Use a fixed value for ${field.displayName}`
    : `Use an expression for ${field.displayName}`;
  const prop = fieldProperty(field);
  return (
    <div className="space-y-1" data-mapper-field={field.id}>
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="min-w-0 flex-1 truncate text-xs font-semibold text-ink-2">
          {field.displayName}
          {field.required && <span className="text-err"> *</span>}
          {isMatch && <span className="ml-1 font-normal text-ink-3">(match)</span>}
          {field.readOnly && <span className="ml-1 font-normal text-ink-3">(read only)</span>}
        </label>
        {ctx.allowExpressions && !ctx.readOnly && (
          <IconButton
            label={toggleLabel}
            size="sm"
            active={expression}
            onClick={() =>
              onChange(
                isExpressionValue(value)
                  ? value.slice(1)
                  : `=${value === null || value === undefined ? '' : String(value)}`,
              )
            }
          >
            <Braces size={12} />
          </IconButton>
        )}
        {onRemove && !ctx.readOnly && (
          <IconButton label={`Remove ${field.displayName}`} size="sm" onClick={onRemove}>
            <X size={12} />
          </IconButton>
        )}
      </div>
      <FromAiOverride prop={prop} value={value} path={path} onChange={onChange}>
        {isExpressionValue(value) ? (
          <ExpressionInput value={value} onChange={onChange} ariaLabel={field.displayName} />
        ) : (
          <FixedInput field={field} id={id} value={value} readOnly={ctx.readOnly} onChange={onChange} />
        )}
      </FromAiOverride>
    </div>
  );
}
