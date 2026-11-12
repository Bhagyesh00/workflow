/**
 * P6-58 (S5, L1): the user fields of an `audit.*` event, n8n's names: `userId`, `_email`, `_firstName`,
 * `_lastName`, `globalRole`. The keys that start with `_` are the ones a destination's "anonymize audit messages"
 * switch replaces with `*`. Read once per event, and only when a sink accepts the event (the stream builds the
 * payload lazily). A user who is gone, or an audit row with no user, gives no fields.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';

/** the account's name split at its first space (the account holds one `name`) */
export function splitName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const cut = trimmed.search(/\s/);
  if (cut < 0) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, cut), lastName: trimmed.slice(cut + 1).trim() };
}

/** `userId`, `_email`, `_firstName`, `_lastName` and `globalRole` (the role in this workspace, even when disabled) */
export async function userFieldsFor(
  deps: Pick<ServiceDeps, 'repos'>,
  tenantId: string,
  userId: string | null | undefined,
): Promise<DataObject> {
  if (!userId) return {};
  const user = await deps.repos.users.get(userId);
  if (!user) return { userId };
  const membership = await deps.repos.memberships.getIncludingDisabled(tenantId, userId);
  const { firstName, lastName } = splitName(user.name ?? '');
  return {
    userId: user.id,
    _email: user.email,
    _firstName: firstName,
    _lastName: lastName,
    globalRole: membership?.role ?? null,
  };
}
