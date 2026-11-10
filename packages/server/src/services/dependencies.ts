/**
 * P6-86 (L18): what uses what, computed from `workflows.nodes` and `settings` (no table). Keys
 * `credentialId`, `dataTableId`, `errorWorkflow`, `errorWorkflowParent`, `workflowCall`, `workflowParent`
 * (`agentUsage` left out). At most 100 ids a call. Rows the caller cannot read are dropped through
 * `listFilter`, in REST and public alike, and the counts follow. The public answers are n8n's
 * `DependencyListPublicDto` shape with paging.
 * Stub from C0: the constructor PASSES (createContext builds it); every method throws until L18.
 */
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';

/** at most this many ids per counts or details call */
export const DEPENDENCY_BATCH_LIMIT = 100;

export type DependencyResourceKind = 'workflow' | 'credential' | 'dataTable';

export type DependencyKey =
  | 'credentialId'
  | 'dataTableId'
  | 'errorWorkflow'
  | 'errorWorkflowParent'
  | 'workflowCall'
  | 'workflowParent';

/** counts per key for one resource (a missing key is 0) */
export type DependencyCounts = Partial<Record<DependencyKey, number>>;

/** one related resource the caller may read */
export interface DependencyDetail {
  key: DependencyKey;
  id: string;
  name: string;
  resourceType: DependencyResourceKind;
  projectId: string | null;
  /** a related workflow is published */
  active?: boolean;
}

/** the folder's whole tree: workflows that other resources use, each with what uses it */
export interface FolderDependencies {
  workflows: Array<{ id: string; name: string; dependencies: DependencyDetail[] }>;
}

/** one public page */
export interface DependencyPage {
  data: DependencyDetail[];
  nextCursor: string | null;
}

export interface DependencyPageQuery {
  limit?: number;
  cursor?: string;
}

export class DependencyService {
  constructor(readonly deps: ServiceDeps) {}

  /** by resource id */
  async counts(
    _auth: AuthContext,
    _resourceType: DependencyResourceKind,
    _resourceIds: string[],
  ): Promise<Record<string, DependencyCounts>> {
    // stub (L18)
    throw new Error('not implemented (L18)');
  }

  /** by resource id */
  async details(
    _auth: AuthContext,
    _resourceType: DependencyResourceKind,
    _resourceIds: string[],
  ): Promise<Record<string, DependencyDetail[]>> {
    // stub (L18)
    throw new Error('not implemented (L18)');
  }

  async folderDependencies(
    _auth: AuthContext,
    _projectId: string,
    _folderId: string,
  ): Promise<FolderDependencies> {
    // stub (L18)
    throw new Error('not implemented (L18)');
  }

  async forWorkflow(
    _auth: AuthContext,
    _workflowId: string,
    _page: DependencyPageQuery = {},
  ): Promise<DependencyPage> {
    // stub (L18)
    throw new Error('not implemented (L18)');
  }

  async forCredential(
    _auth: AuthContext,
    _credentialId: string,
    _page: DependencyPageQuery = {},
  ): Promise<DependencyPage> {
    // stub (L18)
    throw new Error('not implemented (L18)');
  }

  async forDataTable(
    _auth: AuthContext,
    _dataTableId: string,
    _page: DependencyPageQuery = {},
  ): Promise<DependencyPage> {
    // stub (L18)
    throw new Error('not implemented (L18)');
  }
}
