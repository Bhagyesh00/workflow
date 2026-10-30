import { NodeOperationError } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import {
  appendWithinBudget,
  MEMORY_BUFFER_MAX_BYTES_PER_TENANT,
  messagesBytes,
} from '../src/nodes/memory/memory.nodes';
import {
  documentBytes,
  MEMORY_STORE_MAX_BYTES_PER_TENANT,
  MEMORY_STORE_MAX_CONTENT_CHARS,
  MEMORY_STORE_MAX_DIMENSIONS,
  MemoryVectorBackend,
} from '../src/nodes/vector-stores/vector-stores.nodes';
import { TenantStore } from '../src/shared/tenant-store';

const doc = (pageContent: string) => ({ pageContent, metadata: {} });

describe('TenantStore byte budget', () => {
  const sizeOf = (value: string) => value.length;

  it('evicts the least recently used keys of a tenant once the byte budget is exceeded', () => {
    const store = new TenantStore<string>({
      maxKeysPerTenant: 100,
      maxTenants: 10,
      maxBytesPerTenant: 10,
      sizeOf,
    });
    store.set('t', 'a', '1234');
    store.set('t', 'b', '1234');
    store.set('t', 'c', '1234');
    expect(store.keys('t')).toEqual(['b', 'c']);
    expect(store.bytesUsed('t')).toBe(8);
  });

  it('never counts or evicts another tenant', () => {
    const store = new TenantStore<string>({
      maxKeysPerTenant: 100,
      maxTenants: 10,
      maxBytesPerTenant: 5,
      sizeOf,
    });
    store.set('other', 'a', '1234');
    store.set('t', 'a', '1234');
    store.set('t', 'b', '1234');
    expect(store.keys('other')).toEqual(['a']);
    expect(store.keys('t')).toEqual(['b']);
  });

  it('re-checks the budget after a stored value grows in place', () => {
    const grow = { n: 2 };
    const store = new TenantStore<{ n: number }>({
      maxKeysPerTenant: 100,
      maxTenants: 10,
      maxBytesPerTenant: 10,
      sizeOf: (v) => v.n,
    });
    store.set('t', 'old', { n: 6 });
    store.set('t', 'grow', grow);
    grow.n = 8;
    store.settle('t', 'grow');
    expect(store.keys('t')).toEqual(['grow']);
  });

  it('rejects a single value larger than the whole budget', () => {
    const store = new TenantStore<string>({
      maxKeysPerTenant: 100,
      maxTenants: 10,
      maxBytesPerTenant: 3,
      sizeOf,
    });
    expect(() => store.set('t', 'a', '12345')).toThrow(/budget/);
    expect(store.keys('t')).toEqual([]);
  });
});

describe('Simple Vector Store limits', () => {
  it('exposes bounded default limits', () => {
    expect(MEMORY_STORE_MAX_BYTES_PER_TENANT).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(MEMORY_STORE_MAX_DIMENSIONS).toBeLessThanOrEqual(8192);
  });

  it('rejects vectors over the dimension cap with a NodeOperationError', async () => {
    const backend = new MemoryVectorBackend(100, { maxDimensions: 4 });
    const error = await backend.add([doc('a')], [[1, 2, 3, 4, 5]]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/5 dimensions/);
    expect(backend.size).toBe(0);
  });

  it('rejects documents over the content cap', async () => {
    const backend = new MemoryVectorBackend(100, { maxContentChars: 10 });
    await expect(backend.add([doc('x'.repeat(11))], [[1]])).rejects.toBeInstanceOf(NodeOperationError);
    expect(backend.size).toBe(0);
  });

  it('rejects the whole batch when any document is invalid so nothing is half inserted', async () => {
    const backend = new MemoryVectorBackend(100, { maxContentChars: 10 });
    await expect(backend.add([doc('ok'), doc('x'.repeat(11))], [[1], [1]])).rejects.toBeInstanceOf(
      NodeOperationError,
    );
    expect(backend.size).toBe(0);
  });

  it('rejects a non-array vector and a vector count that does not match the documents', async () => {
    const backend = new MemoryVectorBackend(100);
    await expect(backend.add([doc('a')], [])).rejects.toBeInstanceOf(NodeOperationError);
  });

  it('rejects vectors holding anything but finite numbers so the byte budget cannot be bypassed', async () => {
    const backend = new MemoryVectorBackend(100);
    const bad: unknown[][] = [
      ['x'.repeat(1_000_000)],
      [[1, 2, 3]],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      [null],
      // biome-ignore lint/suspicious/noSparseArray: a hole is one of the invalid shapes under test
      [1, , 3],
    ];
    for (const vector of bad) {
      const error = await backend.add([doc('a')], [vector as number[]]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NodeOperationError);
      expect((error as Error).message).toMatch(/finite numbers/);
    }
    expect(backend.size).toBe(0);
    expect(backend.bytes).toBe(0);
  });

  it('stores a copy of the vector so later changes to the caller array do not change what is searched', async () => {
    const backend = new MemoryVectorBackend(100);
    const vector = [1, 0];
    await backend.add([doc('a')], [vector]);
    vector[0] = 0;
    vector[1] = 1;
    const [hit] = await backend.search([1, 0], 1);
    expect(hit.score).toBeCloseTo(1);
  });

  it('evicts the oldest documents when the store passes its byte budget', async () => {
    const one = documentBytes(doc('d1'), [1, 2]);
    const backend = new MemoryVectorBackend(1000, { maxBytes: one * 2 + 1 });
    await backend.add(
      [doc('d1'), doc('d2'), doc('d3')],
      [
        [1, 2],
        [1, 2],
        [1, 2],
      ],
    );
    expect(backend.size).toBe(2);
    expect(backend.bytes).toBeLessThanOrEqual(one * 2 + 1);
    expect((await backend.search([1, 2], 10)).map((r) => r.document.pageContent).sort()).toEqual([
      'd2',
      'd3',
    ]);
  });

  it('reports a changed size to the owner after every add and clear', async () => {
    let calls = 0;
    const backend = new MemoryVectorBackend(1000, { onChange: () => calls++ });
    await backend.add([doc('a')], [[1]]);
    await backend.clear();
    expect(calls).toBe(2);
    expect(backend.bytes).toBe(0);
  });

  it('counts vector and content size in the byte estimate', () => {
    expect(documentBytes(doc('x'.repeat(100)), new Array(1000).fill(0))).toBeGreaterThan(8000 + 200);
    expect(MEMORY_STORE_MAX_CONTENT_CHARS).toBeGreaterThan(0);
  });
});

describe('Simple Memory limits', () => {
  const msg = (content: string) => ({ role: 'user' as const, content });

  it('bounds the default budget', () => {
    expect(MEMORY_BUFFER_MAX_BYTES_PER_TENANT).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('drops the oldest messages of a session that outgrows the byte budget', () => {
    const stored = [msg('a'.repeat(100)), msg('b'.repeat(100))];
    const next = appendWithinBudget(stored, [msg('c'.repeat(100))], 5, 600);
    expect(next.map((m) => m.content[0])).toEqual(['b', 'c']);
    expect(messagesBytes(next)).toBeLessThanOrEqual(600);
  });

  it('keeps the window of messages when the budget is not reached', () => {
    const next = appendWithinBudget([msg('a'), msg('b')], [msg('c')], 1, 1_000_000);
    expect(next).toHaveLength(3);
  });

  it('always keeps the newest message', () => {
    const next = appendWithinBudget([msg('a')], [msg('z'.repeat(1000))], 5, 10);
    expect(next).toHaveLength(1);
    expect(next[0].content[0]).toBe('z');
  });
});
