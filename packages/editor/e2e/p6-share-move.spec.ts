/**
 * P6-44 the Share and Move dialogs in a real browser, on the real server (written by lane L21, moved off the
 * demo backend in the S1 fix round, run once by the main session, never by a lane). The demo backend keeps its
 * data in memory, so a reload loses it; the point here is that a reload proves the share and the move were
 * saved. Each test signs up its own workspace, adds a second project (Add project), makes a workflow with the
 * header Create menu, names and saves it, then:
 *  - Share: the workflow is shared with the second project; after a reload its badge shows the share.
 *  - Move: the workflow is moved to the second project; after a reload it is listed in that project.
 * The spec writes only through the page (the browser sends the Origin header itself); a `page.request` write
 * would need `headers: { origin }` for the server's CSRF check.
 *
 * Run: make start (the real server), then
 *      E2E_BASE_URL=<server URL> npx playwright test e2e/p6-share-move.spec.ts
 */
import { expect, type Page, test } from '@playwright/test';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** a new workspace: the owner lands on Overview */
async function signUp(page: Page, tag: string) {
  const id = `${tag}-${Date.now().toString(36)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Share Tester');
  await page.getByLabel('Work email').fill(`share-${id}@example.com`);
  await page.getByLabel('Password').fill(`share-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Share ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);
  return id;
}

/** a second team project, so there is something to share with and move to */
async function addProject(page: Page): Promise<string> {
  await sidebar(page).getByRole('button', { name: 'Add project' }).click();
  await expect(page).toHaveURL(/\/projects\/([^/]+)\/settings$/);
  return /\/projects\/([^/]+)\//.exec(page.url())?.[1] ?? '';
}

/** header Create > Workflow on Overview (the personal project), then name it and save it */
async function createWorkflow(page: Page, name: string) {
  await page.goto('/home/workflows');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Workflow' }).click();
  await expect(page).toHaveURL(/\/workflow\/[^/]+$/);
  await page.getByLabel('Workflow name').fill(name);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.goto('/home/workflows');
  await expect(page.getByText(name)).toBeVisible();
}

async function openRowMenu(page: Page, name: string, item: string) {
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test.describe('Share and move (P6-44)', () => {
  test('a workflow is shared with another project from the Share dialog', async ({ page }) => {
    const id = await signUp(page, 'share');
    await addProject(page);
    const name = `Shared flow ${id}`;
    await createWorkflow(page, name);
    await openRowMenu(page, name, 'Share');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Moving will remove any existing sharing')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await dialog.getByRole('group', { name: 'Projects' }).getByLabel('My project').check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await expect(page.getByText(name)).toBeVisible();
    await expect(page.getByRole('img', { name: 'Shared with 1 project' }).first()).toBeVisible();
  });

  test('a workflow is moved to another project from the Move dialog', async ({ page }) => {
    const id = await signUp(page, 'move');
    const projectId = await addProject(page);
    const name = `Moving flow ${id}`;
    await createWorkflow(page, name);
    await openRowMenu(page, name, 'Move to project');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Moving will remove any existing sharing')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Move' })).toBeDisabled();
    await dialog.getByLabel('Destination project').selectOption({ label: 'My project' });
    await expect(dialog.getByRole('button', { name: 'Move' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Move' }).click();
    await expect(dialog).toBeHidden();

    await page.goto(`/projects/${projectId}/workflows`);
    await page.reload();
    await expect(page.getByText(name)).toBeVisible();
  });
});
