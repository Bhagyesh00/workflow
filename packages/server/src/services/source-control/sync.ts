/**
 * P6-07 (L4): status, push and pull under the tenant's lease (`acquireLease`), each inside `withRemote` and
 * `withRepo`, the lease extended between steps (409 on `GitLeaseLostError`). Push takes only paths from the server's
 * own status for the caller, limited by `pushableProjects` (the client names only id and type); pull writes in n8n's
 * order through the services inside `withPullWrites`. `remoteContent` reads one workflow file of the remote branch
 * for a caller who may push its project.
 *
 * The helpers here are shared by push.ts and pull.ts. No database transaction is open while a Git call runs: the
 * reads of the remote happen inside `withRepo`, every write after it (pull) or after the push (the id map).
 */
import {
  type PullResult,
  type PullWorkFolderBody,
  type PushResult,
  type PushWorkFolderBody,
  pathFor,
  redactSecrets,
  SOURCE_CONTROL_LIMITS,
  type SourceControlledFile,
} from '@workflow/workflow';
import type { z } from 'zod';
import type { ServiceDeps } from '../../context';
import type { SourceControlSettingsRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import type { workflowDataSchema } from '../../http/schemas';
import { MISSING_SCOPE_MESSAGE } from '../access';
import { type GitDeps, type GitSession, withRepo } from './git-repo';
import { SyncIdMap } from './id-map';
import { type ParsedFile, parseFile } from './import-schemas';
import { acquireLease, type SourceControlLease } from './lock';
import { pullableProjects, pullWorkFolder } from './pull';
import { pushWorkFolder } from './push';
import { pushableProjects } from './scope';
import { computeStatus, localSnapshot } from './status';

/** a workflow as the editor loads it (the remote file's definition, ids mapped to local ids) */
export type WorkflowData = z.output<typeof workflowDataSchema>;

/** GET `/source-control/get-status` and `/source-control/status` */
export interface SourceControlStatusQuery {
  direction: 'push' | 'pull';
  verbose?: boolean;
  preferLocalVersion?: boolean;
}

/** the remote branch as one sync reads it: its head (null when the branch has no commit yet) and its files */
export interface RemoteBranch {
  head: string | null;
  /** the raw bytes by managed path */
  raw: Map<string, Uint8Array>;
  /** every file parsed (one zod schema per kind), by path */
  parsed: Map<string, ParsedFile>;
}

export function gitDepsOf(deps: ServiceDeps): GitDeps {
  return { http: deps.context().http, limits: SOURCE_CONTROL_LIMITS };
}

/** runs `fn` while holding the workspace's lease (412 when not connected, 409 while another operation runs) */
export async function withLease<T>(
  deps: ServiceDeps,
  tenantId: string,
  fn: (lease: SourceControlLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireLease(deps, tenantId);
  try {
    return await fn(lease);
  } finally {
    await lease.release();
  }
}

/** one Git session on the workspace's remote: the key or token is decrypted for this call only */
export function withSession<T>(
  deps: ServiceDeps,
  tenantId: string,
  fn: (session: GitSession, settings: SourceControlSettingsRow) => Promise<T>,
): Promise<T> {
  return deps
    .context()
    .sourceControl.withRemote(tenantId, (remote, settings) =>
      withRepo(gitDepsOf(deps), remote, (session) => fn(session, settings)),
    );
}

/** fetches the branch (shallow) and reads and parses its files; `afterFetch` runs between the two steps */
export async function readBranch(
  session: GitSession,
  branch: string,
  afterFetch?: () => Promise<void>,
): Promise<RemoteBranch> {
  const head = await session.fetchBranch(branch);
  if (afterFetch) await afterFetch();
  const raw = head ? await session.readFiles(head) : new Map<string, Uint8Array>();
  const parsed = new Map<string, ParsedFile>();
  for (const [path, bytes] of raw) parsed.set(path, parseFile(path, bytes));
  return { head, raw, parsed };
}

/** the status rows of `direction` for the caller's projects (`scope`), against `remote` */
export async function statusRows(
  deps: ServiceDeps,
  tenantId: string,
  input: {
    remote: Map<string, ParsedFile>;
    map: SyncIdMap;
    scope: 'all' | Set<string>;
    direction: 'push' | 'pull';
    preferLocalVersion?: boolean;
  },
): Promise<SourceControlledFile[]> {
  const local = await localSnapshot(deps, tenantId, input.scope);
  return computeStatus({
    local,
    remote: input.remote,
    map: input.map,
    direction: input.direction,
    preferLocalVersion: input.preferLocalVersion,
  });
}

/**
 * Error text that reaches a client passes `redactSecrets`: a refusal can name a path or a value the remote chose
 * (L1 names a stray file's path), and a remote can put a token in it. The class, status, code and details stay.
 */
async function redacted<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (error instanceof Error && typeof error.message === 'string')
      error.message = redactSecrets(error.message);
    throw error;
  }
}

export const rowKey = (row: Pick<SourceControlledFile, 'type' | 'id'>) =>
  `${row.type}:${row.id.toLowerCase()}`;

export class SourceControlSyncService {
  constructor(readonly deps: ServiceDeps) {}

  /**
   * The push status narrows to the caller's pushable projects, the pull status to the projects the caller may pull
   * (every project with the global `project:update`). The remote is read under the lease.
   */
  status(auth: AuthContext, query: SourceControlStatusQuery): Promise<SourceControlledFile[]> {
    return redacted(() => this.statusOf(auth, query));
  }

  private async statusOf(
    auth: AuthContext,
    query: SourceControlStatusQuery,
  ): Promise<SourceControlledFile[]> {
    const tenantId = auth.tenant.id;
    const deps = this.deps;
    return withLease(deps, tenantId, async (lease) => {
      const scope =
        query.direction === 'push' ? await pushableProjects(deps, auth) : await pullableProjects(deps, auth);
      const remote = await withSession(deps, tenantId, (session, settings) =>
        readBranch(session, settings.branchName, () => lease.extend()),
      );
      const map = await SyncIdMap.load(deps.repos, tenantId);
      return statusRows(deps, tenantId, {
        remote: remote.parsed,
        map,
        scope,
        direction: query.direction,
        preferLocalVersion: query.preferLocalVersion,
      });
    });
  }

  push(auth: AuthContext, body: PushWorkFolderBody): Promise<PushResult> {
    return redacted(() => pushWorkFolder(this.deps, auth, body));
  }

  pull(auth: AuthContext, body: PullWorkFolderBody): Promise<PullResult> {
    return redacted(() => pullWorkFolder(this.deps, auth, body));
  }

  /**
   * One workflow file of the remote branch, ids mapped to local ids. `id` is the git id (a mapped local id is
   * taken too). Allowed when the caller may push every project, or the mapped local workflow's project is one of the
   * caller's pushable projects; an id with no local workflow is 403 unless the caller may push every project (n8n's
   * admin projects rule). A file the branch does not hold is 404.
   */
  remoteContent(auth: AuthContext, type: 'workflow', id: string): Promise<WorkflowData> {
    return redacted(() => this.remoteContentOf(auth, type, id));
  }

  private async remoteContentOf(auth: AuthContext, type: 'workflow', id: string): Promise<WorkflowData> {
    const tenantId = auth.tenant.id;
    const deps = this.deps;
    await deps.context().sourceControl.requireConnected(tenantId);
    const map = await SyncIdMap.load(deps.repos, tenantId);
    const wanted = id.toLowerCase();
    const entry = map.entryForGit(type, wanted) ?? map.entryForLocal(type, wanted);
    const gitId = entry?.gitId ?? wanted;
    const local = await deps.repos.workflows.get(tenantId, entry?.localId ?? wanted);
    const scope = await pushableProjects(deps, auth);
    if (scope !== 'all' && !(local && scope.has(local.projectId))) {
      throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    }
    const path = pathFor(type, gitId);
    const file = await withSession(deps, tenantId, async (session, settings) => {
      const head = await session.fetchBranch(settings.branchName);
      if (!head) return undefined;
      const bytes = (await session.readFiles(head)).get(path);
      return bytes ? parseFile(path, bytes) : undefined;
    });
    if (file?.type !== 'workflow') throw ApiError.notFound('Workflow');
    const data = map.rewriteDefinition(file.data, 'toLocal');
    return {
      id: local?.id ?? data.id,
      name: data.name,
      nodes: data.nodes,
      connections: data.connections,
      ...(data.settings ? { settings: data.settings } : {}),
      stickyNotes: data.stickyNotes ?? [],
      nodeGroups: data.nodeGroups ?? [],
    } as WorkflowData;
  }
}
