/**
 * Tenant-scoped data access. Every method that reads or writes tenant data takes `tenantId`
 * first; the few system-level methods (startup reactivation, wait tracker, pruning, token
 * lookups by hash) say so in their doc comment.
 */
import type { DbOrTx } from '../db/client';
import {
  ApiKeyRepository,
  InvitationRepository,
  MembershipRepository,
  SessionRepository,
  TenantRepository,
  UserRepository,
} from './accounts';
import { AnnotationRepository } from './annotations';
import { AssistantConfirmationRepository } from './assistant-confirmations';
import { AssistantMcpRepository } from './assistant-mcp';
import { AssistantThreadRepository } from './assistant-threads';
import { BuilderSessionRepository } from './builder-sessions';
import { CredentialEntryRepository } from './credential-entries';
import { DataTableRepository } from './data-tables';
import { ExecutionRepository } from './executions';
import { FavoriteRepository } from './favorites';
import { FolderRepository } from './folders';
import { JweKeyRepository } from './jwe-keys';
import { LdapHistoryRepository } from './ldap-history';
import { McpOAuthRepository } from './mcp-oauth';
import { MembersListRepository } from './members-list';
import { ProjectRepository } from './projects';
import { PublishHistoryRepository } from './publish-history';
import {
  AuditRepository,
  CredentialRepository,
  IdempotencyRepository,
  UsageRepository,
  VariableRepository,
  WebhookRepository,
} from './resources';
import { ReviewRepository } from './reviews';
import { RoleMappingRepository } from './role-mapping';
import { RoleRepository } from './roles';
import { ScheduleSlotRepository } from './schedule-slots';
import { ScimRepository } from './scim';
import { SecretConnectionRepository } from './secrets';
import { ShareRepository } from './shares';
import { SsoRepository } from './sso';
import { StaticDataRepository } from './static-data';
import { TestRunRepository } from './test-runs';
import { UserMfaRepository } from './user-mfa';
import { UserTokenRepository } from './user-tokens';
import { TagRepository, WorkflowRepository, WorkflowVersionRepository } from './workflows';

export interface Repositories {
  tenants: TenantRepository;
  users: UserRepository;
  memberships: MembershipRepository;
  sessions: SessionRepository;
  invitations: InvitationRepository;
  apiKeys: ApiKeyRepository;
  workflows: WorkflowRepository;
  versions: WorkflowVersionRepository;
  tags: TagRepository;
  credentials: CredentialRepository;
  executions: ExecutionRepository;
  webhooks: WebhookRepository;
  variables: VariableRepository;
  audit: AuditRepository;
  usage: UsageRepository;
  idempotency: IdempotencyRepository;
  staticData: StaticDataRepository;
  scheduleSlots: ScheduleSlotRepository;
  /** P3-07 (L8) */
  folders: FolderRepository;
  favorites: FavoriteRepository;
  /** P3-09 (L9) */
  annotations: AnnotationRepository;
  /** P3-16 (L12) */
  publishHistory: PublishHistoryRepository;
  /** P3-19 (L14) */
  reviews: ReviewRepository;
  /** P4-03 (L4) */
  dataTables: DataTableRepository;
  /** P4-07 (L9) */
  secrets: SecretConnectionRepository;
  /** P5-02 (L8) */
  testRuns: TestRunRepository;
  /** P5-66 (L6) */
  builderSessions: BuilderSessionRepository;
  /** P5-14 (L10) */
  mcpOAuth: McpOAuthRepository;
  /** P5-67 (L1) */
  assistantThreads: AssistantThreadRepository;
  /** P5-68 (L3) */
  assistantConfirmations: AssistantConfirmationRepository;
  /** P5-72 (L9) */
  assistantMcp: AssistantMcpRepository;
  /** P6-03 (L1): projects and their relations (`projects.relations`) */
  projects: ProjectRepository;
  /** P6-29 (L9): workflow and credential shares */
  shares: ShareRepository;
  /** P6-32 (L11): custom roles */
  roles: RoleRepository;
  /** P6-18 (S2 L2): MFA secrets and recovery codes (global) */
  userMfa: UserMfaRepository;
  /** P6-19 (S2 L3): password reset and email change tokens (global) */
  userTokens: UserTokenRepository;
  /** P6-01 (S2 L6): sign-in settings and directory identities; `upsert` from C0 */
  sso: SsoRepository;
  /** P6-20 (S2 L4): the members page query */
  membersList: MembersListRepository;
  /** P6-11 (S2 L9): role mapping rules */
  roleMapping: RoleMappingRepository;
  /** P6-12 (S2 L10): LDAP sync history */
  ldapHistory: LdapHistoryRepository;
  /** P6-02 (S2 L13): the SCIM token */
  scim: ScimRepository;
  /** P6-15 (S2 L14): private credential entries */
  credentialEntries: CredentialEntryRepository;
  /** P6-16 (S2 L15): OAuth JWE keys */
  jweKeys: JweKeyRepository;
}

export function createRepositories(db: DbOrTx): Repositories {
  return {
    tenants: new TenantRepository(db),
    users: new UserRepository(db),
    memberships: new MembershipRepository(db),
    sessions: new SessionRepository(db),
    invitations: new InvitationRepository(db),
    apiKeys: new ApiKeyRepository(db),
    workflows: new WorkflowRepository(db),
    versions: new WorkflowVersionRepository(db),
    tags: new TagRepository(db),
    credentials: new CredentialRepository(db),
    executions: new ExecutionRepository(db),
    webhooks: new WebhookRepository(db),
    variables: new VariableRepository(db),
    audit: new AuditRepository(db),
    usage: new UsageRepository(db),
    idempotency: new IdempotencyRepository(db),
    staticData: new StaticDataRepository(db),
    scheduleSlots: new ScheduleSlotRepository(db),
    folders: new FolderRepository(db),
    favorites: new FavoriteRepository(db),
    annotations: new AnnotationRepository(db),
    publishHistory: new PublishHistoryRepository(db),
    reviews: new ReviewRepository(db),
    dataTables: new DataTableRepository(db),
    secrets: new SecretConnectionRepository(db),
    testRuns: new TestRunRepository(db),
    builderSessions: new BuilderSessionRepository(db),
    mcpOAuth: new McpOAuthRepository(db),
    assistantThreads: new AssistantThreadRepository(db),
    assistantConfirmations: new AssistantConfirmationRepository(db),
    assistantMcp: new AssistantMcpRepository(db),
    projects: new ProjectRepository(db),
    shares: new ShareRepository(db),
    roles: new RoleRepository(db),
    userMfa: new UserMfaRepository(db),
    userTokens: new UserTokenRepository(db),
    sso: new SsoRepository(db),
    membersList: new MembersListRepository(db),
    roleMapping: new RoleMappingRepository(db),
    ldapHistory: new LdapHistoryRepository(db),
    scim: new ScimRepository(db),
    credentialEntries: new CredentialEntryRepository(db),
    jweKeys: new JweKeyRepository(db),
  };
}

export type {
  ApiKeyListRow,
  ApiKeyWithOwnerRow,
  MemberRecord,
  MembershipState,
} from './accounts';
export type { AnnotationFilter, AnnotationVote, ExecutionAnnotationDTO } from './annotations';
export type {
  AssistantConfirmationRow,
  AssistantConfirmationStatus,
  NewAssistantConfirmation,
} from './assistant-confirmations';
export type { AssistantMcpConnectionInput, AssistantMcpConnectionRow } from './assistant-mcp';
export type {
  AssistantEventRow,
  AssistantMessageListOptions,
  AssistantMessageRow,
  AssistantThreadListQuery,
  AssistantThreadRow,
  NewAssistantMessage,
} from './assistant-threads';
export type { BuilderSessionPatch, BuilderSessionRow } from './builder-sessions';
export type { FavoriteResourceType } from './favorites';
export type { SyncRunCounts } from './ldap-history';
export type {
  OAuthAccessTokenInsert,
  OAuthAccessTokenRow,
  OAuthAuthorizationCodeInsert,
  OAuthAuthorizationCodeRow,
  OAuthClientInsert,
  OAuthClientRow,
  OAuthRefreshTokenInsert,
  OAuthRefreshTokenRow,
  OAuthSweepResult,
  OAuthUserConsentInsert,
  OAuthUserConsentRow,
} from './mcp-oauth';
export type {
  MemberListQuery,
  MemberListRow,
  MemberListSort,
  MemberListStatus,
} from './members-list';
export type {
  MovedResources,
  ProjectCreateInput,
  ProjectMemberRecord,
  ProjectPatch,
  UserProjectRecord,
} from './projects';
export { PERSONAL_OWNER_ROLE, ProjectRelationRepository, ProjectRepository } from './projects';
export type { PublishEvent, PublishTimelineEntry } from './publish-history';
export type { AuditEntry, CredentialListOptions, VariableListOptions } from './resources';
export type { RoleMappingRuleInput, RoleMappingRuleRecord, RoleMappingRuleType } from './role-mapping';
export type { RoleCreateInput, RolePatch, RoleType } from './roles';
export { RoleRepository } from './roles';
export type {
  AccessListOptions,
  CredentialShareRecord,
  ShareKind,
  ShareProjectRef,
  ShareSetResult,
  WorkflowShareRecord,
} from './shares';
export { DEFAULT_SHARE_ROLE, ShareRepository } from './shares';
export type { SsoMethod, SsoProviderType, SsoSettingsPatch } from './sso';
export { SsoRepository } from './sso';
export type {
  TestCaseListOptions,
  TestCasePatch,
  TestRunInsert,
  TestRunListOptions,
  TestRunPatch,
} from './test-runs';
export type { UserTokenKind } from './user-tokens';
export { isUniqueViolation, isUuid, pgErrorCode } from './util';
export type { TagRef, WorkflowContent, WorkflowListFilter } from './workflows';
