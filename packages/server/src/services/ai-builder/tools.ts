/**
 * The builder's tools on a draft (P5-09, L1): `search_nodes`, `get_node_details`, `add_nodes`,
 * `update_node_parameters`, `remove_node`, `rename_node`, `connect_nodes`, `remove_connection`,
 * `get_workflow_overview`, `get_execution_schema`, `validate_workflow`. Each wraps `invoke` to emit
 * `tool` progress; a change emits `workflow-updated`. No tool saves, runs, reads credentials or calls
 * out; a credential the model writes is dropped here.
 */
import type { NodeTypeRegistry } from '@workflow/core';
import type {
  AiTool,
  BuilderChunk,
  DoctorIssue,
  NodeCredentialDescription,
  NodeProperty,
  WorkflowDefinition,
} from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { TenantRow } from '../../db/schema';
import type { BuilderDraft } from './draft';

/** what every builder tool gets; `ctx` and `tenant` are frozen, L1 may add fields */
export interface BuilderToolDeps {
  ctx: ServerContext;
  tenant: TenantRow;
  emit: (chunk: BuilderChunk) => void;
}

/** one hit of `search_nodes` */
export interface BuilderNodeSearchHit {
  type: string;
  displayName: string;
  description: string;
  /** latest type version */
  version: number;
  isTrigger: boolean;
}

/** the hits for one query of `search_nodes` */
export interface BuilderNodeSearchResult {
  query: string;
  results: BuilderNodeSearchHit[];
}

/** what `get_node_details` returns for one type */
export interface BuilderNodeDetails {
  type: string;
  displayName: string;
  description: string;
  version: number;
  inputs: unknown;
  outputs: unknown;
  properties: NodeProperty[];
  credentials: NodeCredentialDescription[];
}

/** result of `validate_workflow`: the builder lint (`lintForBuilder`) and the server's own checks */
export interface BuilderValidation {
  valid: boolean;
  issues: DoctorIssue[];
}

/** every builder tool on `draft` (build mode); the caller adds `webFetchTools` */
export function createBuilderTools(_draft: BuilderDraft, _deps: BuilderToolDeps): AiTool[] {
  throw new Error('not implemented (L1)');
}

/** the read-only tools: `search_nodes`, `get_node_details`, `get_workflow_overview` (plan mode) */
export function readBuilderTools(_draft: BuilderDraft, _deps: BuilderToolDeps): AiTool[] {
  throw new Error('not implemented (L1)');
}

export function searchNodes(_nodeTypes: NodeTypeRegistry, _queries: string[]): BuilderNodeSearchResult[] {
  throw new Error('not implemented (L1)');
}

/** undefined for an unknown type */
export function nodeDetails(_nodeTypes: NodeTypeRegistry, _type: string): BuilderNodeDetails | undefined {
  throw new Error('not implemented (L1)');
}

export async function validateDefinition(
  _ctx: ServerContext,
  _tenantId: string,
  _definition: WorkflowDefinition,
  _workflowId?: string,
): Promise<BuilderValidation> {
  throw new Error('not implemented (L1)');
}
