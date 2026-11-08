/** Phase 4 contract step, C0a: data table constants and error texts, `$execution.resumeFormUrl`, new contract types. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createDataProxy,
  DATA_TABLE_COLUMN_NAME_MAX,
  DATA_TABLE_COLUMN_NAME_RE,
  DATA_TABLE_COLUMN_TYPES,
  DATA_TABLE_ERRORS,
  DATA_TABLE_FILTER_CONDITIONS,
  DATA_TABLE_NAME_MAX,
  DATA_TABLE_RESERVED_COLUMNS,
  DATA_TABLE_SYSTEM_COLUMNS,
  type DataTableAccess,
  type DataTableDryRunRow,
  type DataTableInsertResult,
  type DataTableRow,
  type ExecuteContext,
  type ExpressionDataContext,
  ExpressionEvaluator,
  type FormAuthHelper,
  type FormUser,
  type NodeCredentialDescription,
  type NodeCredentialTestResult,
  type NodeHelpers,
  type NodeType,
  type ResourceLocatorMode,
  type RunCodeOptions,
  type TriggerContext,
  type TriggerRunResult,
  type WebhookContext,
  type WebhookDescription,
  type WebhookResponse,
} from '../src';

function context(extra: Partial<ExpressionDataContext> = {}): ExpressionDataContext {
  return {
    workflow: { name: 'w', active: false, nodes: {} },
    runData: {},
    activeNodeName: 'Set',
    connectionInputData: [{ json: {} }],
    itemIndex: 0,
    runIndex: 0,
    mode: 'manual',
    executionId: 'e1',
    timezone: 'UTC',
    ...extra,
  };
}

describe('data table contract', () => {
  it('has the limits, types and conditions of n8n', () => {
    expect(DATA_TABLE_NAME_MAX).toBe(128);
    expect(DATA_TABLE_COLUMN_NAME_MAX).toBe(63);
    expect(DATA_TABLE_COLUMN_TYPES).toEqual(['string', 'number', 'boolean', 'date']);
    expect(DATA_TABLE_FILTER_CONDITIONS).toEqual([
      'eq',
      'neq',
      'like',
      'ilike',
      'gt',
      'gte',
      'lt',
      'lte',
      'isEmpty',
      'isNotEmpty',
    ]);
  });

  it('column name regex takes a leading letter, then letters, digits and underscores', () => {
    for (const ok of ['a', 'A1', 'first_name', 'x_1_y']) {
      expect(DATA_TABLE_COLUMN_NAME_RE.test(ok)).toBe(true);
    }
    for (const bad of ['', '1a', '_a', 'a b', 'a-b', 'é', "a'; drop table x", '__proto__', 'a\n']) {
      expect(DATA_TABLE_COLUMN_NAME_RE.test(bad)).toBe(false);
    }
  });

  it('system columns are id, createdAt, updatedAt; reserved adds dryRunState', () => {
    expect(DATA_TABLE_SYSTEM_COLUMNS).toEqual(['id', 'createdAt', 'updatedAt']);
    expect(DATA_TABLE_RESERVED_COLUMNS).toEqual(['id', 'createdAt', 'updatedAt', 'dryRunState']);
  });

  it('error texts are the ones n8n shows', () => {
    expect(DATA_TABLE_ERRORS.tableNameExists('T')).toBe(
      "Data table with name 'T' already exists in this project",
    );
    expect(DATA_TABLE_ERRORS.columnNameExists('x', 'T')).toBe(
      "Data table column with name 'x' already exists in data table 'T'",
    );
    expect(DATA_TABLE_ERRORS.columnNameReserved('id')).toBe(
      'Column name "id" is reserved as a system column name.',
    );
    expect(DATA_TABLE_ERRORS.columnNameInvalid).toBe(
      'Only alphabetical characters and non-leading numbers and underscores are allowed for column names, and the maximum length is 63 characters.',
    );
    expect(DATA_TABLE_ERRORS.filterEmpty).toBe('Filter must not be empty');
    expect(DATA_TABLE_ERRORS.filterRequiredForDelete).toBe(
      'Filter is required for delete operations to prevent accidental deletion of all data',
    );
    expect(DATA_TABLE_ERRORS.unknownColumn('x')).toBe("unknown column name 'x'");
    expect(DATA_TABLE_ERRORS.valueTypeMismatch('v', 'number')).toBe(
      "value 'v' does not match column type 'number'",
    );
    expect(DATA_TABLE_ERRORS.sizeLimitExceeded(201, 200)).toBe(
      'Data table size limit exceeded: 201MB used, limit is 200MB',
    );
    expect(DATA_TABLE_ERRORS.tableIdNotFound('abc')).toBe(
      "Data table with ID 'abc' could not be found in this project",
    );
    expect(DATA_TABLE_ERRORS.tableNameNotFound('T')).toBe('Data table with name "T" not found');
    expect(DATA_TABLE_ERRORS.atLeastOneCondition).toBe('At least one condition is required');
    expect(DATA_TABLE_ERRORS.invalidDate('x', 'c')).toBe("Invalid date string 'x' for column 'c'");
    expect(DATA_TABLE_ERRORS.filterColumnsMissing(['x', 'y'])).toContain('Column(s) "x", "y" do not exist');
  });

  it('types: insert result follows returnType, access reachable from helpers', () => {
    expectTypeOf<DataTableInsertResult<'all'>>().toEqualTypeOf<DataTableRow[]>();
    expectTypeOf<DataTableInsertResult<'id'>>().toEqualTypeOf<Array<{ id: number }>>();
    expectTypeOf<DataTableInsertResult<'count'>>().toEqualTypeOf<{ success: true; insertedRows: number }>();
    expectTypeOf<DataTableDryRunRow['dryRunState']>().toEqualTypeOf<'before' | 'after'>();
    expectTypeOf<NodeHelpers['dataTables']>().toEqualTypeOf<DataTableAccess | undefined>();
  });
});

describe('$execution.resumeFormUrl', () => {
  it('is in the proxy next to resumeUrl', () => {
    const proxy = createDataProxy(
      context({ resumeUrl: '/r', resumeFormUrl: '/form-waiting/e1?signature=s' }),
    );
    const $execution = proxy.$execution as Record<string, unknown>;
    expect($execution.resumeUrl).toBe('/r');
    expect($execution.resumeFormUrl).toBe('/form-waiting/e1?signature=s');
  });

  it('resolves in an expression and is undefined when the host sets none', () => {
    const evaluator = new ExpressionEvaluator();
    const expression = '={{ $execution.resumeFormUrl }}';
    expect(evaluator.evaluate(expression, context({ resumeFormUrl: '/form-waiting/e1' }))).toBe(
      '/form-waiting/e1',
    );
    expect(evaluator.evaluate(expression, context())).toBeUndefined();
  });
});

describe('contract types (checked by tsc, this package includes test/)', () => {
  it('descriptions', () => {
    expectTypeOf<WebhookDescription['nodeType']>().toEqualTypeOf<'form' | 'mcp' | undefined>();
    expectTypeOf<NodeCredentialDescription['testedBy']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NonNullable<ResourceLocatorMode['typeOptions']>['allowNewResource']>().toEqualTypeOf<
      { label: string; url: string } | undefined
    >();
    expectTypeOf<RunCodeOptions['language']>().toEqualTypeOf<'javaScript' | 'pythonNative' | undefined>();
    expectTypeOf<RunCodeOptions['query']>().toEqualTypeOf<unknown>();
  });

  it('contexts', () => {
    expectTypeOf<ExecuteContext['getChildNodes']>().returns.toEqualTypeOf<
      Array<{ name: string; type: string }>
    >();
    expectTypeOf<WebhookContext['getParentNodes']>().returns.toEqualTypeOf<
      Array<{ name: string; type: string }>
    >();
    expectTypeOf<WebhookContext['getFormAuth']>().returns.toEqualTypeOf<FormAuthHelper | undefined>();
    expectTypeOf<FormUser>().toEqualTypeOf<{
      id: string;
      email: string;
      firstName: string;
      lastName: string;
    }>();
    expectTypeOf<TriggerContext['emit']>()
      .parameter(2)
      .toEqualTypeOf<((r: WebhookResponse) => void) | undefined>();
    expectTypeOf<TriggerRunResult['executionId']>().toEqualTypeOf<string>();
    expectTypeOf<
      NonNullable<NonNullable<NodeType['methods']>['credentialTest']>[string]
    >().returns.toEqualTypeOf<Promise<NodeCredentialTestResult>>();
  });
});
