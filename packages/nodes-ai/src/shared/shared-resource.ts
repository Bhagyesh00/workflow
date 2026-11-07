/**
 * Resources shared by the supply calls of one sub-node within one execution. The engine supplies
 * a sub-node once per item and runs close functions only when the root node finishes, so without
 * sharing, 1,000 items would hold 1,000 open database connections (or MCP sessions) at once.
 * Each acquire adds a reference; the resource closes when the last reference is released.
 */
import { createHash } from 'node:crypto';
import type { BaseContext } from '@workflow/workflow';

interface Entry {
  value: Promise<unknown>;
  refs: number;
}

const entries = new Map<string, Entry>();

/**
 * What opening a shared connection needs from a node context. A list search (`LoadOptionsContext`)
 * fits as well as an execution context, so a list search can open the same connection.
 */
export type ConnectionContext = Pick<
  BaseContext,
  'getCredentials' | 'helpers' | 'logger' | 'getTenantId' | 'getExecutionId' | 'getNode'
>;

export interface Shared<T> {
  value: T;
  release: () => Promise<void>;
}

/** Key scoped to tenant, execution and node; secrets in `parts` are hashed, never kept in clear. */
export function sharedKey(ctx: ConnectionContext, ...parts: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return [ctx.getTenantId(), ctx.getExecutionId(), ctx.getNode().name, digest].join('\u0000');
}

export async function acquireShared<T>(
  key: string,
  open: () => Promise<T>,
  close: (value: T) => Promise<void>,
): Promise<Shared<T>> {
  let entry = entries.get(key);
  if (!entry) {
    const value = open();
    entry = { value, refs: 0 };
    entries.set(key, entry);
    // a failed open is not cached: the next acquire tries again
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
  }
  const current = entry;
  current.refs++;
  let value: T;
  try {
    value = (await current.value) as T;
  } catch (error) {
    current.refs--;
    throw error;
  }
  let released = false;
  return {
    value,
    release: async () => {
      if (released) return;
      released = true;
      current.refs--;
      if (current.refs === 0 && entries.get(key) === current) {
        entries.delete(key);
        await close(value);
      }
    },
  };
}

/** open shared resources (for tests) */
export function sharedResourceCount(): number {
  return entries.size;
}
