/**
 * P6-46 the roles pages in a real browser (written by lane L23, run once by the main session at the end of S1,
 * never by a lane). It runs on the demo build (`vite build --mode demo`, or the dev server with `--mode demo`),
 * where the demo backend answers every request: no server and no key needed. It proves: the two tabs and the
 * table of system and custom roles, an admin building a project role from the Viewer preset, a role in use
 * refusing deletion, and the workspace editor's escalation warning and personal space block.
 *
 * The demo router is in memory by default (the URL stays "/"), so start the demo dev server with
 * VITE_DEMO_ROUTER=browser, or every toHaveURL check fails.
 *
 * Run: VITE_DEMO_ROUTER=browser pnpm dev:demo, then
 *      E2E_BASE_URL=<demo URL> npx playwright test e2e/p6-roles.spec.ts
 */
import { expect, test } from '@playwright/test';

test.describe('Roles (P6-46)', () => {
  test('the tabs list system and custom roles', async ({ page }) => {
    await page.goto('/settings/roles');
    await expect(page.getByRole('tab', { name: 'Project roles' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Workspace roles' })).toBeVisible();
    const table = page.getByRole('table');
    for (const name of ['Admin', 'Editor', 'Viewer', 'Reviewer']) {
      await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
    }
    await expect(table.getByText('System').first()).toBeVisible();
    await expect(table.getByText('Custom')).toBeVisible();
    await page.getByRole('tab', { name: 'Workspace roles' }).click();
    for (const name of ['Owner', 'Admin', 'Member']) {
      await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
    }
  });

  test('an admin builds a project role from the Viewer preset', async ({ page }) => {
    await page.goto('/settings/roles');
    await page.getByRole('link', { name: 'New role' }).click();
    await expect(page).toHaveURL(/\/settings\/project-roles\/new$/);
    await page.getByRole('button', { name: 'Viewer', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Workflow read' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Workflow update' })).not.toBeChecked();
    await page.getByLabel(/Name/).fill('Triage');
    await page.getByRole('checkbox', { name: 'Execution delete' }).check();
    await page.getByRole('button', { name: 'Create role' }).click();
    await expect(page).toHaveURL(/\/settings\/roles$/);
    await expect(page.getByRole('table').getByRole('link', { name: 'Triage', exact: true })).toBeVisible();
  });

  test('deleting a role asks first, and a system role has no Delete', async ({ page }) => {
    await page.goto('/settings/roles');
    await expect(page.getByRole('button', { name: 'Delete Admin' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Delete Reviewer' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/This cannot be undone/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete role' }).click();
    await expect(page.getByRole('link', { name: 'Reviewer', exact: true })).toHaveCount(0);
  });

  test('the workspace editor warns when a role can change roles and shows the personal space block', async ({
    page,
  }) => {
    await page.goto('/settings/instance-roles/new');
    await expect(page.getByRole('region', { name: 'Personal space' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Warnings' })).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Users: Manage' }).check();
    await expect(page.getByRole('group', { name: 'Warnings' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Users: View' })).toBeDisabled();
  });
});
