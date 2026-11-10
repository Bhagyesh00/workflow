/**
 * P6-87 (L16): the credential gate of a trigger that knows the person (Webhook, Form and Chat with
 * workspace sign-in). `check(userId)` lists the private credentials of the enabled nodes the trigger
 * reaches, sub-nodes included, and is ready when the user has an entry for each; the trigger answers 428
 * with `credentialConnectionsRequiredBody` when not. `forRun` is called for every run that builds services
 * with a definition (services/executions.ts `buildServices`), so it never throws; `check` may throw (a
 * database error), and the caller then fails closed (webhooks.ts answers 503).
 *
 * A node is reached from the start node over its main connections; a sub-node (a model, a tool, a memory...)
 * is reached through the node it feeds, and so on up. A disabled node passes its items on, as the engine does:
 * the nodes after it are reached, but neither it nor its sub-nodes are. A credential named without an id is
 * looked up as the run does (the workflow's project, a type that fits the node's), so the gate never asks for
 * one the run would not use.
 */
import type {
  CredentialConnectionStatus,
  CredentialGateHelper,
  CredentialGateResult,
  NodeCredentialRef,
  WorkflowDefinition,
  WorkflowNode,
} from '@workflow/workflow';
import type { ServiceDeps } from '../context';

/** the credential connect page, a top-level page of the editor (`CredentialConnectPage`) */
const CONNECT_PATH = '/credential-connect';

/** the enabled nodes the trigger reaches: downstream over main, then every sub-node of those */
export function reachableNodes(workflow: WorkflowDefinition, startNode?: string): WorkflowNode[] {
  const byName = new Map<string, WorkflowNode>();
  for (const node of workflow.nodes ?? [])
    if (node && typeof node.name === 'string') byName.set(node.name, node);
  const connections = workflow.connections ?? {};

  // sources feeding a node over a non-main connection
  const feeders = new Map<string, string[]>();
  for (const [source, byType] of Object.entries(connections)) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      if (type === 'main') continue;
      for (const list of outputs ?? []) {
        for (const link of list ?? []) {
          const into = feeders.get(link.node) ?? [];
          into.push(source);
          feeders.set(link.node, into);
        }
      }
    }
  }

  const reached = new Set<string>();
  // disabled nodes walked through: the engine hands their input to their children
  const passed = new Set<string>();
  const queue: string[] = [];
  const reach = (name: string) => {
    const node = byName.get(name);
    if (!node || reached.has(name) || passed.has(name)) return;
    (node.disabled ? passed : reached).add(name);
    queue.push(name);
  };
  if (startNode !== undefined) reach(startNode);
  else for (const name of byName.keys()) reach(name);
  while (queue.length) {
    const name = queue.shift() as string;
    for (const list of connections[name]?.main ?? []) for (const link of list ?? []) reach(link.node);
    if (passed.has(name)) continue;
    for (const feeder of feeders.get(name) ?? []) reach(feeder);
  }
  return [...reached].map((name) => byName.get(name) as WorkflowNode);
}

export class CredentialGateService {
  constructor(readonly deps: ServiceDeps) {}

  forRun(
    tenantId: string,
    workflow: WorkflowDefinition,
    projectId: string,
    startNode?: string,
  ): CredentialGateHelper {
    return {
      check: (userId: string) => this.check(tenantId, workflow, projectId, startNode, userId),
      connectPageUrl: (credentialId, action, returnTo) => this.connectPageUrl(credentialId, action, returnTo),
    };
  }

  /** the private credentials the trigger reaches and whether this user has an entry for each */
  async check(
    tenantId: string,
    workflow: WorkflowDefinition,
    projectId: string,
    startNode: string | undefined,
    userId: string,
  ): Promise<CredentialGateResult> {
    const { repos } = this.deps;
    const ids = new Set<string>();
    // name-only references: the name and the type the node asks for (the key of `node.credentials`)
    const named = new Map<string, { name: string; type: string }>();
    for (const node of reachableNodes(workflow, startNode)) {
      if (!node.credentials || typeof node.credentials !== 'object') continue;
      for (const [type, raw] of Object.entries(node.credentials as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const ref = raw as Partial<NodeCredentialRef>;
        if (typeof ref.id === 'string' && ref.id !== '') ids.add(ref.id);
        else if (typeof ref.name === 'string' && ref.name !== '') {
          named.set(JSON.stringify([ref.name, type]), { name: ref.name, type });
        }
      }
    }
    if (!ids.size && !named.size) return { readyToExecute: true, credentials: [] };

    // the private ones among them, by id and by name, each once
    const found = new Map<string, { name: string; type: string }>();
    for (const id of await repos.credentialEntries.resolvableIds(tenantId, [...ids])) {
      const row = await repos.credentials.get(tenantId, id);
      if (row) found.set(row.id, { name: row.name, type: row.type });
    }
    // a name resolves as in the run (services/credentials.ts `provider`): the row the project can use, its own
    // first, among the types that fit; it counts only when that row is private
    const types = named.size ? this.deps.context().credentials.types : undefined;
    for (const ref of named.values()) {
      const candidates = (types?.list() ?? [])
        .map((t) => t.name)
        .filter((name) => types?.isA(name, ref.type));
      const row = await repos.credentials.findByName(tenantId, projectId, ref.name, candidates);
      if (row?.isResolvable) found.set(row.id, { name: row.name, type: row.type });
    }
    if (!found.size) return { readyToExecute: true, credentials: [] };

    const connected = await repos.credentialEntries.connectedIds(tenantId, userId, [...found.keys()]);
    const credentials: CredentialConnectionStatus[] = [...found]
      .map(([credentialId, { name, type }]) => ({
        credentialId,
        credentialName: name,
        credentialType: type,
        status: connected.has(credentialId) ? ('configured' as const) : ('missing' as const),
      }))
      .sort(
        (a, b) =>
          a.credentialName.localeCompare(b.credentialName) || a.credentialId.localeCompare(b.credentialId),
      );
    return { readyToExecute: credentials.every((c) => c.status === 'configured'), credentials };
  }

  /**
   * The link of the connect page (a top-level navigation, no session or token in it): the page has the
   * visitor's session and `returnTo` is checked there (a form, chat or webhook path only).
   */
  connectPageUrl(credentialId: string, action: 'connect' | 'disconnect', returnTo: string): string {
    const query = new URLSearchParams({ action, returnTo });
    return `${this.deps.config.baseUrl}${CONNECT_PATH}/${encodeURIComponent(credentialId)}?${query.toString()}`;
  }
}
