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
import { ExecutionRepository } from './executions';
import { FavoriteRepository } from './favorites';
import { FolderRepository } from './folders';
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
import { StaticDataRepository } from './static-data';
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
  };
}

export type { AnnotationFilter, AnnotationVote, ExecutionAnnotationDTO } from './annotations';
export type { FavoriteResourceType } from './favorites';
export type { PublishEvent, PublishTimelineEntry } from './publish-history';
export type { AuditEntry } from './resources';
export { isUniqueViolation, isUuid, pgErrorCode } from './util';
export type { TagRef, WorkflowContent, WorkflowListFilter } from './workflows';
