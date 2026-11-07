/**
 * Evaluations: node types, limits, statuses, error codes with their editor texts, and the test run DTOs
 * the server answers and the editor reads. No Node API.
 */
import type { DataObject } from './interfaces';

export const EVALUATION_TRIGGER_TYPE = 'core.evaluationTrigger';
export const EVALUATION_NODE_TYPE = 'core.evaluation';
/** the Evaluation Trigger's custom operation the runner forces to read the dataset */
export const DATASET_GET_ROWS = 'dataset.getRows';
/** most dataset rows (test cases) one run takes */
export const MAX_EVALUATION_ROWS = 1000;
/** most cases one run keeps in flight; the tenant pool may cap it lower */
export const MAX_EVALUATION_CONCURRENCY = 10;

export type TestRunStatus = 'new' | 'running' | 'completed' | 'error' | 'cancelled';
export type TestCaseStatus = 'new' | 'running' | 'success' | 'error' | 'cancelled';

/** why a whole run failed (n8n's codes, without the config-based evaluation ones) */
export type TestRunErrorCode =
  | 'EVALUATION_TRIGGER_NOT_FOUND'
  | 'EVALUATION_TRIGGER_NOT_CONFIGURED'
  | 'EVALUATION_TRIGGER_DISABLED'
  | 'SET_OUTPUTS_NODE_NOT_CONFIGURED'
  | 'SET_METRICS_NODE_NOT_FOUND'
  | 'SET_METRICS_NODE_NOT_CONFIGURED'
  | 'CANT_FETCH_TEST_CASES'
  | 'TEST_CASES_NOT_FOUND'
  | 'INTERRUPTED'
  | 'UNKNOWN_ERROR';

/** why one case failed */
export type TestCaseErrorCode =
  | 'FAILED_TO_EXECUTE_WORKFLOW'
  | 'NO_METRICS_COLLECTED'
  | 'INVALID_METRICS'
  | 'UNKNOWN_ERROR';

export const TEST_RUN_ERROR_TEXTS: Readonly<Record<TestRunErrorCode, string>> = {
  EVALUATION_TRIGGER_NOT_FOUND: 'Evaluation trigger missing',
  EVALUATION_TRIGGER_NOT_CONFIGURED: 'Evaluation trigger is not configured',
  EVALUATION_TRIGGER_DISABLED: 'Evaluation trigger is disabled',
  SET_OUTPUTS_NODE_NOT_CONFIGURED: "'Set outputs' node is not configured",
  SET_METRICS_NODE_NOT_FOUND: "No 'Set metrics' node in workflow",
  SET_METRICS_NODE_NOT_CONFIGURED: "'Set metrics' node is not configured",
  CANT_FETCH_TEST_CASES: "Couldn't fetch test cases from the dataset",
  TEST_CASES_NOT_FOUND: 'No matching rows in dataset',
  INTERRUPTED: 'Test run was interrupted',
  UNKNOWN_ERROR: 'Unknown error',
};

/** a second line the editor shows under some run errors */
export const TEST_RUN_ERROR_HINTS: Readonly<Partial<Record<TestRunErrorCode, string>>> = {
  TEST_CASES_NOT_FOUND: 'Check any filters or limits set in the evaluation trigger',
};

export const TEST_CASE_ERROR_TEXTS: Readonly<Record<TestCaseErrorCode, string>> = {
  FAILED_TO_EXECUTE_WORKFLOW: 'Failed to execute workflow',
  NO_METRICS_COLLECTED: "No 'Set metrics' node executed",
  INVALID_METRICS: 'Evaluation metrics node returned invalid metrics. Only numeric values are expected.',
  UNKNOWN_ERROR: 'Unknown error',
};

/** other evaluation texts the editor keeps from n8n */
export const EVALUATION_TEXTS = {
  /** a completed run whose `finalResult` is `error` */
  finishedWithErrors: 'Finished with errors',
  /** the start request failed */
  couldNotStart: "Couldn't start test run",
} as const;

/** metrics the runner adds to every case besides the user's */
export const PREDEFINED_METRICS = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'executionTime',
] as const;
export type PredefinedMetric = (typeof PREDEFINED_METRICS)[number];

/** metric name to number */
export type EvaluationMetrics = Record<string, number>;

/** worst case status of a completed run */
export type TestRunFinalResult = 'success' | 'error';

/** cases of a run per status, plus the total */
export type TestCaseCounts = Record<TestCaseStatus, number> & { total: number };

/** a test run as REST and the public API answer it; dates are ISO strings */
export interface TestRunDto {
  id: string;
  workflowId: string;
  status: TestRunStatus;
  runAt: string | null;
  completedAt: string | null;
  /** mean per metric name over the cases that have it; null until completed */
  metrics: EvaluationMetrics | null;
  errorCode: TestRunErrorCode | null;
  /** node name, redacted message, execution id; never a stack or run data */
  errorDetails: DataObject | null;
  /** cases in flight at once, 1 to `MAX_EVALUATION_CONCURRENCY` */
  concurrency: number;
  /** only when completed */
  finalResult: TestRunFinalResult | null;
  caseCounts: TestCaseCounts;
  createdAt: string;
  updatedAt: string;
}

/** one dataset row of a run; dates are ISO strings */
export interface TestCaseDto {
  id: string;
  testRunId: string;
  executionId: string | null;
  status: TestCaseStatus;
  /** index of the row in the dataset */
  runIndex: number;
  runAt: string | null;
  completedAt: string | null;
  errorCode: TestCaseErrorCode | null;
  errorDetails: DataObject | null;
  metrics: EvaluationMetrics | null;
  inputs: DataObject | null;
  outputs: DataObject | null;
}
