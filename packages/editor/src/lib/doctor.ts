/**
 * Workflow Doctor: static checks that run in the browser while you edit, so problems show up
 * before a run fails or activation is refused. Each finding points at a node when it can.
 */
import {
  evaluateSimple,
  type Item,
  isExpression,
  isParameterDisplayed,
  isResourceLocatorValue,
  type NodeCredentialDescription,
  type NodeTypeDescription,
  parseExpression,
  resolveNodeParameters,
  splitTemplate,
} from '@workflow/workflow';
import { deriveNodePorts } from './ports';
import { getAncestors, listConnections, type WorkflowGraph } from './workflow-ops';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface DoctorIssue {
  id: string;
  severity: IssueSeverity;
  node?: string;
  message: string;
  hint?: string;
}

/**
 * Credential slots a node needs beyond `description.credentials`: every displayed `credentialsSelect`
 * parameter with a value names the credential type to attach (for example HTTP Request with a
 * predefined credential type).
 */
export function selectedCredentialSlots(
  description: NodeTypeDescription,
  params: Record<string, unknown>,
  nodeVersion: number,
): NodeCredentialDescription[] {
  const slots: NodeCredentialDescription[] = [];
  for (const prop of description.properties) {
    if (prop.type !== 'credentialsSelect') continue;
    if (!isParameterDisplayed(prop.displayOptions, params, { nodeVersion, rootParams: params })) continue;
    const value = params[prop.name];
    if (typeof value !== 'string' || !value || isExpression(value)) continue;
    if (!slots.some((s) => s.name === value)) slots.push({ name: value, required: true });
  }
  return slots;
}

/**
 * Credential slots of one node as the editor shows them: the declared credentials that pass their
 * displayOptions, plus the slots named by displayed `credentialsSelect` parameters. A declared
 * credential that is hidden (for example a generic auth type while a predefined type is chosen)
 * does not hide the slot the select asks for.
 */
export function nodeCredentialSlots(
  description: NodeTypeDescription,
  params: Record<string, unknown>,
  nodeVersion: number,
): NodeCredentialDescription[] {
  const declared = (description.credentials ?? []).filter((c) =>
    isParameterDisplayed(c.displayOptions, params, { nodeVersion, rootParams: params }),
  );
  const dynamic = selectedCredentialSlots(description, params, nodeVersion).filter(
    (s) => !declared.some((d) => d.name === s.name),
  );
  return [...declared, ...dynamic];
}

export interface DoctorInput extends Pick<WorkflowGraph, 'nodes' | 'connections'> {
  pinData?: Record<string, Item[]>;
  active?: boolean;
}

export interface DescriptionLookup {
  get(type: string): NodeTypeDescription | undefined;
}

const REFERENCE_PATTERNS = [
  /\$\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)/g,
  /\$node\[\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\]/g,
  /\$items\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g,
];

/** Node names referenced by `$('Name')`, `$node["Name"]` and `$items("Name")` in one string. */
export function referencedNodes(expression: string): string[] {
  const names = new Set<string>();
  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of expression.matchAll(pattern)) names.add(match[2].replace(/\\(.)/g, '$1'));
  }
  return [...names];
}

/** Every expression string inside a parameter tree, with its dotted path. */
export function collectExpressions(value: unknown, path = ''): Array<{ path: string; expression: string }> {
  if (isExpression(value)) return [{ path, expression: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectExpressions(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => collectExpressions(v, path ? `${path}.${k}` : k));
  }
  return [];
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (isResourceLocatorValue(value)) return value.value === '' || value.value === undefined;
  return false;
}

function prettyPath(path: string): string {
  return path.replace(/\[(\d+)\]/g, ' #$1').replace(/\./g, ' › ');
}

export function lintWorkflow(input: DoctorInput, types: DescriptionLookup): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const push = (issue: Omit<DoctorIssue, 'id'>) =>
    issues.push({ ...issue, id: `${issue.severity}:${issue.node ?? '-'}:${issues.length}` });
  const names = new Set(input.nodes.map((n) => n.name));
  const connections = listConnections(input.connections);
  const counts = new Map<string, number>();
  const webhookRoutes = new Map<string, string>();
  let triggers = 0;

  for (const node of input.nodes) {
    const description = types.get(node.type);
    if (!description) {
      push({
        severity: 'error',
        node: node.name,
        message: `Uses the node type "${node.type}", which is not installed`,
        hint: 'Replace the node or install the package that provides it.',
      });
      continue;
    }
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    const ports = deriveNodePorts(node, description);
    if (ports.isTrigger && !node.disabled) triggers++;
    const params = resolveNodeParameters(description.properties, node.parameters ?? {}, {
      nodeVersion: node.typeVersion,
    });

    // required parameters
    for (const prop of description.properties) {
      if (!prop.required || prop.isNodeSetting) continue;
      if (
        !isParameterDisplayed(prop.displayOptions, params, {
          nodeVersion: node.typeVersion,
          rootParams: params,
        })
      ) {
        continue;
      }
      if (isEmptyValue(params[prop.name])) {
        push({ severity: 'error', node: node.name, message: `"${prop.displayName}" is required` });
      }
    }

    // credentials
    for (const cred of nodeCredentialSlots(description, params, node.typeVersion)) {
      if (!cred.required) continue;
      if (!node.credentials?.[cred.name]?.id) {
        push({
          severity: 'error',
          node: node.name,
          message: `Needs a "${cred.name}" credential`,
          hint: 'Open the node and select or create a credential.',
        });
      }
    }

    // expressions: syntax and references
    const ancestors = new Set(getAncestors(input.connections, node.name));
    if (ports.isSubNode) {
      // sub-nodes see the data of the root node they are attached to
      for (const c of connections) {
        if (c.source !== node.name) continue;
        ancestors.add(c.target);
        for (const a of getAncestors(input.connections, c.target)) ancestors.add(a);
      }
    }
    for (const { path, expression } of collectExpressions(node.parameters ?? {})) {
      for (const segment of splitTemplate(expression.slice(1))) {
        if (segment.type !== 'code' || !segment.value.trim()) continue;
        try {
          parseExpression(segment.value);
        } catch (error) {
          push({
            severity: 'error',
            node: node.name,
            message: `Expression in "${prettyPath(path)}" does not parse`,
            hint: (error as Error).message,
          });
        }
      }
      for (const ref of referencedNodes(expression)) {
        if (!names.has(ref)) {
          push({
            severity: 'error',
            node: node.name,
            message: `"${prettyPath(path)}" refers to "${ref}", which does not exist`,
            hint: 'Rename the reference or restore the node.',
          });
        } else if (ref !== node.name && !ancestors.has(ref)) {
          push({
            severity: 'warning',
            node: node.name,
            message: `"${prettyPath(path)}" reads from "${ref}", which is not upstream of this node`,
            hint: 'Its data is only available when it ran earlier in the same execution.',
          });
        }
      }
    }

    // wiring
    const incoming = connections.filter((c) => c.target === node.name);
    const outgoing = connections.filter((c) => c.source === node.name);
    const hasMainInput = ports.inputs.some((p) => p.type === 'main');
    if (
      !ports.isTrigger &&
      !ports.isSubNode &&
      hasMainInput &&
      !incoming.some((c) => c.targetType === 'main')
    ) {
      push({
        severity: 'warning',
        node: node.name,
        message: 'Has no input connection, so it will never run',
        hint: 'Connect it to a trigger or to a previous node.',
      });
    }
    if (ports.isSubNode && outgoing.length === 0) {
      push({ severity: 'warning', node: node.name, message: 'Is not attached to a root node' });
    }
    for (const port of ports.inputs) {
      if (!port.required) continue;
      if (!incoming.some((c) => c.targetType === port.type && c.targetIndex === port.index)) {
        push({
          severity: 'error',
          node: node.name,
          message: `Needs a "${port.label ?? port.type}" connection`,
        });
      }
    }

    // webhook routes must be unique per method
    if (description.webhooks?.length && !node.disabled) {
      for (const webhook of description.webhooks) {
        try {
          const method = String(
            evaluateSimple(webhook.httpMethod, { $parameter: params }) || 'GET',
          ).toUpperCase();
          const path = String(evaluateSimple(webhook.path, { $parameter: params }) ?? '')
            .trim()
            .replace(/^\/+|\/+$/g, '');
          if (!path) continue; // defaults to the node's unique webhookId
          const key = `${method} ${path}`;
          const other = webhookRoutes.get(key);
          if (other) {
            push({
              severity: 'error',
              node: node.name,
              message: `Listens on ${method} /${path}, which "${other}" already uses`,
            });
          } else webhookRoutes.set(key, node.name);
        } catch {
          // path expressions that need run data cannot be checked statically
        }
      }
    }
  }

  for (const [type, count] of counts) {
    const max = types.get(type)?.maxNodes;
    if (max !== undefined && count > max) {
      const description = types.get(type)!;
      push({
        severity: 'error',
        message: `"${description.displayName}" can be used ${max === 1 ? 'once' : `${max} times`} per workflow, found ${count}`,
      });
    }
  }

  if (input.nodes.length && triggers === 0) {
    push({
      severity: 'info',
      message: 'There is no trigger yet',
      hint: 'Add a trigger to start the workflow on a schedule, a webhook or an app event.',
    });
  }

  const pinned = Object.keys(input.pinData ?? {}).filter((n) => names.has(n));
  if (input.active && pinned.length) {
    push({
      severity: 'info',
      message: `${pinned.length === 1 ? `"${pinned[0]}" has` : `${pinned.length} nodes have`} pinned data`,
      hint: 'Pinned data only replaces node output in manual runs; production runs execute the node.',
    });
  }

  const rank: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function issuesByNode(issues: DoctorIssue[]): Map<string, DoctorIssue[]> {
  const map = new Map<string, DoctorIssue[]>();
  for (const issue of issues) {
    if (!issue.node) continue;
    const list = map.get(issue.node) ?? [];
    list.push(issue);
    map.set(issue.node, list);
  }
  return map;
}
