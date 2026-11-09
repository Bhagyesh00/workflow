/**
 * Workspace role words stored in `memberships.role` and `invitations.role` (Phase 6 S1). Kept apart from
 * schema.ts so the role type changes without editing the schema; schema.ts re-exports them.
 *
 * - `SystemRole`: the global roles of the project model (owner, admin, member).
 * - `LegacyRole`: the old words, kept only as the keys of the invitation accept map (services/auth.ts).
 * - `Role`: a system role or a custom global role slug. The old words (`editor`, `viewer`) are gone since
 *   the cutover (P6-39): migration 0024 rewrote the stored rows to `member` plus a team project relation, and
 *   a pending invitation that still holds one is mapped when it is accepted (`AuthService.acceptInvitation`).
 */
/** the old words a pending invitation from before the cutover may hold; no member holds one */
export type LegacyRole = 'editor' | 'viewer';
export type SystemRole = 'owner' | 'admin' | 'member';
export type Role = SystemRole | (string & {});
