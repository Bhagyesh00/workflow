/**
 * P6-04, P6-48 to P6-51, P6-55: the shapes of the type availability policies (node types and credential
 * types), shared by the store (L1), the evaluator (L1), enforcement (L2), composition (L6), the routes (L4,
 * L6) and the AI tool filter (L10). FULL in C0: no lane changes this file.
 *
 * A scope is the workspace's (`projectId` null, n8n's instance scope) or one project's, per kind. Its policy
 * is: floor attachments (priority ascending), then normal attachments, rules flattened, first match wins,
 * else the scope's default action. An unwritten scope allows all at version 0.
 */
import type { WorkflowNode } from '@workflow/workflow';

/** one store holds both kinds */
export type PolicyKind = 'node' | 'credential';

/** what a rule or a scope default does; a project scope never delegates (default and rules) */
export type PolicyAction = 'allow' | 'deny' | 'delegate';

/** which types a rule matches; one field per rule */
export interface PolicySelector {
  /** the type name; a node rule also matches the type's tool variants (`toolNameOf`) */
  name?: string;
  /** a package name (`NodePackage.name`, e.g. `@workflow/nodes-ai`), through `buildPackageIndex` */
  package?: string;
  /** credential policies only: the type and every type extending it (`CredentialTypes.isA`) */
  extends?: string;
}

export interface PolicyRule {
  /** stable id, named by a violation's `matchedRuleId` */
  id: string;
  action: PolicyAction;
  selector: PolicySelector;
  description?: string | null;
}

/** a document of ordered rules (`type_policies`) */
export interface PolicyDocument {
  id: string;
  tenantId: string;
  kind: PolicyKind;
  name: string;
  description: string | null;
  rules: PolicyRule[];
  /** starts at 1; a write sends the version it read */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** a document attached to a scope (`type_policy_attachments`); floors are judged first */
export interface PolicyAttachment {
  policyId: string;
  priority: number;
  isFloor: boolean;
}

/** a scope with its attachments (`type_policy_scopes`) */
export interface PolicyScope {
  /** null until the first write */
  id: string | null;
  tenantId: string;
  kind: PolicyKind;
  /** null: the workspace scope */
  projectId: string | null;
  defaultAction: PolicyAction;
  /** 0 until the first write; a write sends the version it read (a stale one gets 409) */
  version: number;
  attachments: PolicyAttachment[];
}

/** the body of a scope write (PUT `.../instance`, `.../project`) */
export interface PolicyScopeInput {
  defaultAction: PolicyAction;
  /** replaces the attachments when given */
  attachments?: PolicyAttachment[];
}

/** the body of a document create or update */
export interface PolicyDocumentInput {
  name: string;
  description?: string | null;
  rules: PolicyRule[];
}

/** a write-time warning of `lintRules` (the write still goes through) */
export interface PolicyWarning {
  code: 'shadowed' | 'notLoaded';
  ruleId: string;
  message: string;
}

/** where a check runs (n8n's enforcement points) */
export type EnforcementPoint =
  | 'workflowSave'
  | 'workflowPublish'
  | 'workflowStart'
  | 'workflowTransfer'
  | 'contentImport'
  | 'credentialSave'
  | 'credentialTransfer'
  | 'credentialDecrypt';

/** the deadline per point in ms (n8n policy-decision.service.ts:29-38): start and decrypt 250, else 1000 */
export const ENFORCEMENT_DEADLINE_MS: Readonly<Record<EnforcementPoint, number>> = {
  workflowSave: 1000,
  workflowPublish: 1000,
  workflowStart: 250,
  workflowTransfer: 1000,
  contentImport: 1000,
  credentialSave: 1000,
  credentialTransfer: 1000,
  credentialDecrypt: 250,
};

/**
 * P6-04: one blocked type in a 403 `policy_violation` answer (`details.violations`). S1 owns
 * `PolicyViolation` (services/transfer.ts), the transfer preview's row, a different shape.
 */
export interface TypePolicyViolation {
  kind: 'node-type-unavailable' | 'credential-type-unavailable';
  type: string;
  /** which scope blocked it; a project denial never names the project */
  scope: 'workspace' | 'project';
  /** the rule that decided, null when a scope default did */
  matchedRuleId: string | null;
  /** the workspace delegates the type, so a project admin may allow it */
  optInAvailable: boolean;
  /** the node that uses the type, when a workflow was judged */
  nodeName?: string;
}

/** what the evaluator knows about one type besides its name */
export interface TypeFacts {
  kind: PolicyKind;
  /** the package the type comes from (`PackageIndex`); undefined when unknown */
  packageName?: string;
  /** the base type of a tool variant (`toolNameOf`), when the type is one */
  baseName?: string;
  /** credential kind: the types it extends (`CredentialTypes.isA`) */
  ancestors?: string[];
}

/** the decision for one type */
export interface TypeDecision {
  /** a single scope may say `delegate`; after `composeDecisions` it is `allow` or `deny` */
  action: PolicyAction;
  /** the rule that decided, null when a scope default did */
  matchedRuleId: string | null;
  /** which scope decided */
  scope: 'workspace' | 'project';
  /** the workspace delegates the type, so a project admin may allow it */
  optInAvailable: boolean;
}

/** one tenant's policies in memory (`PolicySnapshots`), reloaded after a write commits */
export interface TenantPolicySnapshot {
  tenantId: string;
  /** the workspace scope per kind (unwritten: allow, version 0) */
  workspace: Record<PolicyKind, PolicyScope>;
  /** project scopes per kind, by project id (a project with none has no entry) */
  projects: Record<PolicyKind, ReadonlyMap<string, PolicyScope>>;
  /** every document of the tenant, by id */
  policies: ReadonlyMap<string, PolicyDocument>;
  /** Date.now() at load (the 30 s TTL reads it) */
  loadedAt: number;
}

/** one row of GET /projects/:projectId/available-types (or /available-credential-types) */
export interface AvailableType {
  type: string;
  available: boolean;
  /** only on an unavailable row: the violation text */
  reason?: string;
  scope?: 'workspace' | 'project';
  optInAvailable?: boolean;
}

/** the nodes a workflow check reads (a `WorkflowDefinition` or a stored row fits) */
export interface PolicyWorkflow {
  nodes: ReadonlyArray<
    Pick<WorkflowNode, 'name' | 'type'> & Partial<Pick<WorkflowNode, 'id' | 'disabled' | 'credentials'>>
  >;
}

/** what a move into another project carries (`assertTransferAllowed`) */
export type TransferResource =
  | { kind: 'workflow'; workflow: PolicyWorkflow }
  | { kind: 'credential'; credentialType: string };
