/**
 * P6-25 (L5): the Simple Vector Store keeps one set of stores per project (`getProjectId()` in the key), so
 * project B cannot read project A's store by the same key; the store list of the picker shows the keys of
 * the caller's project only. The workspace caps stay per workspace. (Deviation named in the plan: n8n's
 * store is instance wide.)
 */
import type { DataObject, Item, LoadOptionsContext, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearMemoryVectorStores,
  VectorStoreInMemoryNode,
} from '../src/nodes/vector-stores/vector-stores.nodes';
import { projectScopedKey } from '../src/shared/tenant-store';
import { connect, node, run, services } from './harness';

const DOCS: Item[] = [
  { json: { text: 'Cats and dogs are pets' } },
  { json: { text: 'A car has an engine' } },
];

const store = (mode: string, extra: DataObject = {}) =>
  node('Store', 'ai.vectorStoreInMemory', { mode, memoryKey: 'shared_key', ...extra });

const loader = () =>
  node('Loader', 'ai.documentDefaultDataLoader', {
    jsonMode: 'expressionData',
    jsonData: '={{ $json.text }}',
  });

async function insert(svc: ReturnType<typeof services>) {
  const s: WorkflowNode = store('insert');
  return run(
    [node('Trigger', 'test.trigger'), s, loader(), node('Embeddings', 'test.fakeEmbeddings')],
    connect(
      ['Trigger', 'Store'],
      ['Loader', 'Store', 'ai_document'],
      ['Embeddings', 'Store', 'ai_embedding'],
    ),
    { triggerItems: DOCS, services: svc },
  );
}

async function load(svc: ReturnType<typeof services>) {
  return run(
    [node('Trigger', 'test.trigger'), store('load', { topK: 10 }), node('Embeddings', 'test.fakeEmbeddings')],
    connect(['Trigger', 'Store'], ['Embeddings', 'Store', 'ai_embedding']),
    { triggerItems: [{ json: { chatInput: 'dog' } }], services: svc },
  );
}

const inProject = (projectId: string, tenantId = 't1') => services({ tenantId, projectId });

function pickerContext(tenantId: string, projectId: string): LoadOptionsContext {
  return { getTenantId: () => tenantId, getProjectId: () => projectId } as unknown as LoadOptionsContext;
}

describe('Simple Vector Store key per project', () => {
  beforeEach(() => clearMemoryVectorStores());

  it('project B cannot read project A store by the same key', async () => {
    const inserted = await insert(inProject('project-a'));
    expect(inserted.status, JSON.stringify(inserted.error)).toBe('success');
    const other = await load(inProject('project-b'));
    expect(other.status).toBe('success');
    expect(other.output('Store')).toEqual([]);
    const own = await load(inProject('project-a'));
    expect(own.output('Store')).toHaveLength(2);
  });

  it('the same project in another workspace is another store too', async () => {
    await insert(inProject('project-a', 'tenant-1'));
    expect((await load(inProject('project-a', 'tenant-2'))).output('Store')).toEqual([]);
  });

  it('the store picker lists the keys of the caller project only', async () => {
    await insert(inProject('project-a'));
    const search = VectorStoreInMemoryNode.methods!.listSearch!.vectorStoresSearch;
    const own = await search(pickerContext('t1', 'project-a'));
    expect(own.results).toEqual([{ name: 'shared_key', value: 'shared_key' }]);
    const other = await search(pickerContext('t1', 'project-b'));
    expect(other.results).toEqual([]);
  });

  it('a key always carries a project', () => {
    expect(projectScopedKey('p1', 'kb')).toBe('p1/kb');
    expect(projectScopedKey('p1', 'a/b')).not.toBe(projectScopedKey('p1/a', 'b'));
    expect(() => projectScopedKey('', 'kb')).toThrow('A project id is required');
  });
});
