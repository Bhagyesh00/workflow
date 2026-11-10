/**
 * P6-86 (L18): the reads behind the dependency counts: workflows whose nodes or settings name a resource
 * (credential ids, data table ids, `settings.errorWorkflow`, sub-workflow calls). Every query filters
 * tenant_id; the caller's access filter is applied in the service.
 * Stub from C0; L18 fills it.
 */
import type { DbOrTx } from '../db/client';

/** one workflow that names the resource, and how */
export interface DependencyRow {
  workflowId: string;
  workflowName: string;
  projectId: string | null;
  active: boolean;
  /** the resource it names */
  resourceId: string;
  key: 'credentialId' | 'dataTableId' | 'errorWorkflow' | 'workflowCall';
}

export class DependencyRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** workflows whose nodes name one of the credentials */
  async workflowsUsingCredentials(_tenantId: string, _credentialIds: string[]): Promise<DependencyRow[]> {
    throw new Error('not implemented (L18)');
  }

  /** workflows whose nodes name one of the data tables */
  async workflowsUsingDataTables(_tenantId: string, _dataTableIds: string[]): Promise<DependencyRow[]> {
    throw new Error('not implemented (L18)');
  }

  /** workflows that call one of the workflows, or name one as their error workflow */
  async workflowsReferencing(_tenantId: string, _workflowIds: string[]): Promise<DependencyRow[]> {
    throw new Error('not implemented (L18)');
  }

  /** what the workflows themselves name (their credentials, tables, sub-workflows, error workflow) */
  async referencesOf(_tenantId: string, _workflowIds: string[]): Promise<DependencyRow[]> {
    throw new Error('not implemented (L18)');
  }
}
