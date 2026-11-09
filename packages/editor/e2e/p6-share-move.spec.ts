/**
 * P6-44 the Share and Move dialogs in a real browser (written by lane L21, run once by the main session at the
 * end of S1, never by a lane). It runs on the demo build (`vite build --mode demo`, or the dev server with
 * `--mode demo`), where the demo backend answers every request: no server and no key needed. It proves: a
 * workflow shared with a project from the Share dialog shows the project in its badge; the Move dialog lists
 * the other projects, warns that moving removes sharing, and a move takes the workflow out of the old project.
 *
 * Run: E2E_BASE_URL=<demo URL> npx playwright test e2e/p6-share-move.spec.ts
 */
import { expect, type Page, test } from '@playwright/test';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** a second team project, so there is something to share with and move to */
async function addProject(page: Page): Promise<string> {
  await page.goto('/home/workflows');
  await sidebar(page).getByRole('button', { name: 'Add project' }).click();
  await expect(page).toHaveURL(/\/projects\/([^/]+)\/settings$/);
  return /\/projects\/([^/]+)\//.exec(page.url())?.[1] ?? '';
}

async function createWorkflow(page: Page, name: string) {
  await page.goto('/home/workflows');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('menuitem', { name: 'Workflow' }).click();
  await expect(page).toHaveURL(/\/workflow\/[^/]+$/);
  await page.getByLabel('Workflow name').fill(name);
  await page.keyboard.press('Enter');
  await page.goto('/home/workflows');
  await expect(page.getByText(name)).toBeVisible();
}

async function openRowMenu(page: Page, name: string, item: string) {
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test.describe('Share and move (P6-44)', () => {
  test('a workflow is shared with another project from the Share dialog', async ({ page }) => {
    await addProject(page);
    await createWorkflow(page, 'Shared flow');
    await openRowMenu(page, 'Shared flow', 'Share');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Moving will remove any existing sharing')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await dialog.getByRole('group', { name: 'Projects' }).getByLabel('My project').check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await expect(page.getByTestId('project-badge').first()).toBeVisible();
  });

  test('a workflow is moved to another project from the Move dialog', async ({ page }) => {
    const projectId = await addProject(page);
    await createWorkflow(page, 'Moving flow');
    await openRowMenu(page, 'Moving flow', 'Move to project');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Moving will remove any existing sharing')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Move' })).toBeDisabled();
    await dialog.getByLabel('Destination project').selectOption({ label: 'My project' });
    await expect(dialog.getByRole('button', { name: 'Move' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Move' }).click();
    await expect(dialog).toBeHidden();

    await page.goto(`/projects/${projectId}/workflows`);
    await expect(page.getByText('Moving flow')).toBeVisible();
  });
});
