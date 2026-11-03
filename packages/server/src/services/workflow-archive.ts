/**
 * Archive, unarchive and move workflows (P3-07, as n8n): archive unpublishes first; unarchive does
 * not republish; the editor archives an archived workflow with 400, the public API answers 200.
 *
 * C0 STUB: lane L8 writes the bodies. archive / unarchive return the workflow unchanged for now.
 */
import type { ServiceDeps } from '../context';
import type { WorkflowDTO } from './workflow-model';
import type { Actor } from './workflows';

export class WorkflowArchiveService {
  constructor(readonly deps: ServiceDeps) {}

  async archive(
    tenantId: string,
    id: string,
    _actor: Actor,
    _options: { publicApi?: boolean } = {},
  ): Promise<WorkflowDTO> {
    const { workflows } = this.deps.context();
    return workflows.dto(tenantId, await workflows.get(tenantId, id));
  }

  async unarchive(tenantId: string, id: string, _actor: Actor): Promise<WorkflowDTO> {
    const { workflows } = this.deps.context();
    return workflows.dto(tenantId, await workflows.get(tenantId, id));
  }

  /** move workflows to a folder (null = root) */
  async move(
    _tenantId: string,
    _workflowIds: string[],
    _folderId: string | null,
    _actor: Actor,
  ): Promise<{ moved: string[] }> {
    throw new Error('not implemented (L8)');
  }
}
