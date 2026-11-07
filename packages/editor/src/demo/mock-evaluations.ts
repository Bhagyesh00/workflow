/**
 * Demo test runs (P5-11, lane L9): the 7 evaluation routes of the server (routes/evaluations.ts) on the
 * in-memory MockBackend. Viewers read; editors start, cancel and delete. DTOs are `TestRunDto` and
 * `TestCaseDto` of @workflow/workflow. The demo dataset is `demoEvaluationRows` (fixtures.ts); a case can run
 * through `backend.startExecution(wf, wf, { mode: 'evaluation', startNode, triggerItems: [row] })`.
 *
 * C0 registers every route with a 501 answer, so the paths are fixed; L9 writes the handlers.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

const LANE = 'L9';

export function registerEvaluationRoutes(backend: MockBackend): void {
  // list, newest first: ?limit, ?cursor (viewer)
  backend.on('GET', '/workflows/:id/test-runs', () => notImplemented(LANE));
  // one run with its case counts (viewer)
  backend.on('GET', '/workflows/:id/test-runs/:runId', () => notImplemented(LANE));
  // the cases of a run (viewer)
  backend.on('GET', '/workflows/:id/test-runs/:runId/test-cases', () => notImplemented(LANE));
  // start: body { concurrency?, rowIndices? }, answers { testRunId } (editor)
  backend.on('POST', '/workflows/:id/test-runs/new', () => notImplemented(LANE));
  // stop a new or running run (editor)
  backend.on('POST', '/workflows/:id/test-runs/:runId/cancel', () => notImplemented(LANE));
  // cancel one pending case (editor)
  backend.on('POST', '/workflows/:id/test-runs/:runId/test-cases/:caseId/cancel', () => notImplemented(LANE));
  // delete a run that is not running (editor)
  backend.on('DELETE', '/workflows/:id/test-runs/:runId', () => notImplemented(LANE));
}
