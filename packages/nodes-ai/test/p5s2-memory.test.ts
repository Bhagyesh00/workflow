/**
 * Phase 5 S2 C0e contracts: the memory split (session.ts, memory-shared.ts), the new memory, tool
 * and helper names, and `ConnectionContext`. Every assertion stays true after the lanes fill the
 * stubs (L12, L18, L19, L20, L21, L25), so nothing here asserts a stub's throw.
 */
import type { AiChatMessage, LoadOptionsContext, NodeType, SupplyDataContext } from '@workflow/workflow';
import { portType } from '@workflow/workflow';
import { describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import * as memoryNodesModule from '../src/nodes/memory/memory.nodes';
import { memoryNodes } from '../src/nodes/memory/memory.nodes';
import * as memoryShared from '../src/nodes/memory/memory-shared';
import { logged } from '../src/nodes/memory/memory-shared';
import { readSessionKey, sessionProperties } from '../src/nodes/memory/session';
import { toolNodes } from '../src/nodes/tools/tools.nodes';
import type { SessionMemory } from '../src/shared/ai-inputs';
import { sharedPostgres, sharedRedis } from '../src/shared/connections';
import * as fileText from '../src/shared/file-text';
import * as mongo from '../src/shared/mongo';
import { type ConnectionContext, sharedKey } from '../src/shared/shared-resource';

const byName = (list: NodeType[], name: string) => list.find((t) => t.description.name === name);
const inputTypes = (t: NodeType) =>
  Array.isArray(t.description.inputs) ? t.description.inputs.map(portType) : [];
const outputTypes = (t: NodeType) =>
  Array.isArray(t.description.outputs) ? t.description.outputs.map(portType) : [];

describe('logged memory wrapper', () => {
  function fakeMemory() {
    const stored: AiChatMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ];
    const calls: Array<[string, unknown[]]> = [];
    const memory: SessionMemory = {
      kind: 'memory',
      sessionId: 's1',
      async load(sessionId) {
        calls.push(['load', [sessionId]]);
        return stored.slice(-1);
      },
      async loadAll(sessionId) {
        calls.push(['loadAll', [sessionId]]);
        return stored;
      },
      async append(sessionId, messages) {
        calls.push(['append', [sessionId, messages]]);
      },
      async replace(sessionId, messages) {
        calls.push(['replace', [sessionId, messages]]);
      },
      async clear(sessionId) {
        calls.push(['clear', [sessionId]]);
      },
    };
    return { memory, calls, stored };
  }
  const ctx = () => ({ logSubNodeRun: vi.fn() }) as unknown as SupplyDataContext;

  it('passes loadAll through with the session id and returns the full history', async () => {
    const { memory, calls, stored } = fakeMemory();
    const wrapped = logged(ctx(), memory);
    expect(wrapped.kind).toBe('memory');
    expect(wrapped.sessionId).toBe('s1');
    expect(await wrapped.loadAll('s1')).toEqual(stored);
    expect(calls).toContainEqual(['loadAll', ['s1']]);
  });

  it('passes replace through with the session id and the messages', async () => {
    const { memory, calls } = fakeMemory();
    const wrapped = logged(ctx(), memory);
    const next: AiChatMessage[] = [{ role: 'user', content: 'only', hideFromUI: true }];
    await wrapped.replace('s2', next);
    expect(calls).toContainEqual(['replace', ['s2', next]]);
  });

  it('keeps load, append and clear on the wrapped store', async () => {
    const { memory, calls } = fakeMemory();
    const wrapped = logged(ctx(), memory);
    expect(await wrapped.load('s1')).toEqual([{ role: 'assistant', content: 'two' }]);
    await wrapped.append('s1', [{ role: 'user', content: 'three' }]);
    await wrapped.clear('s1');
    expect(calls.map(([name]) => name)).toEqual(['load', 'append', 'clear']);
  });
});

describe('memory split', () => {
  it('memory.nodes.ts re-exports the stored message helpers of memory-shared.ts', () => {
    expect(memoryNodesModule.toStoredMessage).toBe(memoryShared.toStoredMessage);
    expect(memoryNodesModule.fromStoredMessage).toBe(memoryShared.fromStoredMessage);
  });

  it('memory-shared.ts and session.ts export the shared parts', () => {
    expect(memoryShared.windowProperty.name).toBe('contextWindowLength');
    expect(typeof memoryShared.windowSize).toBe('function');
    expect(typeof memoryShared.memoryDescription).toBe('function');
    expect(Array.isArray(sessionProperties)).toBe(true);
    expect(sessionProperties.length).toBeGreaterThan(0);
    expect(typeof readSessionKey).toBe('function');
  });

  it('the three existing memory nodes show the session properties', () => {
    for (const name of ['ai.memoryBufferWindow', 'ai.memoryPostgresChat', 'ai.memoryRedisChat']) {
      const props = byName(memoryNodes, name)!.description.properties.map((p) => p.name);
      for (const p of sessionProperties) expect(props, name).toContain(p.name);
    }
  });
});

describe('new memory nodes', () => {
  it('are listed in memoryNodes and registered in the package, once each', () => {
    for (const name of [
      'ai.memoryManager',
      'ai.memoryMongoDbChat',
      'ai.memoryXata',
      'ai.memoryLakebaseChat',
    ]) {
      expect(byName(memoryNodes, name), name).toBeDefined();
      expect(nodes.filter((t) => t.description.name === name).length, name).toBe(1);
    }
  });

  it('memory stores output ai_memory with their credential', () => {
    const expected: Record<string, string> = {
      'ai.memoryMongoDbChat': 'mongoDb',
      'ai.memoryXata': 'xataApi',
      'ai.memoryLakebaseChat': 'databricksOAuth2Api',
    };
    for (const [name, credential] of Object.entries(expected)) {
      const type = byName(memoryNodes, name)!;
      expect(outputTypes(type), name).toEqual(['ai_memory']);
      expect(inputTypes(type), name).toEqual([]);
      expect(
        type.description.credentials?.map((c) => c.name),
        name,
      ).toContain(credential);
      expect(typeof type.supplyData, name).toBe('function');
    }
  });

  it('MongoDB memory is tested by mongoDbConnectionTest', () => {
    const type = byName(memoryNodes, 'ai.memoryMongoDbChat')!;
    const entry = type.description.credentials!.find((c) => c.name === 'mongoDb')!;
    expect(entry.testedBy).toBe('mongoDbConnectionTest');
    expect(type.methods?.credentialTest?.mongoDbConnectionTest).toBe(mongo.mongoDbConnectionTest);
  });

  it('Chat Memory Manager takes main and ai_memory in and gives main out', () => {
    const type = byName(memoryNodes, 'ai.memoryManager')!;
    expect(inputTypes(type)).toEqual(['main', 'ai_memory']);
    expect(outputTypes(type)).toEqual(['main']);
    expect(typeof type.execute).toBe('function');
  });
});

describe('search tool nodes', () => {
  it('are listed in toolNodes and registered in the package, once each', () => {
    for (const name of ['ai.toolSearXng', 'ai.toolWikipedia', 'ai.toolWolframAlpha']) {
      const type = byName(toolNodes, name);
      expect(type, name).toBeDefined();
      expect(outputTypes(type!), name).toEqual(['ai_tool']);
      expect(typeof type!.supplyData, name).toBe('function');
      expect(nodes.filter((t) => t.description.name === name).length, name).toBe(1);
    }
  });

  it('SearXNG and Wolfram|Alpha use their credentials', () => {
    expect(byName(toolNodes, 'ai.toolSearXng')!.description.credentials?.map((c) => c.name)).toContain(
      'searXngApi',
    );
    expect(byName(toolNodes, 'ai.toolWolframAlpha')!.description.credentials?.map((c) => c.name)).toContain(
      'wolframAlphaApi',
    );
  });
});

describe('ConnectionContext', () => {
  it('a list search context fits the shared connection helpers (type check)', () => {
    const asConnection = (ctx: LoadOptionsContext): ConnectionContext => ctx;
    const openers: Array<(ctx: LoadOptionsContext, itemIndex: number) => Promise<unknown>> = [
      sharedPostgres,
      sharedRedis,
      mongo.sharedMongo,
    ];
    expect(typeof asConnection).toBe('function');
    expect(openers).toHaveLength(3);
  });

  it('sharedKey scopes by tenant, execution and node and never keeps a part in clear', () => {
    const ctx = {
      getTenantId: () => 't1',
      getExecutionId: () => 'e1',
      getNode: () => ({ name: 'Memory' }),
    } as unknown as ConnectionContext;
    const key = sharedKey(ctx, 'postgres', { password: 'secret-value' });
    const [tenant, execution, nodeName, digest] = key.split('\u0000');
    expect([tenant, execution, nodeName]).toEqual(['t1', 'e1', 'Memory']);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('secret-value');
    expect(sharedKey(ctx, 'postgres', { password: 'other' })).not.toBe(key);
  });
});

describe('helper modules exist with their final names', () => {
  it('shared/mongo.ts', () => {
    const exported: Record<string, unknown> = mongo;
    for (const name of [
      'sharedMongo',
      'buildMongoOptions',
      'startMongoGuard',
      'sanitizeMongoError',
      'mongoDbConnectionTest',
    ] as const) {
      expect(typeof exported[name], name).toBe('function');
    }
  });

  it('shared/file-text.ts', () => {
    expect(typeof fileText.fileToSources).toBe('function');
    expect(typeof fileText.itemJsonToSources).toBe('function');
    const loader: fileText.LoaderKind = 'epubLoader';
    const options: fileText.FileTextOptions = { loader, separator: ';', splitPages: true };
    const source: fileText.TextSource = { text: 'x', metadata: { loader: options.loader } };
    expect(source.metadata.loader).toBe('epubLoader');
  });
});
