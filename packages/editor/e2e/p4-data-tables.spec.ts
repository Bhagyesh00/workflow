/**
 * P4-05 on the real server (not run by the lane builders): a table made in the editor shows the rows a
 * workflow wrote. The demo backend proves the page in test/data-tables.test.tsx; only this proves that
 * the page, the REST routes and the Data Table node agree.
 */
import { expect, type Page, test } from '@playwright/test';

async function signUp(page: Page) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Owner Olive');
  await page.getByLabel('Work email').fill(`owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`table-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Tables ${id}`);
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
      return (await response.json()) as { data: never };
    },
    { method, path, body },
  );
}

test('a table made in the editor shows the rows a workflow wrote', async ({ page }) => {
  await signUp(page);

  await page.goto('/data-tables');
  await page.getByRole('button', { name: 'New data table' }).click();
  const create = page.getByRole('dialog', { name: 'New data table' });
  await create.getByLabel('Name').fill('Leads');
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/data-tables\/[^/]+$/);
  const tableId = new URL(page.url()).pathname.split('/').pop() as string;

  await page.getByRole('button', { name: 'Add first column' }).click();
  const add = page.getByRole('dialog', { name: 'Add column' });
  await add.getByLabel('Column name').fill('email');
  await add.getByRole('button', { name: 'Add column' }).click();
  await expect(page.getByRole('columnheader', { name: /email/ })).toBeVisible();

  const created = await api(page, 'POST', '/workflows', {
    name: `Writer ${Date.now()}`,
    nodes: [
      {
        id: crypto.randomUUID(),
        name: 'Start',
        type: 'core.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: crypto.randomUUID(),
        name: 'Table',
        type: 'core.dataTable',
        typeVersion: 1,
        position: [300, 0],
        parameters: {
          resource: 'row',
          operation: 'insert',
          dataTableId: { __rl: true, mode: 'id', value: tableId },
          dataMode: 'defineBelow',
          fieldsUi: { fieldValues: [{ columnName: 'email', value: 'ann@example.com' }] },
        },
      },
    ],
    connections: { Start: { main: [[{ node: 'Table', type: 'main', index: 0 }]] } },
    settings: {},
  });
  const { id } = created.data as { id: string };
  await api(page, 'POST', `/workflows/${id}/run`, {});

  await expect
    .poll(
      async () => {
        const rows = await api(page, 'GET', `/data-tables/${tableId}/rows`);
        return (rows.data as { count: number }).count;
      },
      { timeout: 30_000 },
    )
    .toBe(1);

  await page.reload();
  await expect(page.getByRole('gridcell', { name: 'ann@example.com' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Used by 1 workflow' })).toBeVisible();
});
