/**
 * Loads the fields of a `resourceMapper` parameter (POST /node-types/options, kind resourceMapping)
 * and keeps the stored value in step with them. Pure helpers are exported for the control and tests.
 */
import { useQuery } from '@tanstack/react-query';
import {
  type NodeProperty,
  type ResourceMapperField,
  type ResourceMapperFields,
  type ResourceMapperValue,
  resolveNodeParameters,
} from '@workflow/workflow';
import { useMemo } from 'react';
import { errorMessage } from '../../../api/client';
import { nodeTypesApi } from '../../../api/endpoints';
import { getIn } from '../../../lib/workflow-ops';
import { useWorkflowStore } from '../../../stores/workflow-store';
import { useParameterContext } from '../context';

export function emptyMapperValue(): ResourceMapperValue {
  return {
    mappingMode: 'defineBelow',
    value: null,
    matchingColumns: [],
    schema: [],
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  };
}

/** a stored value of any shape, as a complete `ResourceMapperValue` */
export function normalizeMapperValue(value: unknown): ResourceMapperValue {
  const base = emptyMapperValue();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return base;
  const v = value as Partial<ResourceMapperValue>;
  const record = v.value !== null && typeof v.value === 'object' && !Array.isArray(v.value);
  return {
    mappingMode: v.mappingMode === 'autoMapInputData' ? 'autoMapInputData' : 'defineBelow',
    value: record ? (v.value as Record<string, unknown>) : null,
    matchingColumns: Array.isArray(v.matchingColumns)
      ? v.matchingColumns.filter((c): c is string => typeof c === 'string')
      : [],
    schema: Array.isArray(v.schema) ? v.schema : [],
    attemptToConvertTypes: v.attemptToConvertTypes === true,
    convertFieldsToString: v.convertFieldsToString === true,
  };
}

/** loaded fields as the new schema: the definition is the loaded one, `removed` is what the user chose */
export function mergeSchema(
  loaded: ResourceMapperField[],
  stored: ResourceMapperField[],
): ResourceMapperField[] {
  const removed = new Set(stored.filter((f) => f.removed).map((f) => f.id));
  return loaded.map((field) => {
    const { removed: _drop, ...rest } = field;
    return removed.has(field.id) && !field.required ? { ...rest, removed: true } : rest;
  });
}

export function canMatch(field: ResourceMapperField): boolean {
  return field.canBeUsedToMatch !== false && field.display;
}

/** the value after a load: schema merged, and the default match columns chosen on the first load */
export function syncWithFields(
  value: ResourceMapperValue,
  loaded: ResourceMapperField[],
  mode: string,
): ResourceMapperValue {
  const schema = mergeSchema(loaded, value.schema);
  const wantsMatch = mode === 'update' || mode === 'upsert';
  const first = value.schema.length === 0;
  const known = new Set(schema.map((f) => f.id));
  // columns of another table or list are not columns of this one
  const kept = value.matchingColumns.filter((c) => schema.some((f) => f.id === c && canMatch(f)));
  const pruned = kept.length !== value.matchingColumns.length;
  const matchingColumns =
    wantsMatch && kept.length === 0 && (first || pruned)
      ? schema.filter((f) => f.defaultMatch && canMatch(f)).map((f) => f.id)
      : kept;
  const entries = value.value ? Object.entries(value.value).filter(([key]) => known.has(key)) : null;
  const dropped = value.value !== null && entries !== null && entries.length !== Object.keys(value.value).length;
  return {
    ...value,
    schema,
    matchingColumns,
    value: dropped && entries ? Object.fromEntries(entries) : value.value,
  };
}

export function sameSync(a: ResourceMapperValue, b: ResourceMapperValue): boolean {
  return (
    JSON.stringify([a.schema, a.matchingColumns, a.value]) ===
    JSON.stringify([b.schema, b.matchingColumns, b.value])
  );
}

export interface MapperFieldsState {
  data: ResourceMapperFields | undefined;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useMapperFields(prop: NodeProperty): MapperFieldsState {
  const ctx = useParameterContext();
  const method = prop.typeOptions?.resourceMapper?.resourceMapperMethod;
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const dependsOn = (prop.typeOptions?.loadOptionsDependsOn ?? []).map((path) =>
    getIn(ctx.rootValues, path.replace(/^\//, '').split('.')),
  );
  const parameters = useMemo(
    () =>
      ctx.description
        ? resolveNodeParameters(ctx.description.properties, ctx.node.parameters, {
            nodeVersion: ctx.node.typeVersion,
          })
        : ctx.node.parameters,
    [ctx.description, ctx.node.parameters, ctx.node.typeVersion],
  );
  const query = useQuery({
    queryKey: [
      'resource-mapping',
      workflowId,
      ctx.node.type,
      method,
      ctx.node.name,
      JSON.stringify(dependsOn),
      JSON.stringify(ctx.node.credentials ?? {}),
    ],
    enabled: Boolean(method && ctx.description),
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      nodeTypesApi.resourceMapping({
        nodeType: ctx.node.type,
        method: method as string,
        kind: 'resourceMapping',
        node: { ...ctx.node, parameters },
        workflowId,
      }),
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => void query.refetch(),
  };
}
