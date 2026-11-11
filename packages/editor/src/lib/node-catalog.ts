/**
 * Node creator catalogue: search, categories, trigger-first ordering and the per-operation
 * "actions" of resource/operation nodes.
 */
import {
  type ConnectionType,
  isHitlVariant,
  isOption,
  isToolVariant,
  type NodeParameters,
  type NodeTypeDescription,
  type WorkflowNode,
} from '@workflow/workflow';
import { newId } from './ids';
import { evaluatePortList, isTriggerDescription, latestVersion } from './ports';

export interface NodeAction {
  label: string;
  description?: string;
  parameters: NodeParameters;
  /** connection types of the node's inputs / outputs with these parameters (mode actions only) */
  inputTypes?: ConnectionType[];
  outputTypes?: ConnectionType[];
}

export interface CatalogEntry {
  description: NodeTypeDescription;
  isTrigger: boolean;
  category: string;
  actions: NodeAction[];
  /** connection types the node's outputs can have (a dynamic list: over the options it switches on) */
  outputTypes: ConnectionType[];
  /** connection types the node's inputs can have */
  inputTypes: ConnectionType[];
}

const PARAMETER_REFERENCE = /\$parameter(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

/** Parameters (options or toggles) that the dynamic input / output expressions of a node switch on. */
function portControls(description: NodeTypeDescription): Array<{ name: string; values: unknown[] }> {
  const names = new Set<string>();
  for (const spec of [description.inputs, description.outputs]) {
    if (typeof spec !== 'string') continue;
    for (const match of spec.matchAll(PARAMETER_REFERENCE)) names.add(match[1] ?? match[2]);
  }
  const controls: Array<{ name: string; values: unknown[] }> = [];
  for (const prop of description.properties) {
    if (!names.has(prop.name) || controls.some((c) => c.name === prop.name)) continue;
    if (prop.type === 'options') {
      const values = (prop.options ?? []).filter(isOption).map((o) => o.value);
      if (values.length) controls.push({ name: prop.name, values });
    } else if (prop.type === 'boolean') {
      controls.push({ name: prop.name, values: [true, false] });
    }
  }
  return controls;
}

/** `action` texts from `operation` options, with the `resource` they belong to. */
export function nodeActions(description: NodeTypeDescription): NodeAction[] {
  const actions: NodeAction[] = [];
  const controls = new Set(portControls(description).map((c) => c.name));
  for (const prop of description.properties) {
    if (prop.type === 'options' && prop.name !== 'operation' && controls.has(prop.name)) {
      // an option that decides the ports (vector store mode): one action per option, with its ports
      for (const option of (prop.options ?? []).filter(isOption)) {
        if (!option.action) continue;
        const parameters = { [prop.name]: option.value };
        actions.push({
          label: option.action,
          description: option.description,
          parameters,
          inputTypes: portTypes(description.inputs, parameters),
          outputTypes: portTypes(description.outputs, parameters),
        });
      }
      continue;
    }
    if (prop.name !== 'operation' || prop.type !== 'options') continue;
    const resources = (prop.displayOptions?.show?.resource as
      | Array<string | number | boolean>
      | undefined) ?? [undefined];
    for (const resource of resources) {
      for (const option of (prop.options ?? []).filter(isOption)) {
        if (!option.action) continue;
        actions.push({
          label: option.action,
          description: option.description,
          parameters:
            resource === undefined ? { operation: option.value } : { resource, operation: option.value },
        });
      }
    }
  }
  return actions;
}

function portTypes(spec: NodeTypeDescription['inputs'], parameters: NodeParameters): ConnectionType[] {
  return evaluatePortList(spec, parameters).map((p) => (typeof p === 'string' ? p : p.type));
}

/** Every connection type the ports can have, over all values of the parameters that control them. */
function possiblePortTypes(description: NodeTypeDescription, spec: NodeTypeDescription['inputs']) {
  let combinations: NodeParameters[] = [{}];
  if (typeof spec === 'string') {
    for (const control of portControls(description)) {
      combinations = combinations.flatMap((base) =>
        control.values.map((value) => ({ ...base, [control.name]: value })),
      );
    }
  }
  return [...new Set(combinations.flatMap((parameters) => portTypes(spec, parameters)))];
}

export function buildCatalog(list: NodeTypeDescription[]): CatalogEntry[] {
  return list
    .filter((d) => !d.hidden)
    .map((description) => ({
      description,
      isTrigger: isTriggerDescription(description),
      category: description.categories?.[0] ?? (isTriggerDescription(description) ? 'Triggers' : 'Other'),
      actions: nodeActions(description),
      outputTypes: possiblePortTypes(description, description.outputs),
      inputTypes: possiblePortTypes(description, description.inputs),
    }));
}

function matches(entry: CatalogEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const d = entry.description;
  const name = d.displayName.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  if (name.includes(q)) return 50;
  if (d.alias?.some((a) => a.toLowerCase().includes(q))) return 40;
  if (entry.actions.some((a) => a.label.toLowerCase().includes(q))) return 30;
  if (d.description.toLowerCase().includes(q)) return 20;
  if (d.categories?.some((c) => c.toLowerCase().includes(q))) return 10;
  return 0;
}

export interface CatalogFilter {
  query: string;
  /** only nodes that can be connected after a main output */
  needsMainInput?: boolean;
  /** only sub-nodes whose output is this AI connection type */
  outputType?: ConnectionType;
  /** the workflow has no trigger yet: list triggers first */
  noTriggerYet?: boolean;
  /** P6-50: node types a policy blocks; their rows stay listed but sort last in their section */
  restricted?: { has(type: string): boolean };
}

export interface CatalogSection {
  title: string;
  entries: CatalogEntry[];
}

/** Mode actions that would take away the port the new connection needs are left out. */
function withContextActions(entry: CatalogEntry, filter: CatalogFilter): CatalogEntry {
  const fits = (action: NodeAction) =>
    filter.outputType
      ? !action.outputTypes || action.outputTypes.includes(filter.outputType)
      : !filter.needsMainInput || !action.inputTypes || action.inputTypes.includes('main');
  return entry.actions.every(fits) ? entry : { ...entry, actions: entry.actions.filter(fits) };
}

/** P5-75: the copy of a node made for agents (`<name>Tool`) and its human review copy (`<name>HitlTool`) */
function variantOf(entry: CatalogEntry): 'tool' | 'hitl' | undefined {
  if (isHitlVariant(entry.description)) return 'hitl';
  return isToolVariant(entry.description) ? 'tool' : undefined;
}

/** P6-50: inside each section the blocked types go last (the order of the rest is kept) */
function restrictedLast(sections: CatalogSection[], filter: CatalogFilter): CatalogSection[] {
  const blocked = filter.restricted;
  if (!blocked) return sections;
  return sections.map((section) => {
    const isBlocked = (e: CatalogEntry) => blocked.has(e.description.name);
    if (!section.entries.some(isBlocked)) return section;
    return {
      ...section,
      entries: [...section.entries.filter((e) => !isBlocked(e)), ...section.entries.filter(isBlocked)],
    };
  });
}

export function filterCatalog(catalog: CatalogEntry[], filter: CatalogFilter): CatalogSection[] {
  return restrictedLast(filterCatalogEntries(catalog, filter), filter);
}

function filterCatalogEntries(catalog: CatalogEntry[], filter: CatalogFilter): CatalogSection[] {
  // the variants belong to the tool picker only: everywhere else the node itself is listed
  let entries = filter.outputType === 'ai_tool' ? catalog : catalog.filter((e) => !variantOf(e));
  if (filter.outputType) entries = entries.filter((e) => e.outputTypes.includes(filter.outputType!));
  else if (filter.needsMainInput)
    entries = entries.filter((e) => !e.isTrigger && e.inputTypes.includes('main'));

  const scored = entries
    .map((entry) => ({ entry, score: matches(entry, filter.query) }))
    .filter((s) => s.score > 0)
    .map((s) => ({ ...s, entry: withContextActions(s.entry, filter) }))
    .sort(
      (a, b) =>
        b.score - a.score || a.entry.description.displayName.localeCompare(b.entry.description.displayName),
    );

  if (filter.query.trim()) {
    const triggersFirst = filter.noTriggerYet && !filter.needsMainInput && !filter.outputType;
    const list = scored.map((s) => s.entry);
    if (triggersFirst) list.sort((a, b) => Number(b.isTrigger) - Number(a.isTrigger));
    return list.length ? [{ title: 'Results', entries: list }] : [];
  }

  const sections: CatalogSection[] = [];
  const toolPicker = filter.outputType === 'ai_tool';
  const sorted = scored.map((s) => s.entry).filter((e) => !toolPicker || !variantOf(e));
  if (filter.noTriggerYet && !filter.needsMainInput && !filter.outputType) {
    const triggers = sorted.filter((e) => e.isTrigger);
    if (triggers.length) sections.push({ title: 'Start with a trigger', entries: triggers });
  }
  const rest =
    filter.noTriggerYet && !filter.needsMainInput && !filter.outputType
      ? sorted.filter((e) => !e.isTrigger)
      : sorted;
  const byCategory = new Map<string, CatalogEntry[]>();
  for (const entry of rest) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  const order = ['Core', 'AI'];
  const names = [...byCategory.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
  for (const name of names) sections.push({ title: name, entries: byCategory.get(name)! });
  if (toolPicker) {
    const variants = scored.map((s) => s.entry);
    const other = variants.filter((e) => variantOf(e) === 'tool');
    const hitl = variants.filter((e) => variantOf(e) === 'hitl');
    if (other.length) sections.push({ title: 'Other Tools', entries: other });
    if (hitl.length) sections.push({ title: 'Human in the Loop', entries: hitl });
  }
  return sections;
}

/** A new node of `description` at `position`. */
export function createNodeFromDescription(
  description: NodeTypeDescription,
  position: [number, number],
  parameters: NodeParameters = {},
): WorkflowNode {
  const node: WorkflowNode = {
    id: newId(),
    name: description.defaults.name || description.displayName,
    type: description.name,
    typeVersion: latestVersion(description),
    position: [Math.round(position[0]), Math.round(position[1])],
    parameters: { ...parameters },
  };
  if (description.webhooks?.length) node.webhookId = newId();
  return node;
}
