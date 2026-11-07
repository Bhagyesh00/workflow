/**
 * P5-75 in a real browser against a live server (written by the lane, run once by the main session at
 * the end of S1): an app node used as an agent tool gets "Let the model define this parameter", the
 * panel "Defined by agent" and its value survive a save and a reload, and the main node list hides
 * tool variants (the tool slot list is not opened here). Run with `pnpm --filter @workflow/editor e2e` (E2E_BASE_URL
 * overrides the URL).
 */
import { expect, type Page, test } from '@playwright/test';

async function signUp(page: Page) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Tool Tester');
  await page.getByLabel('Work email').fill(`tools-${id}@example.com`);
  await page.getByLabel('Password').fill(`tools-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Tools ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);
}

/** a workflow with an HTTP Request Tool wired into an Agent's tool slot */
async function createToolWorkflow(page: Page): Promise<string> {
  const created = await page.evaluate(async () => {
    const response = await fetch('/rest/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Tools ${Date.now()}`,
        nodes: [
          {
            id: crypto.randomUUID(),
            name: 'Agent',
            type: 'ai.agent',
            typeVersion: 1,
            position: [300, 0],
            parameters: {},
          },
          {
            id: crypto.randomUUID(),
            name: 'HTTP Request Tool',
            type: 'core.httpRequestTool',
            typeVersion: 1,
            position: [300, 200],
            parameters: { url: 'https://example.com' },
          },
        ],
        connections: { 'HTTP Request Tool': { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] } },
        settings: {},
      }),
    });
    return (await response.json()) as { data: { id: string } };
  });
  return created.data.id;
}

test('a person lets the model define a tool parameter and it survives a reload', async ({ page }) => {
  await signUp(page);
  const id = await createToolWorkflow(page);
  await page.goto(`/workflow/${id}`);

  await page.locator('.react-flow__node', { hasText: 'HTTP Request Tool' }).dblclick();
  const ndv = page.getByRole('dialog', { name: /details$/ });
  await expect(ndv).toBeVisible();

  const url = ndv.locator('[data-parameter="url"]');
  await url.getByRole('button', { name: 'Let the model define this parameter' }).click();
  const panel = url.getByRole('region', { name: 'Defined by agent' });
  await expect(panel).toBeVisible();
  await panel.getByRole('textbox', { name: 'Description' }).fill('The page to fetch');

  // the tool description and the method are never defined by the model
  await expect(
    ndv.locator('[data-parameter="toolDescription"]').getByRole('button', {
      name: 'Let the model define this parameter',
    }),
  ).toHaveCount(0);
  await expect(
    ndv.locator('[data-parameter="method"]').getByRole('button', {
      name: 'Let the model define this parameter',
    }),
  ).toHaveCount(0);

  await ndv.getByRole('button', { name: 'Close' }).click();
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved').first()).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await page.locator('.react-flow__node', { hasText: 'HTTP Request Tool' }).dblclick();
  const again = page.getByRole('dialog', { name: /details$/ }).locator('[data-parameter="url"]');
  const reloaded = again.getByRole('region', { name: 'Defined by agent' });
  await expect(reloaded).toBeVisible();
  await expect(reloaded.getByRole('textbox', { name: 'Description' })).toHaveValue('The page to fetch');

  // Edit value gives the plain input back
  await reloaded.getByRole('button', { name: 'Edit value' }).click();
  await expect(again.getByRole('region', { name: 'Defined by agent' })).toHaveCount(0);
  await expect(again.getByRole('button', { name: 'Let the model define this parameter' })).toBeVisible();
});

test('the main node list hides tool variants', async ({ page }) => {
  await signUp(page);
  const id = await createToolWorkflow(page);
  await page.goto(`/workflow/${id}`);

  // the main list shows the HTTP Request node and not its tool copy
  await page.getByRole('button', { name: 'Add node' }).click();
  const creator = page.getByRole('complementary', { name: 'Node creator' });
  await creator.getByRole('textbox', { name: 'Search nodes' }).fill('http request');
  await expect(creator.getByTestId('creator-item-core.httpRequest')).toBeVisible();
  await expect(creator.getByTestId('creator-item-core.httpRequestTool')).toHaveCount(0);
});
