/**
 * P6-07 (L4): status, push and pull under the tenant's lease (`acquireLease`), each inside `withRemote` and
 * `withRepo`, the lease extended between steps (409 on `GitLeaseLostError`). Push takes only paths from the server's
 * own status for the caller, limited by `pushableProjects` (the client names only id and type); pull writes in n8n's
 * order through the services inside `withPullWrites`. `remoteContent` reads one workflow file of the remote branch
 * for a caller who may push its project.
 * stub (L4): the constructor passes, every method throws.
 */
import type {
  PullResult,
  PullWorkFolderBody,
  PushResult,
  PushWorkFolderBody,
  SourceControlledFile,
} from '@workflow/workflow';
import type { z } from 'zod';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import type { workflowDataSchema } from '../../http/schemas';

/** a workflow as the editor loads it (the remote file's definition, ids mapped to local ids) */
export type WorkflowData = z.output<typeof workflowDataSchema>;

/** GET `/source-control/get-status` and `/source-control/status` */
export interface SourceControlStatusQuery {
  direction: 'push' | 'pull';
  verbose?: boolean;
  preferLocalVersion?: boolean;
}

export class SourceControlSyncService {
  /** stub (L4): passes (the context builds it in every test) */
  constructor(readonly deps: ServiceDeps) {}

  /** stub (L4) */
  status(_auth: AuthContext, _query: SourceControlStatusQuery): Promise<SourceControlledFile[]> {
    throw new Error('not implemented (L4)');
  }

  /** stub (L4) */
  push(_auth: AuthContext, _body: PushWorkFolderBody): Promise<PushResult> {
    throw new Error('not implemented (L4)');
  }

  /** stub (L4) */
  pull(_auth: AuthContext, _body: PullWorkFolderBody): Promise<PullResult> {
    throw new Error('not implemented (L4)');
  }

  /** stub (L4) */
  remoteContent(_auth: AuthContext, _type: 'workflow', _id: string): Promise<WorkflowData> {
    throw new Error('not implemented (L4)');
  }
}
