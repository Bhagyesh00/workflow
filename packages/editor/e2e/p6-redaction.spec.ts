/**
 * P6-53 execution data redaction on the real server (written by lane L8, run once by the main session at the
 * end of S3, never by a lane). Mode: live (`make start`, the server serves the editor on port 8080); the demo
 * router is not used. The spec makes ONE sign-up (the owner, in beforeAll; the server allows 20 per hour per
 * IP).
 *
 * Flow: the owner sets the redaction floor to All runs in Settings > Security (after the confirm); a Manual
 * Trigger workflow made after that is seeded from the floor; it runs in the editor, and the output pane of its
 * Set node shows the redacted state; the execution page shows it too and Reveal (after "This action will be
 * logged") shows the items.
 *
 * Run: E2E_BASE_URL=<server URL> npx playwright test e2e/p6-redaction.spec.ts
 */
import { expect, type Page, test } from '@playwright/test';

// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin;
test.use({ extraHTTPHeaders: { origin } });
test.describe.configure({ mode: 'serial' });

const id = Date.now().toString(36);
const VALUE = `canary-e2e-${id}`;
let page: Page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { origin } });
  page = await context.newPage();
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Redaction Owner');
  await page.getByLabel('Work email').fill(`redaction-owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`redaction-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Redaction ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);
});

test.afterAll(async () => {
  await page.context().close();
});

test('the owner raises the floor, a run shows the redacted state, and Reveal shows the items', async () => {
  // 1. the floor
  await page.goto('/settings/security');
  await page.getByLabel('Redaction floor').selectOption('all');
  const confirm = page.getByRole('dialog', { name: 'Raise the redaction floor?' });
  await confirm.getByRole('button', { name: 'Save floor' }).click();
  await expect(page.getByText('Data redaction floor saved')).toBeVisible();
  await expect(page.getByLabel('Redaction floor')).toHaveValue('all');

  // 2. a workflow made now takes its policy from the floor
  const created = await page.request.post('/rest/workflows', {
    data: {
      name: `Redacted ${id}`,
      nodes: [
        {
          id: 'n1',
          name: 'Start',
          type: 'core.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'n2',
          name: 'Fields',
          type: 'core.set',
          typeVersion: 1,
          position: [220, 0],
          parameters: {
            mode: 'raw',
            jsonOutput: JSON.stringify({ secret: VALUE }),
            includeOtherFields: false,
          },
        },
      ],
      connections: { Start: { main: [[{ node: 'Fields', type: 'main', index: 0 }]] } },
      settings: {},
    },
  });
  expect(created.ok()).toBe(true);
  const workflowId = ((await created.json()) as { data: { id: string } }).data.id;
  const detail = await page.request.get(`/rest/workflows/${workflowId}`);
  expect(
    ((await detail.json()) as { data: { settings: { redactionPolicy?: string } } }).data.settings
      .redactionPolicy,
  ).toBe('all');

  // 3. run it in the editor: the output pane shows the redacted state
  await page.goto(`/workflow/${workflowId}`);
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('.react-flow__node', { hasText: 'Fields' }).dblclick();
  const output = page.getByRole('dialog', { name: /details$/ }).getByRole('region', { name: 'Output' });
  await expect(output.getByText('The data of this execution is redacted')).toBeVisible();
  await expect(output.getByText(VALUE)).toHaveCount(0);
  await page.keyboard.press('Escape');

  // 4. the execution page shows it too; Reveal asks first, then shows the items
  const list = await page.request.get(`/rest/executions?workflowId=${workflowId}`);
  const executionId = ((await list.json()) as { data: Array<{ id: string }> }).data[0].id;
  await page.goto(`/executions/${executionId}`);
  await expect(page.getByText('The data of this execution is redacted')).toBeVisible();
  await page.getByRole('button', { name: 'Reveal data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reveal execution data' });
  await expect(dialog.getByText(/This action will be logged/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Reveal data' }).click();
  await expect(page.getByText('The data of this execution is redacted')).toHaveCount(0);
  await page.locator('.react-flow__node', { hasText: 'Fields' }).dblclick();
  await expect(page.getByText(VALUE).first()).toBeVisible();
});
