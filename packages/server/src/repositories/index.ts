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
import { DataTableRepository } from './data-tables';
import { ExecutionRepository } from './executions';
import { FavoriteRepository } from './favorites';
import { FolderRepository } from './folders';
import { McpOAuthRepository } from './mcp-oauth';
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
import { ScheduleSlotRepository } from './schedule-slots';
import { SecretConnectionRepository } from './secrets';
import { StaticDataRepository } from './static-data';
import { TestRunRepository } from './test-runs';
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
  };
}

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
export type { PublishEvent, PublishTimelineEntry } from './publish-history';
export type { AuditEntry } from './resources';
export type {
  TestCaseListOptions,
  TestCasePatch,
  TestRunInsert,
  TestRunListOptions,
  TestRunPatch,
} from './test-runs';
export { isUniqueViolation, isUuid, pgErrorCode } from './util';
export type { TagRef, WorkflowContent, WorkflowListFilter } from './workflows';
