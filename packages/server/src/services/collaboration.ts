/**
 * P6-81 (L14): who has a workflow open and who may write it. State in Redis (queue mode) or memory, the
 * tenant in the key (the Redis-or-memory pattern of services/form-auth.ts). Presence expires 15 minutes
 * after the last heartbeat, the write lock 2 minutes after (n8n collaboration.state.ts:38, :196). Changes
 * are pushed with `{ workflowId }`, so S1's filter drops users who cannot read the workflow.
 * - `assertWritable` (the seven editor write routes, C0d2): no client id passes; another user's lock 423;
 *   the same user's other tab 409.
 * - `assertNoLock` (MCP and Assistant writes, `AssistantDrafts.accept`): 423 "Cannot modify workflow while
 *   it is being edited by a user in the editor." while any lock is held.
 * - `workflowSaved` (after `WorkflowService.update`, C0d2) pushes `workflowUpdated`; never throws.
 * Times are epoch milliseconds read from `Date.now()` and compared on read, so a test moves them with a
 * fake clock; the stores' own expiry only cleans up.
 */
import type { ServiceDeps } from '../context';
import type { UserRow } from '../db/schema';
import { ApiError } from '../http/errors';

/** someone with the workflow open */
export interface Collaborator {
  userId: string;
  name: string;
  email: string;
  /** ISO time of the last heartbeat */
  lastSeen: string;
}

/** who may write the workflow now */
export interface WriteLock {
  userId: string;
  /** the holding tab's `push-ref` */
  clientId: string;
  name: string;
  /** ISO */
  expiresAt: string;
}

/** the answer of POST /workflows/:id/presence and /write-access */
export interface CollaborationState {
  collaborators: Collaborator[];
  writeLock: WriteLock | null;
}

/** what a collaborator shows (a `UserRow` fits) */
export type CollaborationUser = Pick<UserRow, 'id' | 'email'> & {
  firstName?: string | null;
  lastName?: string | null;
};

/** the write routes that check the lock (a restore checks as `save`) */
export type WorkflowWriteAction = 'save' | 'delete' | 'archive' | 'unarchive' | 'publish' | 'unpublish';

/** presence expires 15 minutes after the last heartbeat (n8n collaboration.state.ts:38) */
export const PRESENCE_TTL_MS = 15 * 60_000;
/** the write lock expires 2 minutes after the last heartbeat (n8n collaboration.state.ts:196) */
export const WRITE_LOCK_TTL_MS = 2 * 60_000;

export const LOCKED_MESSAGE = 'Cannot modify workflow while it is being edited by a user in the editor.';
const OTHER_TAB_MESSAGE = 'This workflow is open for editing in another tab. Take over editing there first.';

/** one open tab of one user */
interface PresenceEntry {
  userId: string;
  clientId: string;
  name: string;
  email: string;
  /** epoch ms of the last heartbeat */
  seen: number;
}

/** the stored lock (epoch ms) */
interface LockEntry {
  userId: string;
  clientId: string;
  name: string;
  expires: number;
}

/**
 * Redis side of "do this only while this tab still holds the lock": the compare and the write are one
 * step, so a `force` that lands between a read and the write is not overwritten or deleted.
 * KEYS[1] lock key; ARGV[1] user id, ARGV[2] client id; refresh: ARGV[3] new lock JSON, ARGV[4] ttl ms.
 */
const HELD_BY = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, lock = pcall(cjson.decode, raw)
if not ok or type(lock) ~= 'table' or lock.userId ~= ARGV[1] or lock.clientId ~= ARGV[2] then return 0 end
`;
const REFRESH_IF_HELD = `${HELD_BY}redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
return 1`;
const REMOVE_IF_HELD = `${HELD_BY}redis.call('DEL', KEYS[1])
return 1`;

const nameOf = (user: CollaborationUser): string =>
  [user.firstName, user.lastName]
    .filter((part): part is string => !!part?.trim())
    .join(' ')
    .trim() || user.email;

const clientIdOf = (clientId: string | string[] | undefined): string | undefined => {
  const value = Array.isArray(clientId) ? clientId[0] : clientId;
  return value?.trim() ? value : undefined;
};

export class CollaborationService {
  /** used only when the server runs without Redis, so with one process */
  private readonly presence = new Map<string, Map<string, PresenceEntry>>();
  private readonly locks = new Map<string, LockEntry>();

  constructor(readonly deps: ServiceDeps) {}

  /** POST presence `open` */
  async opened(
    tenantId: string,
    workflowId: string,
    user: CollaborationUser,
    clientId: string,
  ): Promise<CollaborationState> {
    await this.touch(tenantId, workflowId, user, clientId);
    return this.state(tenantId, workflowId);
  }

  /** POST presence `close` (also releases this tab's lock) */
  async closed(
    tenantId: string,
    workflowId: string,
    userId: string,
    clientId: string,
  ): Promise<CollaborationState> {
    const before = await this.collaborators(tenantId, workflowId);
    await this.dropPresence(tenantId, workflowId, userId, clientId);
    await this.dropLockOf(tenantId, workflowId, userId, clientId);
    await this.announce(tenantId, workflowId, before);
    return this.state(tenantId, workflowId);
  }

  /** POST presence `heartbeat`, and write-access `heartbeat` (keeps the lock) */
  async heartbeat(
    tenantId: string,
    workflowId: string,
    user: CollaborationUser,
    clientId: string,
  ): Promise<CollaborationState> {
    await this.touch(tenantId, workflowId, user, clientId);
    const lock = await this.lockOf(tenantId, workflowId);
    if (lock && lock.userId === user.id && lock.clientId === clientId) {
      // not a plain write: a take over between the read and here keeps its lock
      await this.refreshLockIf(tenantId, workflowId, user.id, clientId, {
        ...lock,
        expires: Date.now() + WRITE_LOCK_TTL_MS,
      });
    }
    return this.state(tenantId, workflowId);
  }

  /** write-access `request` (`force`: take over another user's lock) */
  async requestWrite(
    tenantId: string,
    workflowId: string,
    user: CollaborationUser,
    clientId: string,
    options: { force?: boolean } = {},
  ): Promise<CollaborationState> {
    await this.touch(tenantId, workflowId, user, clientId);
    const next: LockEntry = {
      userId: user.id,
      clientId,
      name: nameOf(user),
      expires: Date.now() + WRITE_LOCK_TTL_MS,
    };
    let held = await this.lockOf(tenantId, workflowId);
    const isHolder = (lock: LockEntry | undefined) => lock?.userId === user.id && lock.clientId === clientId;
    // this tab already holds it: a repeat request keeps it (compared and written in one step)
    const kept = isHolder(held) && (await this.refreshLockIf(tenantId, workflowId, user.id, clientId, next));
    if (!kept) {
      // it changed hands since the read: look again
      if (isHolder(held)) held = await this.lockOf(tenantId, workflowId);
      let acquired = false;
      if (held) {
        if (options.force) {
          await this.putLock(tenantId, workflowId, next);
          acquired = true;
        }
      } else {
        acquired = await this.claimLock(tenantId, workflowId, next);
      }
      if (acquired) {
        this.send(tenantId, workflowId, 'writeAccessAcquired', { workflowId, userId: user.id, clientId });
      }
    }
    return this.state(tenantId, workflowId);
  }

  /** write-access `release` */
  async release(
    tenantId: string,
    workflowId: string,
    userId: string,
    clientId: string,
  ): Promise<CollaborationState> {
    await this.dropLockOf(tenantId, workflowId, userId, clientId);
    return this.state(tenantId, workflowId);
  }

  /**
   * the editor write routes: `clientId` is the request's `push-ref` header (absent passes: the public API,
   * the services). The workflow id is unique across workspaces, so the lock is read in the workspace the
   * workflow belongs to (found through the user's memberships).
   */
  async assertWritable(
    user: Pick<UserRow, 'id'>,
    clientId: string | string[] | undefined,
    workflowId: string,
    _action: WorkflowWriteAction,
  ): Promise<void> {
    const client = clientIdOf(clientId);
    if (!client) return;
    const tenantId = await this.tenantOf(user.id, workflowId);
    if (!tenantId) return;
    const lock = await this.lockOf(tenantId, workflowId);
    if (!lock) return;
    if (lock.userId !== user.id) throw new ApiError(423, 'locked', LOCKED_MESSAGE);
    if (lock.clientId !== client) throw new ApiError(409, 'conflict', OTHER_TAB_MESSAGE);
  }

  /** MCP and Assistant writes: 423 while any lock is held */
  async assertNoLock(tenantId: string, workflowId: string): Promise<void> {
    if (await this.lockOf(tenantId, workflowId)) throw new ApiError(423, 'locked', LOCKED_MESSAGE);
  }

  /** after a save: pushes `workflowUpdated` to the others; never throws */
  workflowSaved(tenantId: string, workflowId: string, userId?: string): void {
    try {
      this.send(tenantId, workflowId, 'workflowUpdated', { workflowId, userId: userId ?? '' });
    } catch {
      // a push that cannot go out never fails the save
    }
  }

  /** the lock and the collaborators of one workflow (the answer of every call) */
  async state(tenantId: string, workflowId: string): Promise<CollaborationState> {
    const [collaborators, lock] = await Promise.all([
      this.collaborators(tenantId, workflowId),
      this.lockOf(tenantId, workflowId),
    ]);
    return {
      collaborators,
      writeLock: lock
        ? {
            userId: lock.userId,
            clientId: lock.clientId,
            name: lock.name,
            expiresAt: new Date(lock.expires).toISOString(),
          }
        : null,
    };
  }

  // ---- keys and storage ----

  private key(tenantId: string, workflowId: string, part: 'presence' | 'lock'): string {
    return `${this.deps.config.queue.prefix}:collab:${tenantId}:${workflowId}:${part}`;
  }

  private async tenantOf(userId: string, workflowId: string): Promise<string | undefined> {
    const { repos } = this.deps;
    for (const { id: tenantId } of await repos.memberships.listForUser(userId)) {
      if (await repos.workflows.get(tenantId, workflowId)) return tenantId;
    }
    return undefined;
  }

  /** adds or refreshes this tab; pushes the list when a user joined */
  private async touch(
    tenantId: string,
    workflowId: string,
    user: CollaborationUser,
    clientId: string,
  ): Promise<void> {
    const before = await this.collaborators(tenantId, workflowId);
    const entry: PresenceEntry = {
      userId: user.id,
      clientId,
      name: nameOf(user),
      email: user.email,
      seen: Date.now(),
    };
    const field = `${user.id}:${clientId}`;
    const { redis } = this.deps.context();
    if (redis) {
      const key = this.key(tenantId, workflowId, 'presence');
      await redis.multi().hset(key, field, JSON.stringify(entry)).pexpire(key, PRESENCE_TTL_MS).exec();
    } else {
      const k = `${tenantId}:${workflowId}`;
      const map = this.presence.get(k) ?? new Map<string, PresenceEntry>();
      map.set(field, entry);
      this.presence.set(k, map);
    }
    await this.announce(tenantId, workflowId, before);
  }

  private async dropPresence(
    tenantId: string,
    workflowId: string,
    userId: string,
    clientId: string,
  ): Promise<void> {
    const field = `${userId}:${clientId}`;
    const { redis } = this.deps.context();
    if (redis) await redis.hdel(this.key(tenantId, workflowId, 'presence'), field);
    else this.presence.get(`${tenantId}:${workflowId}`)?.delete(field);
  }

  /** the live tabs (older than 15 minutes are dropped) */
  private async entries(tenantId: string, workflowId: string): Promise<PresenceEntry[]> {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    const { redis } = this.deps.context();
    if (redis) {
      const key = this.key(tenantId, workflowId, 'presence');
      const all = await redis.hgetall(key);
      const live: PresenceEntry[] = [];
      const stale: string[] = [];
      for (const [field, raw] of Object.entries(all)) {
        try {
          const entry = JSON.parse(raw) as PresenceEntry;
          if (entry.seen > cutoff) live.push(entry);
          else stale.push(field);
        } catch {
          stale.push(field);
        }
      }
      if (stale.length) await redis.hdel(key, ...stale);
      return live;
    }
    const map = this.presence.get(`${tenantId}:${workflowId}`);
    if (!map) return [];
    for (const [field, entry] of map) if (entry.seen <= cutoff) map.delete(field);
    return [...map.values()];
  }

  /** one row per user, the newest heartbeat of their tabs */
  private async collaborators(tenantId: string, workflowId: string): Promise<Collaborator[]> {
    const byUser = new Map<string, PresenceEntry>();
    for (const entry of await this.entries(tenantId, workflowId)) {
      const seen = byUser.get(entry.userId);
      if (!seen || seen.seen < entry.seen) byUser.set(entry.userId, entry);
    }
    return [...byUser.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId))
      .map((e) => ({
        userId: e.userId,
        name: e.name,
        email: e.email,
        lastSeen: new Date(e.seen).toISOString(),
      }));
  }

  /** pushes `collaboratorsChanged` when the set of users differs from `before` */
  private async announce(tenantId: string, workflowId: string, before: Collaborator[]): Promise<void> {
    const after = await this.collaborators(tenantId, workflowId);
    const ids = (list: Collaborator[]) => list.map((c) => c.userId).join(',');
    if (ids(before) === ids(after)) return;
    this.send(tenantId, workflowId, 'collaboratorsChanged', { workflowId, collaborators: after });
  }

  /** the live lock; an expired one is removed and announced as released */
  private async lockOf(tenantId: string, workflowId: string): Promise<LockEntry | undefined> {
    const { redis } = this.deps.context();
    let lock: LockEntry | undefined;
    if (redis) {
      const raw = await redis.get(this.key(tenantId, workflowId, 'lock'));
      if (raw) {
        try {
          lock = JSON.parse(raw) as LockEntry;
        } catch {
          lock = undefined;
        }
      }
    } else {
      lock = this.locks.get(`${tenantId}:${workflowId}`);
    }
    if (!lock) return undefined;
    if (lock.expires > Date.now()) return lock;
    await this.removeLock(tenantId, workflowId);
    this.send(tenantId, workflowId, 'writeAccessReleased', { workflowId });
    return undefined;
  }

  private async removeLock(tenantId: string, workflowId: string): Promise<void> {
    const { redis } = this.deps.context();
    if (redis) await redis.del(this.key(tenantId, workflowId, 'lock'));
    else this.locks.delete(`${tenantId}:${workflowId}`);
  }

  private async putLock(tenantId: string, workflowId: string, lock: LockEntry): Promise<void> {
    const { redis } = this.deps.context();
    if (redis) {
      await redis.set(this.key(tenantId, workflowId, 'lock'), JSON.stringify(lock), 'PX', WRITE_LOCK_TTL_MS);
    } else {
      this.locks.set(`${tenantId}:${workflowId}`, lock);
    }
  }

  /** renews the lock only while this tab still holds it; false when it does not */
  private async refreshLockIf(
    tenantId: string,
    workflowId: string,
    userId: string,
    clientId: string,
    next: LockEntry,
  ): Promise<boolean> {
    const { redis } = this.deps.context();
    if (redis) {
      const done = await redis.eval(
        REFRESH_IF_HELD,
        1,
        this.key(tenantId, workflowId, 'lock'),
        userId,
        clientId,
        JSON.stringify(next),
        WRITE_LOCK_TTL_MS,
      );
      return done === 1;
    }
    // memory: no await between the compare and the write
    const k = `${tenantId}:${workflowId}`;
    const held = this.locks.get(k);
    if (!held || held.userId !== userId || held.clientId !== clientId) return false;
    this.locks.set(k, next);
    return true;
  }

  /** removes the lock only while this tab still holds it; false when it does not */
  private async removeLockIf(
    tenantId: string,
    workflowId: string,
    userId: string,
    clientId: string,
  ): Promise<boolean> {
    const { redis } = this.deps.context();
    if (redis) {
      const done = await redis.eval(
        REMOVE_IF_HELD,
        1,
        this.key(tenantId, workflowId, 'lock'),
        userId,
        clientId,
      );
      return done === 1;
    }
    const k = `${tenantId}:${workflowId}`;
    const held = this.locks.get(k);
    if (!held || held.userId !== userId || held.clientId !== clientId) return false;
    this.locks.delete(k);
    return true;
  }

  /** takes a free lock; false when another request won it first */
  private async claimLock(tenantId: string, workflowId: string, lock: LockEntry): Promise<boolean> {
    const { redis } = this.deps.context();
    if (redis) {
      const done = await redis.set(
        this.key(tenantId, workflowId, 'lock'),
        JSON.stringify(lock),
        'PX',
        WRITE_LOCK_TTL_MS,
        'NX',
      );
      return done === 'OK';
    }
    const k = `${tenantId}:${workflowId}`;
    const held = this.locks.get(k);
    if (held && held.expires > Date.now()) return false;
    this.locks.set(k, lock);
    return true;
  }

  /** removes the lock when this tab holds it, and announces it */
  private async dropLockOf(
    tenantId: string,
    workflowId: string,
    userId: string,
    clientId: string,
  ): Promise<void> {
    const lock = await this.lockOf(tenantId, workflowId);
    if (!lock || lock.userId !== userId || lock.clientId !== clientId) return;
    // a take over between the read and the delete keeps its lock, and nothing is announced
    if (await this.removeLockIf(tenantId, workflowId, userId, clientId)) {
      this.send(tenantId, workflowId, 'writeAccessReleased', { workflowId });
    }
  }

  private send(tenantId: string, workflowId: string, type: string, data: unknown): void {
    this.deps.context().push.send(tenantId, type, data, { workflowId });
  }
}
