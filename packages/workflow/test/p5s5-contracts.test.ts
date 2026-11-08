/** Phase 5 S5 contract step, C0a: Assistant limits, permissions, events, DTOs and the tool annotations field. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type AiToolDefinition,
  ASSISTANT_ALWAYS_ALLOW_KEYS,
  ASSISTANT_ATTACHMENT_TYPES,
  ASSISTANT_ATTACHMENTS,
  ASSISTANT_EVENT_TYPES,
  ASSISTANT_LIVE_ONLY_EVENTS,
  ASSISTANT_MAX_ITERATIONS,
  ASSISTANT_PERMISSION_KEYS,
  ASSISTANT_PERMISSION_MODES,
  ASSISTANT_PREVIEW,
  ASSISTANT_RESULT_CHARS,
  ASSISTANT_STREAM,
  type AssistantArtifact,
  type AssistantConfirmAnswer,
  type AssistantConfirmation,
  type AssistantDraftDTO,
  type AssistantEvent,
  type AssistantEventOf,
  type AssistantEventType,
  type AssistantMcpConnectionDTO,
  type AssistantMessageDTO,
  type AssistantMessagesPage,
  type AssistantPermissionKey,
  type AssistantPermissionMode,
  type AssistantPermissions,
  type AssistantSendMessage,
  type AssistantSettingsDTO,
  type AssistantStatusDTO,
  type AssistantTask,
  type AssistantThreadDTO,
  type DataObject,
  DEFAULT_ASSISTANT_PERMISSIONS,
  isAssistantPermissionKey,
  isDurableAssistantEvent,
  resolveAssistantPermissions,
} from '../src';

/** reads a source file of this package; `process.getBuiltinModule` keeps the test free of Node type imports */
function readSource(file: string): string {
  const proc = (globalThis as { process?: { getBuiltinModule(id: string): unknown } }).process;
  const fs = proc?.getBuiltinModule('node:fs') as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
}

describe('Assistant limits', () => {
  it('has n8n values', () => {
    expect(ASSISTANT_MAX_ITERATIONS).toBe(50);
    expect(ASSISTANT_RESULT_CHARS).toBe(30000);
    expect(ASSISTANT_STREAM).toEqual({ idleMs: 90000, firstOutputMs: 180000, stallRetries: 1 });
    expect(ASSISTANT_ATTACHMENTS).toEqual({
      maxPerMessage: 10,
      fileBase64Bytes: 10485760,
      totalBase64Bytes: 16777216,
    });
    expect(ASSISTANT_PREVIEW).toEqual({ rows: 3, columns: 5, valueChars: 100 });
  });

  it('accepts the listed attachment types with their extensions', () => {
    for (const mime of [
      'text/csv',
      'text/tab-separated-values',
      'application/json',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/html',
      'text/plain',
      'text/markdown',
      'image/png',
      'image/jpeg',
    ]) {
      expect(ASSISTANT_ATTACHMENT_TYPES[mime]?.length, mime).toBeGreaterThan(0);
    }
    expect(ASSISTANT_ATTACHMENT_TYPES['application/pdf']).toEqual(['.pdf']);
    expect(ASSISTANT_ATTACHMENT_TYPES['application/x-msdownload']).toBeUndefined();
  });
});

describe('Assistant permissions', () => {
  it('lists the 22 keys, all require_approval by default', () => {
    expect(ASSISTANT_PERMISSION_KEYS).toHaveLength(22);
    expect(new Set(ASSISTANT_PERMISSION_KEYS).size).toBe(22);
    expect(Object.keys(DEFAULT_ASSISTANT_PERMISSIONS).sort()).toEqual([...ASSISTANT_PERMISSION_KEYS].sort());
    expect(Object.values(DEFAULT_ASSISTANT_PERMISSIONS).every((mode) => mode === 'require_approval')).toBe(
      true,
    );
    expect(Object.isFrozen(DEFAULT_ASSISTANT_PERMISSIONS)).toBe(true);
    expect(ASSISTANT_PERMISSION_MODES).toEqual(['require_approval', 'always_allow', 'blocked']);
    expect(ASSISTANT_ALWAYS_ALLOW_KEYS).toEqual(['fetchUrl', 'webSearch', 'mcpRead']);
    expect(isAssistantPermissionKey('runWorkflow')).toBe(true);
    expect(isAssistantPermissionKey('setPreferences')).toBe(false);
  });

  it('reads a saved always_allow on a write key as require_approval', () => {
    const resolved = resolveAssistantPermissions({ runWorkflow: 'always_allow', fetchUrl: 'always_allow' });
    expect(resolved.runWorkflow).toBe('require_approval');
    expect(resolved.fetchUrl).toBe('always_allow');
  });

  it('keeps blocked, fills missing keys and drops unknown keys and values', () => {
    const resolved = resolveAssistantPermissions({
      deleteWorkflow: 'blocked',
      webSearch: 'always_allow',
      mcpRead: 'always_allow',
      mcpWrite: 'always_allow',
      createWorkflow: 'sometimes',
      unknownKey: 'always_allow',
    });
    expect(resolved.deleteWorkflow).toBe('blocked');
    expect(resolved.webSearch).toBe('always_allow');
    expect(resolved.mcpRead).toBe('always_allow');
    expect(resolved.mcpWrite).toBe('require_approval');
    expect(resolved.createWorkflow).toBe('require_approval');
    expect(Object.keys(resolved)).toHaveLength(22);
    expect(resolved).not.toHaveProperty('unknownKey');
  });

  it('gives the defaults for nothing saved and does not share the default object', () => {
    expect(resolveAssistantPermissions(undefined)).toEqual(DEFAULT_ASSISTANT_PERMISSIONS);
    expect(resolveAssistantPermissions(null)).toEqual(DEFAULT_ASSISTANT_PERMISSIONS);
    const resolved = resolveAssistantPermissions({});
    resolved.fetchUrl = 'blocked';
    expect(DEFAULT_ASSISTANT_PERMISSIONS.fetchUrl).toBe('require_approval');
  });

  it('types the permission record', () => {
    expectTypeOf<AssistantPermissions[AssistantPermissionKey]>().toEqualTypeOf<AssistantPermissionMode>();
    expectTypeOf<AssistantPermissionMode>().toEqualTypeOf<'require_approval' | 'always_allow' | 'blocked'>();
  });
});

describe('Assistant events', () => {
  it("uses n8n's names", () => {
    expect(ASSISTANT_EVENT_TYPES).toEqual([
      'run-start',
      'text-delta',
      'text-block',
      'tool-call',
      'tool-result',
      'tool-error',
      'confirmation-request',
      'confirmation-resolved',
      'tasks-update',
      'artifact',
      'thread-title-updated',
      'status',
      'error',
      'run-finish',
    ]);
    expect(ASSISTANT_LIVE_ONLY_EVENTS).toEqual(['text-delta', 'status']);
  });

  it('stores every event but text-delta and status', () => {
    for (const type of ASSISTANT_EVENT_TYPES) {
      expect(isDurableAssistantEvent(type), type).toBe(type !== 'text-delta' && type !== 'status');
    }
    expect(isDurableAssistantEvent('not-an-event')).toBe(false);
  });

  it('discriminates the payload by type', () => {
    const finish: AssistantEvent = {
      type: 'run-finish',
      id: 7,
      runId: 'r1',
      payload: { status: 'suspended' },
    };
    const delta: AssistantEvent = { type: 'text-delta', runId: 'r1', payload: { text: 'Hi' } };
    const accepted: AssistantEvent = {
      type: 'artifact',
      id: 9,
      runId: null,
      payload: { artifact: { type: 'workflow', id: 'w1', name: 'Flow' } },
    };
    expect([finish.type, delta.type, accepted.runId]).toEqual(['run-finish', 'text-delta', null]);
    expectTypeOf<AssistantEventOf<'run-finish'>['payload']['status']>().toEqualTypeOf<
      'completed' | 'suspended' | 'cancelled' | 'error'
    >();
    expectTypeOf<AssistantEventOf<'tasks-update'>['payload']>().toEqualTypeOf<{ tasks: AssistantTask[] }>();
    expectTypeOf<AssistantEvent['type']>().toEqualTypeOf<AssistantEventType>();
  });
});

describe('Assistant DTOs', () => {
  it('builds a confirmation per input type and every answer kind', () => {
    const approval: AssistantConfirmation = {
      requestId: 'c1',
      toolCallId: 'call_1',
      toolName: 'publish_workflow',
      inputType: 'approval',
      title: 'Publish workflow',
      resourceName: 'Flow',
      details: { facts: [{ label: 'Workflow', value: 'Flow' }] },
      allowSession: true,
      expiresAt: null,
      createdAt: '2026-11-08T00:00:00.000Z',
    };
    const questions: AssistantConfirmation = {
      ...approval,
      inputType: 'questions',
      details: { questions: [{ id: 'q1', question: 'Which?', type: 'single', options: ['a', 'b'] }] },
      allowSession: false,
    };
    const domain: AssistantConfirmation = {
      ...approval,
      inputType: 'domain',
      details: { url: 'https://example.com/a', host: 'example.com' },
    };
    const credential: AssistantConfirmation = {
      ...approval,
      inputType: 'credential',
      details: { credentialType: 'slackApi' },
    };
    expect([approval, questions, domain, credential].map((c) => c.inputType)).toEqual([
      'approval',
      'questions',
      'domain',
      'credential',
    ]);
    const answers: AssistantConfirmAnswer[] = [
      { kind: 'approval', approved: true, scope: 'session' },
      { kind: 'questions', answers: [{ id: 'q1', answer: 'a' }] },
      { kind: 'questions', answers: [], dismissed: true },
      { kind: 'domain', action: 'allow_domain' },
      { kind: 'credential', credentialId: null },
    ];
    expect(answers).toHaveLength(5);
    expectTypeOf<AssistantConfirmation['expiresAt']>().toEqualTypeOf<string | null>();
  });

  it('shapes threads, messages, status and settings', () => {
    const thread: AssistantThreadDTO = { id: 't1', title: '', createdAt: 'x', updatedAt: 'x' };
    const message: AssistantMessageDTO = {
      id: 'm1',
      runId: null,
      role: 'user',
      content: 'Hi',
      attachments: [{ fileName: 'a.pdf', mimeType: 'application/pdf', size: 10 }],
      summarized: false,
      createdAt: 'x',
    };
    const page: AssistantMessagesPage = { messages: [message], nextEventId: 1 };
    const status: AssistantStatusDTO = { hasActiveRun: false, isSuspended: false, pending: [] };
    const body: AssistantSendMessage = {
      message: 'Read this',
      attachments: [{ data: 'aGk=', mimeType: 'text/plain', fileName: 'a.txt' }],
    };
    const artifacts: AssistantArtifact[] = [
      { type: 'data-table', id: 'd1', name: 'Rows' },
      { type: 'draft', draftId: 'dr1', name: 'Draft' },
    ];
    expect([thread.id, page.messages.length, status.pending.length, body.attachments?.length]).toEqual([
      't1',
      1,
      0,
      1,
    ]);
    expect(artifacts).toHaveLength(2);
    expectTypeOf<AssistantSettingsDTO['permissions']>().toEqualTypeOf<AssistantPermissions>();
    expectTypeOf<AssistantMcpConnectionDTO['credentialId']>().toEqualTypeOf<string | null>();
    expectTypeOf<AssistantDraftDTO['status']>().toEqualTypeOf<'open' | 'accepted' | 'discarded'>();
  });

  it('holds no secret or binary field in the MCP connection and message DTOs', () => {
    const source = readSource('assistant.ts');
    const block = (name: string) =>
      source.slice(source.indexOf(`export interface ${name}`)).split('\n}\n')[0];
    expect(block('AssistantMcpConnectionDTO')).not.toMatch(/\b(secret|token|password|data)\??:/);
    expect(block('AssistantMessageDTO')).not.toMatch(/\bbinary\??:/);
  });
});

describe('AiToolDefinition annotations', () => {
  it('is an optional DataObject', () => {
    expectTypeOf<AiToolDefinition['annotations']>().toEqualTypeOf<DataObject | undefined>();
    const def: AiToolDefinition = {
      name: 'read',
      description: 'Reads',
      parameters: { type: 'object' },
      annotations: { readOnlyHint: true },
    };
    expect(def.annotations).toEqual({ readOnlyHint: true });
  });
});

describe('assistant.ts uses no Node API', () => {
  it('imports nothing from Node', () => {
    const source = readSource('assistant.ts');
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\bBuffer\b/);
    expect(source).not.toMatch(/from\s+['"](fs|path|os|crypto|http|https|net|url|stream|child_process)['"]/);
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.every((spec) => spec.startsWith('./'))).toBe(true);
  });
});
