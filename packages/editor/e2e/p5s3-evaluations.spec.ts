/**
 * P5-11 in a real browser against a live server (written by the lane, run once by the main session at the
 * end of S3): a workflow with an Evaluation Trigger on a Data table and a Set Metrics node (custom metric)
 * is run from the Evaluations page, the run completes, the runs table shows the score column and the mean,
 * the chart draws a line for it, and the run page lists one case per dataset row with the metric. Run with
 * `pnpm --filter @workflow/editor e2e` (E2E_BASE_URL overrides the URL).
 */
import { expect, type Page, test } from '@playwright/test';

async function signUp(page: Page) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Eval Tester');
  await page.getByLabel('Work email').fill(`evals-${id}@example.com`);
  await page.getByLabel('Password').fill(`evals-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Evals ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);
}

/** a call of the signed-in app page */
function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async (request) => {
      const response = await fetch(`/rest${request.path}`, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      return (await response.json()) as { data: { id: string } };
    },
    { method, path, body },
  );
}

/** a Data table with three rows, and a workflow that reads it and scores every row with 2 */
async function createEvaluationWorkflow(page: Page): Promise<string> {
  const table = await api(page, 'POST', '/data-tables', {
    name: `Dataset ${Date.now()}`,
    columns: [
      { name: 'question', type: 'string' },
      { name: 'points', type: 'number' },
    ],
  });
  await api(page, 'POST', `/data-tables/${table.data.id}/insert`, {
    data: [
      { question: 'What is a webhook?', points: 2 },
      { question: 'What is a trigger?', points: 2 },
      { question: 'What is a node?', points: 2 },
    ],
  });
  const created = await api(page, 'POST', '/workflows', {
    name: `Evaluation ${Date.now()}`,
    nodes: [
      {
        id: 'trigger',
        name: 'Dataset',
        type: 'core.evaluationTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: { source: 'dataTable', dataTableId: { __rl: true, mode: 'id', value: table.data.id } },
      },
      {
        id: 'metrics',
        name: 'Metrics',
        type: 'core.evaluation',
        typeVersion: 1,
        position: [300, 0],
        parameters: {
          operation: 'setMetrics',
          metric: 'customMetrics',
          metrics: {
            assignments: [{ id: 'a1', name: 'score', value: '={{ $json.points }}', type: 'number' }],
          },
        },
      },
    ],
    connections: { Dataset: { main: [[{ node: 'Metrics', type: 'main', index: 0 }]] } },
    settings: {},
  });
  return created.data.id;
}

test('a person runs an evaluation and sees the scores', async ({ page }) => {
  await signUp(page);
  const workflowId = await createEvaluationWorkflow(page);

  await page.goto(`/workflow/${workflowId}/evaluations`);
  await expect(page.getByRole('heading', { name: 'Evaluations' })).toBeVisible();
  // the trigger and the metrics node are there, the outputs and the first run are not
  const guide = page.getByRole('region', { name: 'Set up evaluations' });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole('listitem').first()).toHaveAttribute('data-done', 'true');

  await page.getByRole('button', { name: 'Run test' }).click();
  const table = page.getByRole('table', { name: 'Test runs' });
  await expect(table.getByText('Completed')).toBeVisible({ timeout: 60_000 });
  await expect(table.getByRole('columnheader', { name: 'score' })).toBeVisible();
  await expect(table.getByText('3 of 3')).toBeVisible();

  // the mean of three scores of 2
  const row = table.getByRole('row').nth(1);
  await expect(row.getByRole('cell', { name: '2', exact: true })).toBeVisible();
  const chart = page.getByRole('img', { name: /Line chart of 1 metric over 1 run/ });
  await expect(chart).toBeVisible();
  expect(await chart.locator('path').count()).toBe(1);

  // the run page: one case for each row, each with the metric and a link to its execution
  await row.getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/workflow/${workflowId}/evaluations/[^/]+$`));
  const cases = page.getByRole('table', { name: 'Test cases' });
  await expect(cases.getByRole('row')).toHaveCount(4);
  await expect(cases.getByRole('link', { name: /Open the execution of row/ })).toHaveCount(3);
  await expect(cases.getByText('Succeeded')).toHaveCount(3);
});
