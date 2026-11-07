/** "Column(s) to match on": one choice, or several when the node allows a multi-key match. */
import type { ResourceMapperField } from '@workflow/workflow';
import { Checkbox, Select } from '../../ui/Field';

export interface MatchingColumnsProps {
  id: string;
  fields: ResourceMapperField[];
  selected: string[];
  multiKeyMatch: boolean;
  singular: string;
  plural: string;
  readOnly: boolean;
  onChange: (columns: string[]) => void;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function MatchingColumns({
  id,
  fields,
  selected,
  multiKeyMatch,
  singular,
  plural,
  readOnly,
  onChange,
}: MatchingColumnsProps) {
  const label = multiKeyMatch ? `${capital(plural)} to match on` : `${capital(singular)} to match on`;
  return (
    <div className="space-y-1" data-mapper-matching>
      <label htmlFor={id} className="text-xs font-semibold text-ink-2">
        {label}
      </label>
      {multiKeyMatch ? (
        <div id={id} className="space-y-1" role="group" aria-label={label}>
          {fields.map((field) => (
            <Checkbox
              key={field.id}
              label={field.displayName}
              checked={selected.includes(field.id)}
              disabled={readOnly}
              onChange={(e) =>
                onChange(e.target.checked ? [...selected, field.id] : selected.filter((c) => c !== field.id))
              }
            />
          ))}
        </div>
      ) : (
        <Select
          id={id}
          value={selected[0] ?? ''}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        >
          <option value="">Choose…</option>
          {fields.map((field) => (
            <option key={field.id} value={field.id}>
              {field.displayName}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
