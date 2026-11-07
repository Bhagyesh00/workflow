/**
 * The `resourceMapper` parameter: fields loaded through `methods.resourceMapping`, one row per
 * mapped field. The value is a `ResourceMapperValue`; fields the user removes stay in `schema`
 * as `removed`. The props are final: ParameterForm renders this and no lane edits that file.
 */
import type { NodeProperty, ResourceMapperField, ResourceMapperValue } from '@workflow/workflow';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import type { ParameterPath } from '../../lib/workflow-ops';
import { Button, IconButton } from '../ui/Button';
import { Select, Switch } from '../ui/Field';
import { Callout } from '../ui/misc';
import { useParameterContext } from './context';
import { FieldRow } from './resource-mapper/FieldRow';
import { MatchingColumns } from './resource-mapper/MatchingColumns';
import {
  canMatch,
  mergeSchema,
  normalizeMapperValue,
  sameSync,
  syncWithFields,
  useMapperFields,
} from './resource-mapper/useMapperFields';

export interface ResourceMapperInputProps {
  prop: NodeProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  id: string;
  path: ParameterPath;
}

const hasValue = (values: Record<string, unknown> | null, id: string) =>
  values !== null && Object.hasOwn(values, id);

export function ResourceMapperInput({ prop, value, onChange, id, path }: ResourceMapperInputProps): ReactElement {
  const ctx = useParameterContext();
  const options = prop.typeOptions?.resourceMapper;
  const mode = options?.mode ?? 'add';
  const words = options?.fieldWords ?? { singular: 'column', plural: 'columns' };
  const current = normalizeMapperValue(value);
  const { data, isLoading, error, refetch } = useMapperFields(prop);

  // the loaded fields become the stored schema; `removed` and the matching columns stay as chosen
  useEffect(() => {
    if (!data || ctx.readOnly) return;
    const next = syncWithFields(current, data.fields, mode);
    if (!sameSync(current, next)) onChange(next);
  });

  const schema: ResourceMapperField[] = data ? mergeSchema(data.fields, current.schema) : current.schema;
  const values = current.value;
  const matching = mode === 'update' || mode === 'upsert' ? current.matchingColumns : [];
  const shown = schema.filter(
    (f) =>
      f.display && !f.removed && (f.required || matching.includes(f.id) || hasValue(values, f.id)),
  );
  const addable = schema.filter((f) => f.display && !f.removed && !shown.includes(f));
  const removed = schema.filter((f) => f.display && f.removed);
  const matchable = schema.filter((f) => canMatch(f) && !f.removed);

  const save = (patch: Partial<ResourceMapperValue>) => onChange({ ...current, schema, ...patch });
  const setField = (fieldId: string, next: unknown) =>
    save({ value: { ...(values ?? {}), [fieldId]: next } });
  const setRemoved = (fieldIds: string[], flag: boolean) =>
    schema.map((f) => {
      if (!fieldIds.includes(f.id)) return f;
      const { removed: _drop, ...rest } = f;
      return flag ? { ...rest, removed: true } : rest;
    });
  const removeField = (fieldId: string) => {
    const { [fieldId]: _gone, ...rest } = values ?? {};
    save({
      value: rest,
      schema: setRemoved([fieldId], true),
      matchingColumns: current.matchingColumns.filter((c) => c !== fieldId),
    });
  };
  const addFields = (fieldIds: string[], restore = false) => {
    const next = { ...(values ?? {}) };
    for (const fieldId of fieldIds) if (!hasValue(next, fieldId)) next[fieldId] = null;
    save({ value: next, ...(restore ? { schema: setRemoved(fieldIds, false) } : {}) });
  };

  const supportAutoMap = options?.supportAutoMap === true;
  const auto = supportAutoMap && current.mappingMode === 'autoMapInputData';
  const readOnly = ctx.readOnly;
  const emptyLoaded = Boolean(data) && schema.every((f) => !f.display);

  return (
    <div className="space-y-3 rounded-lg border border-line p-3" data-resource-mapper>
      <div className="flex items-end gap-2">
        {supportAutoMap ? (
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor={`${id}-mode`} className="text-xs font-semibold text-ink-2">
              Mapping {words.singular} mode
            </label>
            <Select
              id={`${id}-mode`}
              aria-label={`Mapping ${words.singular} mode`}
              value={auto ? 'autoMapInputData' : 'defineBelow'}
              disabled={readOnly}
              onChange={(e) =>
                save(
                  e.target.value === 'autoMapInputData'
                    ? { mappingMode: 'autoMapInputData', value: null }
                    : { mappingMode: 'defineBelow' },
                )
              }
            >
              <option value="defineBelow">Map each {words.singular} manually</option>
              <option value="autoMapInputData">Map automatically</option>
            </Select>
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <IconButton label={`Refresh ${words.plural}`} onClick={refetch} disabled={!options}>
          <RefreshCw size={14} className={isLoading ? 'wf-spinner' : undefined} />
        </IconButton>
      </div>

      {!options && (
        <Callout tone="warn">This parameter has no resource mapper settings.</Callout>
      )}
      {isLoading && <p className="text-xs text-ink-3">Loading {words.plural}…</p>}
      {error && (
        <Callout tone="err" title={`Could not load ${words.plural}`}>
          {error}
        </Callout>
      )}
      {emptyLoaded && (
        <Callout tone="warn" title={options?.noFieldsError ?? `No ${words.plural} found`}>
          {data?.emptyFieldsNotice}
        </Callout>
      )}

      {!emptyLoaded && matchable.length > 0 && (mode === 'update' || mode === 'upsert') && (
        <MatchingColumns
          id={`${id}-match`}
          fields={matchable}
          selected={current.matchingColumns}
          multiKeyMatch={options?.multiKeyMatch === true}
          singular={words.singular}
          plural={words.plural}
          readOnly={readOnly}
          onChange={(matchingColumns) => save({ matchingColumns })}
        />
      )}

      {auto ? (
        <Callout tone="info">The {words.plural} are taken from the input data.</Callout>
      ) : (
        shown.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-ink-2">{options?.valuesLabel ?? 'Values to send'}</p>
            {shown.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                id={`${id}-${field.id}`}
                value={values?.[field.id] ?? null}
                path={[...path, 'value', field.id]}
                isMatch={matching.includes(field.id)}
                onChange={(next) => setField(field.id, next)}
                onRemove={field.required || matching.includes(field.id) ? undefined : () => removeField(field.id)}
              />
            ))}
          </div>
        )
      )}

      {!auto && !readOnly && addable.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            aria-label={`Add ${words.singular}`}
            className="flex-1"
            value=""
            onChange={(e) => e.target.value && addFields([e.target.value])}
          >
            <option value="">Add {words.singular}…</option>
            {addable.map((f) => (
              <option key={f.id} value={f.id}>
                {f.displayName}
              </option>
            ))}
          </Select>
          {options?.addAllFields && (
            <Button size="sm" onClick={() => addFields(schema.filter((f) => f.display && !f.removed).map((f) => f.id))}>
              Add all {words.plural}
            </Button>
          )}
        </div>
      )}

      {!auto && removed.length > 0 && (
        <div className="space-y-1" data-mapper-removed>
          <p className="text-xs font-semibold text-ink-3">Removed {words.plural}</p>
          <ul className="space-y-1">
            {removed.map((f) => (
              <li key={f.id} className="flex items-center gap-2 text-sm text-ink-3 line-through">
                <span className="min-w-0 flex-1 truncate">{f.displayName}</span>
                {!readOnly && (
                  <IconButton label={`Restore ${f.displayName}`} size="sm" onClick={() => addFields([f.id], true)}>
                    <RotateCcw size={12} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Attempt to convert types</span>
          <Switch
            label="Attempt to convert types"
            size="sm"
            checked={current.attemptToConvertTypes}
            disabled={readOnly}
            onChange={(attemptToConvertTypes) => save({ attemptToConvertTypes })}
          />
        </div>
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Convert all fields to string</span>
          <Switch
            label="Convert all fields to string"
            size="sm"
            checked={current.convertFieldsToString}
            disabled={readOnly}
            onChange={(convertFieldsToString) => save({ convertFieldsToString })}
          />
        </div>
      </div>
    </div>
  );
}
