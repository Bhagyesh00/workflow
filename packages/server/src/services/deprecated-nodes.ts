/**
 * P6-52 (L7): with `DEPRECATED_NODES_BLOCK` on (default), a save may not add or edit a node whose type
 * description has `deprecated: true` (400, `details.violations` of kind `node-type-deprecated`, n8n's text
 * "Cannot use a "<type>" node ("<name>"): this node type is deprecated. Replace it with the <X> node or
 * remove it from the workflow."). An edit is any difference from the stored node of the same id other than
 * its position. Removal is allowed and a saved one runs; an inline sub-workflow or an Assistant single node
 * with one fails (`assertNoDeprecatedNodes`).
 */
import { redactSecrets, type WorkflowNode } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';

/** one refused node in a 400 answer (`details.violations`) */
export interface DeprecatedNodeViolation {
  kind: 'node-type-deprecated';
  type: string;
  nodeName: string;
  /** the description's `replacedBy`, when it names one */
  replacedBy?: string;
}

/** the nodes a save carries (a `WorkflowDefinition` or a stored row fits) */
export interface DeprecatedCheckWorkflow {
  nodes: readonly WorkflowNode[];
}

/** n8n's text: `Cannot use a "<type>" node ("<name>"): ...` */
function messageOf(v: DeprecatedNodeViolation, replacementName: string | undefined): string {
  const fix = replacementName ? `the ${replacementName} node` : 'a supported node';
  return `Cannot use a "${v.type}" node ("${v.nodeName}"): this node type is deprecated. Replace it with ${fix} or remove it from the workflow.`;
}

/** the description of a type, when it is registered and deprecated */
function deprecatedDescription(deps: ServiceDeps, type: string) {
  const description = deps.context().registries.nodeTypes.get(type)?.description;
  return description?.deprecated === true ? description : undefined;
}

function refuse(deps: ServiceDeps, found: DeprecatedNodeViolation[]): never {
  const nodeTypes = deps.context().registries.nodeTypes;
  const text = found
    .map((v) => messageOf(v, v.replacedBy ? nodeTypes.get(v.replacedBy)?.description.displayName : undefined))
    .join(' ');
  throw ApiError.badRequest(redactSecrets(text), { violations: found });
}

function violationOf(deps: ServiceDeps, node: Pick<WorkflowNode, 'name' | 'type'>) {
  const description = deprecatedDescription(deps, node.type);
  if (!description) return undefined;
  const v: DeprecatedNodeViolation = { kind: 'node-type-deprecated', type: node.type, nodeName: node.name };
  if (description.replacedBy) v.replacedBy = description.replacedBy;
  return v;
}

/** a stable text of a node without its position, to see whether it was edited */
function fingerprint(node: WorkflowNode): string {
  const { position: _position, ...rest } = node;
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(sort(rest));
}

export async function assertNoNewDeprecatedNodes(
  deps: ServiceDeps,
  input: { next: DeprecatedCheckWorkflow; stored?: DeprecatedCheckWorkflow | null },
): Promise<void> {
  if (!deps.config.deprecatedNodesBlock) return;
  const before = new Map((input.stored?.nodes ?? []).map((n) => [n.id, fingerprint(n)]));
  const found: DeprecatedNodeViolation[] = [];
  for (const node of input.next.nodes) {
    const v = violationOf(deps, node);
    if (!v) continue;
    // saved as is (a move on the canvas only): allowed
    if (before.get(node.id) === fingerprint(node)) continue;
    found.push(v);
  }
  if (found.length > 0) refuse(deps, found);
}

export async function assertNoDeprecatedNodes(
  deps: ServiceDeps,
  nodes: ReadonlyArray<Pick<WorkflowNode, 'name' | 'type'>>,
): Promise<void> {
  if (!deps.config.deprecatedNodesBlock) return;
  const found: DeprecatedNodeViolation[] = [];
  for (const node of nodes) {
    const v = violationOf(deps, node);
    if (v) found.push(v);
  }
  if (found.length > 0) refuse(deps, found);
}
