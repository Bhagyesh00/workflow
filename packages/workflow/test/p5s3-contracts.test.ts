/** Phase 5 S3 contract step, C0a: chat protocol, evaluation contracts, redactSecrets, context and node type additions. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CHAT_AUTH_HEADER,
  CHAT_PAGE_HEADER,
  CHAT_PAGE_TOKEN_TTL_S,
  CHAT_TEST_HEADER,
  CHAT_TEST_TOKEN_TTL_S,
  CHAT_TOKEN_KINDS,
  CHAT_TOOL_TYPE,
  CHAT_TRIGGER_TYPE,
  type ChatChunkOptions,
  type ChatFrame,
  type ChatPageConfig,
  type ChatResponseMode,
  type ChatTokenKind,
  type ChatTriggerRef,
  DATASET_GET_ROWS,
  type DataObject,
  type DataTableAccess,
  type DataTableColumn,
  type DataTableColumnInput,
  EVALUATION_NODE_TYPE,
  EVALUATION_TEXTS,
  EVALUATION_TRIGGER_TYPE,
  type ExecuteContext,
  type Item,
  MAX_EVALUATION_CONCURRENCY,
  MAX_EVALUATION_ROWS,
  type NodeOutput,
  type NodeType,
  PREDEFINED_METRICS,
  redactSecrets,
  TEST_CASE_ERROR_TEXTS,
  TEST_RUN_ERROR_HINTS,
  TEST_RUN_ERROR_TEXTS,
  type TestCaseDto,
  type TestCaseErrorCode,
  type TestCaseStatus,
  type TestRunDto,
  type TestRunErrorCode,
  type TestRunStatus,
  type WebhookContext,
  type WebhookResponseData,
} from '../src';

/** reads a source file of this package; `process.getBuiltinModule` keeps the test free of Node type imports */
function readSource(file: string): string {
  const proc = (globalThis as { process?: { getBuiltinModule(id: string): unknown } }).process;
  const fs = proc?.getBuiltinModule('node:fs') as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
}

describe('chat protocol', () => {
  it('exports the headers, node types, token kinds and lifetimes', () => {
    expect(CHAT_PAGE_HEADER).toBe('x-chat-page');
    expect(CHAT_TEST_HEADER).toBe('x-chat-test-token');
    expect(CHAT_AUTH_HEADER).toBe('x-auth-token');
    expect(CHAT_TRIGGER_TYPE).toBe('ai.chatTrigger');
    expect(CHAT_TOOL_TYPE).toBe('ai.chatTool');
    expect(CHAT_TOKEN_KINDS).toEqual({
      page: 'chat-page',
      basic: 'chat-basic',
      user: 'chat-user',
      test: 'chat-test',
    });
    expect(new Set(Object.values(CHAT_TOKEN_KINDS)).size).toBe(4);
    expect(CHAT_PAGE_TOKEN_TTL_S).toBe(3600);
    expect(CHAT_TEST_TOKEN_TTL_S).toBe(120);
    expectTypeOf<ChatTokenKind>().toEqualTypeOf<'chat-page' | 'chat-basic' | 'chat-user' | 'chat-test'>();
    expectTypeOf<ChatResponseMode>().toEqualTypeOf<
      'lastNode' | 'streaming' | 'responseNode' | 'responseNodes'
    >();
  });

  it('the frame union compiles and narrows by type', () => {
    const metadata = { nodeId: 'n1', nodeName: 'Agent', runIndex: 0, itemIndex: 0, timestamp: 1 };
    const frames: ChatFrame[] = [
      { type: 'begin', metadata },
      { type: 'item', content: 'Hi', metadata },
      { type: 'end', metadata },
      { type: 'error', content: '', message: 'Couldn’t answer' },
      { type: 'error', content: '', message: 'x', metadata },
      { type: 'wait', resumeUrl: 'https://example.test/webhook-waiting/1' },
    ];
    const text = frames.map((f) => (f.type === 'item' ? f.content : f.type)).join(',');
    expect(text).toBe('begin,Hi,end,error,error,wait');
    // @ts-expect-error an item frame needs its metadata
    const bad: ChatFrame = { type: 'item', content: 'x' };
    expect(bad.type).toBe('item');
  });

  it('the page config has every widget option', () => {
    const config: ChatPageConfig = {
      webhookUrl: 'https://example.test/webhook/abc/chat',
      pageToken: 't',
      title: 'Hi there',
      subtitle: '',
      inputPlaceholder: 'Type your question..',
      getStarted: 'New conversation',
      initialMessages: ['Hi'],
      showWelcomeScreen: false,
      loadPreviousSession: true,
      allowFileUploads: false,
      allowedFilesMimeTypes: '*',
      enableStreaming: true,
      customCss: '',
    };
    expect(config.authToken).toBeUndefined();
    expectTypeOf<ChatPageConfig['authToken']>().toEqualTypeOf<string | undefined>();
  });
});

describe('evaluation contracts', () => {
  it('exports node types, operation and limits', () => {
    expect(EVALUATION_TRIGGER_TYPE).toBe('core.evaluationTrigger');
    expect(EVALUATION_NODE_TYPE).toBe('core.evaluation');
    expect(DATASET_GET_ROWS).toBe('dataset.getRows');
    expect(MAX_EVALUATION_ROWS).toBe(1000);
    expect(MAX_EVALUATION_CONCURRENCY).toBe(10);
    expect(PREDEFINED_METRICS).toEqual(['promptTokens', 'completionTokens', 'totalTokens', 'executionTime']);
    expectTypeOf<TestRunStatus>().toEqualTypeOf<'new' | 'running' | 'completed' | 'error' | 'cancelled'>();
    expectTypeOf<TestCaseStatus>().toEqualTypeOf<'new' | 'running' | 'success' | 'error' | 'cancelled'>();
  });

  it('has an editor text for every error code and no config-based code', () => {
    const runCodes = Object.keys(TEST_RUN_ERROR_TEXTS) as TestRunErrorCode[];
    expect(runCodes).toContain('EVALUATION_TRIGGER_NOT_FOUND');
    expect(runCodes).toContain('INTERRUPTED');
    expect(runCodes).not.toContain('EVALUATION_CONFIG_NOT_FOUND');
    expect(runCodes).not.toContain('COMPILATION_FAILED');
    for (const text of [...Object.values(TEST_RUN_ERROR_TEXTS), ...Object.values(TEST_CASE_ERROR_TEXTS)]) {
      expect(text.length).toBeGreaterThan(0);
    }
    expect(TEST_RUN_ERROR_TEXTS.TEST_CASES_NOT_FOUND).toBe('No matching rows in dataset');
    expect(TEST_RUN_ERROR_HINTS.TEST_CASES_NOT_FOUND).toBe(
      'Check any filters or limits set in the evaluation trigger',
    );
    expect(TEST_RUN_ERROR_TEXTS.INTERRUPTED).toBe('Test run was interrupted');
    expect(TEST_CASE_ERROR_TEXTS.NO_METRICS_COLLECTED).toBe("No 'Set metrics' node executed");
    expect(TEST_CASE_ERROR_TEXTS.INVALID_METRICS).toBe(
      'Evaluation metrics node returned invalid metrics. Only numeric values are expected.',
    );
    expect(EVALUATION_TEXTS.finishedWithErrors).toBe('Finished with errors');
    expectTypeOf<TestCaseErrorCode>().toEqualTypeOf<
      'FAILED_TO_EXECUTE_WORKFLOW' | 'NO_METRICS_COLLECTED' | 'INVALID_METRICS' | 'UNKNOWN_ERROR'
    >();
  });

  it('the DTOs carry the plan fields', () => {
    const run: TestRunDto = {
      id: 'r1',
      workflowId: 'w1',
      status: 'completed',
      runAt: '2026-11-08T00:00:00.000Z',
      completedAt: '2026-11-08T00:01:00.000Z',
      metrics: { accuracy: 0.5, executionTime: 12 },
      errorCode: null,
      errorDetails: null,
      concurrency: 3,
      finalResult: 'error',
      caseCounts: { total: 2, new: 0, running: 0, success: 1, error: 1, cancelled: 0 },
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:01:00.000Z',
    };
    const testCase: TestCaseDto = {
      id: 'c1',
      testRunId: run.id,
      executionId: 'e1',
      status: 'error',
      runIndex: 1,
      runAt: run.runAt,
      completedAt: run.completedAt,
      errorCode: 'INVALID_METRICS',
      errorDetails: { metric: 'accuracy' },
      metrics: null,
      inputs: { question: 'q' },
      outputs: null,
    };
    expect(testCase.testRunId).toBe('r1');
    expect(run.caseCounts.total).toBe(2);
  });
});

describe('redactSecrets', () => {
  it('removes an sk- key and keeps the scheme of a bearer token', () => {
    const key = `sk-${'a'.repeat(32)}`;
    expect(redactSecrets(`key ${key} end`)).toBe('key [redacted] end');
    expect(redactSecrets(`Authorization: Bearer ${'b'.repeat(24)}`)).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets('nothing secret here')).toBe('nothing secret here');
  });

  it('nodes-ai re-exports the same function', () => {
    const utils = readSource('../../nodes-ai/src/shared/utils.ts');
    expect(utils).toContain("export { redactSecrets } from '@workflow/workflow';");
    expect(utils).not.toContain('SECRET_PATTERNS');
  });
});

describe('no Node API in the browser-safe files', () => {
  it.each(['chat-protocol.ts', 'evaluation.ts', 'redact.ts'])('%s', (file) => {
    const source = readSource(file);
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(
      /from\s+['"](fs|path|crypto|os|url|http|https|stream|buffer|util|child_process)['"]/,
    );
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\bBuffer\b/);
    // only type imports from this package
    for (const line of source.split('\n').filter((l) => /^import\s/.test(l))) {
      expect(line).toMatch(/^import type .* from '\.\/[a-z-]+';?\s*$/);
    }
  });
});

describe('context and node type additions', () => {
  it('Item, sendChunk, getChatTrigger, webhook context, response data, custom operations, addColumn', () => {
    const item: Item = { json: {}, evaluationData: { score: 1 } };
    expect(item.evaluationData).toEqual({ score: 1 });

    expectTypeOf<ExecuteContext['sendChunk']>().toEqualTypeOf<
      (chunk: unknown, options?: ChatChunkOptions) => void
    >();
    expectTypeOf<ChatChunkOptions>().toEqualTypeOf<{ itemIndex?: number }>();
    expectTypeOf<ExecuteContext['getChatTrigger']>().toEqualTypeOf<() => ChatTriggerRef | null>();
    expectTypeOf<WebhookContext['getChatTrigger']>().toEqualTypeOf<() => ChatTriggerRef | null>();
    expectTypeOf<WebhookContext['isPublicChatDisabled']>().toEqualTypeOf<() => boolean>();
    expectTypeOf<WebhookContext['getInputConnectionData']>().toEqualTypeOf<
      ExecuteContext['getInputConnectionData']
    >();
    expectTypeOf<ChatTriggerRef>().toEqualTypeOf<{
      name: string;
      type: string;
      parameters: Record<string, unknown>;
    }>();

    const response: WebhookResponseData = { workflowData: [[item]], customData: { chatSessionId: 's1' } };
    expect(response.customData?.chatSessionId).toBe('s1');

    const node: Pick<NodeType, 'customOperations'> = {
      customOperations: {
        [DATASET_GET_ROWS]: async (): Promise<NodeOutput> => [[{ json: { a: 1 } as DataObject }]],
      },
    };
    expect(Object.keys(node.customOperations ?? {})).toEqual(['dataset.getRows']);

    expectTypeOf<DataTableAccess['addColumn']>().toEqualTypeOf<
      (id: string, column: DataTableColumnInput) => Promise<DataTableColumn>
    >();
  });
});
