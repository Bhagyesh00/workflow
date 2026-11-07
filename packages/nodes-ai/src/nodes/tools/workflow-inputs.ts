/**
 * Call Workflow Tool: the workflow picker and the "Workflow Inputs" mapping.
 * The mapper lists the inputs the called workflow declares on its "When Executed by Another Workflow"
 * node. The tool schema comes from the `$fromAI` calls inside the mapped values; the values the
 * model sends are data and only fill the fields the mapping declares.
 */
import {
  type DataObject,
  extractFromAiArguments,
  fromAiSchema,
  isResourceLocatorValue,
  type JsonSchema,
  type ListSearchResult,
  type LoadOptionsContext,
  type ResourceMapperField,
  type ResourceMapperFields,
  type SupplyDataContext,
} from '@workflow/workflow';
import { QUERY_SCHEMA } from '../../shared/tools';

const TRIGGER_TYPE = 'core.executeWorkflowTrigger';

const NO_INPUTS_NOTICE =
  "The workflow declares no inputs. In its 'When Executed by Another Workflow' node, set Input Data Mode to 'Define Using Fields Below'.";

const FIELD_TYPES: Record<string, ResourceMapperField['type']> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  array: 'array',
  object: 'object',
};

function isObject(value: unknown): value is DataObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plainId(value: unknown): string {
  if (isResourceLocatorValue(value)) return String(value.value ?? '').trim();
  return typeof value === 'string' ? value.trim() : '';
}

/** Workflow picker: only what `listWorkflows` returns for the current tenant. */
export async function searchWorkflows(
  ctx: LoadOptionsContext,
  filter?: string,
  paginationToken?: string,
): Promise<ListSearchResult> {
  if (!ctx.listWorkflows) throw new Error('Workflows cannot be listed here');
  const page = await ctx.listWorkflows({
    ...(filter ? { filter } : {}),
    ...(paginationToken ? { paginationToken } : {}),
  });
  return {
    results: page.workflows.map((w) => ({ name: w.name, value: w.id })),
    ...(page.paginationToken ? { paginationToken: page.paginationToken } : {}),
  };
}

/** The fields the called workflow declares, from its Execute Workflow Trigger. */
export async function loadWorkflowInputMappings(ctx: LoadOptionsContext): Promise<ResourceMapperFields> {
  const source = String(ctx.getCurrentNodeParameter('source') ?? 'database');
  let nodes: Array<{ type: string; parameters: DataObject }> | undefined;
  if (source === 'parameter') {
    const raw = ctx.getCurrentNodeParameter('workflowJson');
    try {
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (isObject(parsed) && Array.isArray(parsed.nodes)) nodes = parsed.nodes as never;
    } catch {
      throw new Error('The workflow JSON is not valid JSON');
    }
  } else {
    const id = plainId(ctx.getCurrentNodeParameter('workflowId'));
    if (!id) return { fields: [], emptyFieldsNotice: 'Select a workflow to map its inputs.' };
    if (!ctx.readWorkflow) throw new Error('Workflows cannot be read here');
    const workflow = await ctx.readWorkflow(id);
    if (!workflow) throw new Error('The workflow was not found');
    nodes = workflow.nodes as never;
  }
  const trigger = (nodes ?? []).find((n) => n?.type === TRIGGER_TYPE);
  const parameters = isObject(trigger?.parameters) ? trigger.parameters : {};
  if (parameters.inputSource !== 'workflowInputs') return { fields: [], emptyFieldsNotice: NO_INPUTS_NOTICE };
  const declared = isObject(parameters.workflowInputs) ? parameters.workflowInputs.values : undefined;
  const seen = new Set<string>();
  const fields: ResourceMapperField[] = [];
  for (const entry of Array.isArray(declared) ? declared : []) {
    const name = isObject(entry) && typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const type = FIELD_TYPES[String((entry as DataObject).type)];
    fields.push({
      id: name,
      displayName: name,
      required: false,
      defaultMatch: false,
      display: true,
      canBeUsedToMatch: false,
      ...(type ? { type } : {}),
    });
  }
  return fields.length ? { fields } : { fields, emptyFieldsNotice: NO_INPUTS_NOTICE };
}

/** The stored mapping of this node, as saved (expressions and `$fromAI` calls untouched). */
function storedMapping(ctx: SupplyDataContext): { values: DataObject; removed: Set<string> } {
  const stored = ctx.getNode().parameters?.workflowInputs;
  const mapping = isObject(stored) ? stored : {};
  const removed = new Set<string>();
  if (Array.isArray(mapping.schema)) {
    for (const field of mapping.schema) {
      if (isObject(field) && field.removed === true && typeof field.id === 'string') removed.add(field.id);
    }
  }
  const values: DataObject = {};
  if (isObject(mapping.value)) {
    for (const [key, value] of Object.entries(mapping.value)) {
      if (!removed.has(key)) values[key] = value;
    }
  }
  return { values, removed };
}

export interface WorkflowToolInputs {
  /** JSON Schema shown to the model */
  parameters: JsonSchema;
  /** the item sent to the called workflow for one tool call */
  buildItem(args: DataObject, itemIndex: number): DataObject;
}

/**
 * Mapped inputs of the Call Workflow Tool. Keys with a `$fromAI` call become the tool schema; with none
 * the tool takes a plain `query`. Values are read per call with the arguments bound as data. Only mapped
 * fields reach the called workflow, so an argument the mapping does not declare is dropped.
 */
export function workflowToolInputs(ctx: SupplyDataContext): WorkflowToolInputs {
  const { values, removed } = storedMapping(ctx);
  const names = Object.keys(values);
  const asked = extractFromAiArguments(values);
  const parameters = asked.length ? fromAiSchema(values) : QUERY_SCHEMA;
  return {
    parameters,
    buildItem(args, itemIndex) {
      const item: DataObject = asked.length ? {} : { query: args.query ?? null };
      if (!names.length) return item;
      const resolved = ctx.getToolParameter('workflowInputs', itemIndex, args);
      const value = isObject(resolved) && isObject(resolved.value) ? resolved.value : {};
      for (const key of names) {
        if (removed.has(key) || !Object.hasOwn(value, key)) continue;
        Object.defineProperty(item, key, {
          value: value[key],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return item;
    },
  };
}
