/**
 * Removing a member (P6-31, L10): DELETE /members/:userId needs `transferToProjectId` or
 * `deleteData: true` (else 400; a named deviation: n8n's `transferId` may be left out). The member's
 * personal project's work moves to the chosen project or is deleted, then the membership goes (the
 * personal project and its relations cascade with it). S2 and S3 call these (P6-02, P6-12, P6-21). C0 stub:
 * both throw until L10.
 */
import type { ServerContext } from '../context';
import type { AuthContext } from '../http/auth';

/** the caller's choice for the removed member's personal work */
export type MemberRemovalChoice = { transferToProjectId: string } | { deleteData: true };

export async function removeMember(
  _ctx: ServerContext,
  _auth: AuthContext,
  _userId: string,
  _choice: MemberRemovalChoice,
): Promise<void> {
  throw new Error('not implemented (L10)');
}

/**
 * Moves the work of a member's personal project to `targetProjectId`, or deletes it when null
 * (`repos.projects.moveResources`).
 */
export async function transferPersonalWork(
  _ctx: ServerContext,
  _tenantId: string,
  _userId: string,
  _targetProjectId: string | null,
): Promise<void> {
  throw new Error('not implemented (L10)');
}
