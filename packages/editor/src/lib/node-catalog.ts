/**
 * Node creator catalogue: search, categories, trigger-first ordering and the per-operation
 * "actions" of resource/operation nodes.
 */
import {
  type ConnectionType,
  isOption,
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
}

export interface CatalogEntry {
  description: NodeTypeDescription;
  isTrigger: boolean;
  category: string;
  actions: NodeAction[];
  /** connection types of the node's outputs (static lists only; dynamic count as main) */
  outputTypes: ConnectionType[];
  inputTypes: ConnectionType[];
}

/** `action` texts from `operation` options, with the `resource` they belong to. */
export function nodeActions(description: NodeTypeDescription): NodeAction[] {
  const actions: NodeAction[] = [];
  for (const prop of description.properties) {
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

function portTypes(spec: NodeTypeDescription['inputs']): ConnectionType[] {
  return evaluatePortList(spec, {}).map((p) => (typeof p === 'string' ? p : p.type));
}

export function buildCatalog(list: NodeTypeDescription[]): CatalogEntry[] {
  return list
    .filter((d) => !d.hidden)
    .map((description) => ({
      description,
      isTrigger: isTriggerDescription(description),
      category: description.categories?.[0] ?? (isTriggerDescription(description) ? 'Triggers' : 'Other'),
      actions: nodeActions(description),
      outputTypes: portTypes(description.outputs),
      inputTypes: portTypes(description.inputs),
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
}

export interface CatalogSection {
  title: string;
  entries: CatalogEntry[];
}

export function filterCatalog(catalog: CatalogEntry[], filter: CatalogFilter): CatalogSection[] {
  let entries = catalog;
  if (filter.outputType) entries = entries.filter((e) => e.outputTypes.includes(filter.outputType!));
  else if (filter.needsMainInput)
    entries = entries.filter((e) => !e.isTrigger && e.inputTypes.includes('main'));

  const scored = entries
    .map((entry) => ({ entry, score: matches(entry, filter.query) }))
    .filter((s) => s.score > 0)
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
  const sorted = scored.map((s) => s.entry);
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
