/**
 * Smoke test against a live server: sign up, build Manual Trigger -> Edit Fields, execute and
 * check the output. Run with `pnpm --filter @workflow/editor e2e` (E2E_BASE_URL overrides the URL).
 */
import { expect, test } from '@playwright/test';

test('sign up, build a two-step workflow, run it and read the output', async ({ page }) => {
  const id = Date.now().toString(36);

  // 1. create a workspace
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Smoke Tester');
  await page.getByLabel('Work email').fill(`smoke-${id}@example.com`);
  await page.getByLabel('Password').fill(`smoke-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Smoke ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);

  // 2. new workflow with a manual trigger
  await page.getByRole('button', { name: 'Create workflow' }).first().click();
  await expect(page).toHaveURL(/\/workflow\/new$/);
  await page.getByRole('button', { name: 'Add the first step' }).click();
  const creator = page.getByRole('complementary', { name: 'Node creator' });
  await creator.getByRole('textbox', { name: 'Search nodes' }).fill('manual');
  await creator.getByTestId('creator-item-core.manualTrigger').click();
  await expect(page.getByRole('dialog', { name: /details$/ })).toBeVisible();
  await page
    .getByRole('dialog', { name: /details$/ })
    .getByRole('button', { name: 'Close' })
    .click();

  // 3. Edit Fields after the (still selected) trigger
  await page.getByRole('button', { name: 'Add node' }).click();
  await creator.getByRole('textbox', { name: 'Search nodes' }).fill('edit fields');
  await creator.getByTestId('creator-item-core.set').click();
  const ndv = page.getByRole('dialog', { name: /details$/ });
  await expect(ndv).toBeVisible();
  await ndv.getByRole('button', { name: 'Add field' }).click();
  await ndv.getByRole('textbox', { name: 'Field 1 name' }).fill('greeting');
  await ndv.getByRole('textbox', { name: 'Field 1 value' }).fill('hello from the smoke test');
  await ndv.getByRole('button', { name: 'Close' }).click();

  // 4. run (saves the new workflow first) and wait for the result
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page).toHaveURL(/\/workflow\/[0-9a-f-]{8,}/);
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('edge-count').first()).toHaveText('1 item');

  // 5. the Edit Fields output shows the new field
  await page.locator('.react-flow__node', { hasText: 'Edit Fields' }).dblclick();
  const output = page.getByRole('dialog', { name: /details$/ }).getByRole('region', { name: 'Output' });
  await expect(output.getByText('hello from the smoke test')).toBeVisible();
});
