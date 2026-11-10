/**
 * P6-17 (L1): the share mails (n8n's workflow, credential and project shared notices). Each goes to the
 * people of the given projects (or the given users), skips the actor, and never throws: a mail that fails
 * is logged, the share stands. Called after the write by services/sharing.ts and services/projects.ts (C0).
 * Stub from C0: they PASS (send nothing) until L1.
 */
import type { ServiceDeps } from '../context';

/** a workflow was shared with `projectIds` (the projects added, not the whole list) */
export async function workflowShared(
  _deps: ServiceDeps,
  _tenantId: string,
  _actorId: string,
  _workflowId: string,
  _projectIds: string[],
): Promise<void> {
  // stub (L1): PASSES, no mail
}

/** a credential was shared with `projectIds` (the projects added) */
export async function credentialShared(
  _deps: ServiceDeps,
  _tenantId: string,
  _actorId: string,
  _credentialId: string,
  _projectIds: string[],
): Promise<void> {
  // stub (L1): PASSES, no mail
}

/** `userIds` were added to the team project `projectId` */
export async function projectShared(
  _deps: ServiceDeps,
  _tenantId: string,
  _actorId: string,
  _projectId: string,
  _userIds: string[],
): Promise<void> {
  // stub (L1): PASSES, no mail
}
