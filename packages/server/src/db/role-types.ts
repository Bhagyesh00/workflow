/**
 * Workspace role words stored in `memberships.role` and `invitations.role` (Phase 6 S1). Kept apart from
 * schema.ts so the role cutover (L24) changes the role type without editing the schema; schema.ts
 * re-exports them.
 *
 * - `SystemRole`: the global roles of the project model (owner, admin, member).
 * - `LegacyRole`: the words of the old model, still valid until the cutover maps them to `member` plus a
 *   team project relation (migration 0024 rewrites existing rows).
 * - `Role`: any of those, or a custom global role slug.
 */
export type LegacyRole = 'editor' | 'viewer';
export type SystemRole = 'owner' | 'admin' | 'member';
export type Role = SystemRole | LegacyRole | (string & {});
