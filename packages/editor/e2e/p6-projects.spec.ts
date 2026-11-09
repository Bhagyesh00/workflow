/**
 * P6-41 the project sidebar, pages and tabs in a real browser (written by lane L18, run once by the main
 * session at the end of S1, never by a lane). It runs on the demo build (`vite build --mode demo`, or the dev
 * server with `--mode demo`), where the demo backend answers every request: no server and no key needed. It
 * proves: the sidebar block (Overview, Shared with you, Personal, Projects with Add project), the old list
 * entries living as tabs, the old paths redirecting to `/home/*`, Add project opening the new project, the
 * tabs moving between a project's lists, and the Create button making a workflow in the project.
 *
 * The demo router is in memory by default (the URL stays "/"), so start the demo dev server with
 * VITE_DEMO_ROUTER=browser, or every toHaveURL check fails.
 *
 * Run: VITE_DEMO_ROUTER=browser pnpm dev:demo, then
 *      E2E_BASE_URL=<demo URL> npx playwright test e2e/p6-projects.spec.ts
 */
import { expect, type Page, test } from '@playwright/test';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });

test.describe('Projects (P6-41)', () => {
  test('the sidebar holds the project block and the list entries are tabs', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/home\/workflows$/);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    for (const name of ['Overview', 'Shared with you', 'Personal']) {
      await expect(sidebar(page).getByRole('link', { name })).toBeVisible();
    }
    await expect(sidebar(page).getByRole('button', { name: 'Add project' })).toBeVisible();
    for (const name of ['Workflows', 'Executions', 'Credentials', 'Data tables']) {
      await expect(sidebar(page).getByRole('link', { name })).toHaveCount(0);
      await expect(tabs(page).getByRole('link', { name })).toBeVisible();
    }
  });

  test('an old list path redirects to /home and keeps its query', async ({ page }) => {
    await page.goto('/credentials');
    await expect(page).toHaveURL(/\/home\/credentials$/);
    await page.goto('/workflows?search=abc');
    await expect(page).toHaveURL(/\/home\/workflows\?search=abc$/);
  });

  test('Add project opens the new project, and its tabs switch lists', async ({ page }) => {
    await page.goto('/home/workflows');
    await sidebar(page).getByRole('button', { name: 'Add project' }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/settings$/);
    await expect(sidebar(page).getByRole('link', { name: 'My project' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My project' })).toBeVisible();

    await tabs(page).getByRole('link', { name: 'Credentials' }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/credentials$/);
    await tabs(page).getByRole('link', { name: 'Data tables' }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/data-tables$/);
    await expect(tabs(page).getByRole('link', { name: 'Variables' })).toBeVisible();
    await expect(tabs(page).getByRole('link', { name: 'Settings' })).toBeVisible();
  });

  test('Shared with you has two tabs and no Create button', async ({ page }) => {
    await page.goto('/');
    await sidebar(page).getByRole('link', { name: 'Shared with you' }).click();
    await expect(page).toHaveURL(/\/shared\/workflows$/);
    await expect(page.getByRole('heading', { name: 'Shared with you' })).toBeVisible();
    await expect(tabs(page).getByRole('link')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
  });

  test('Create makes a workflow in the personal project from Overview', async ({ page }) => {
    await page.goto('/home/workflows');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('menuitem')).toHaveText([
      'Workflow',
      'Credential',
      'Folder',
      'Data table',
      'Variable',
    ]);
    await page.getByRole('menuitem', { name: 'Workflow' }).click();
    await expect(page).toHaveURL(/\/workflow\/[^/]+$/);
  });
});
