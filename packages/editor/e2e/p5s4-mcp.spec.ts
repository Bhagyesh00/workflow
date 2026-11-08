/**
 * P5-15 in a real browser against a live server (written by the lane, run once by the main session at the
 * end of S4): an admin turns MCP on in Settings > MCP, opens Connect, reads the OAuth URL and the key, and
 * the key opens the workspace MCP endpoint; a workflow is made available from the table; the consent page
 * sends a signed-out visitor to sign-in and says it cannot load a forged request. Run with
 * `pnpm --filter @workflow/editor e2e` (E2E_BASE_URL overrides the URL).
 */
import { expect, type Page, test } from '@playwright/test';

async function signUp(page: Page) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Mcp Tester');
  await page.getByLabel('Work email').fill(`mcp-${id}@example.com`);
  await page.getByLabel('Password').fill(`mcp-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Mcp ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);
}

async function createWorkflow(page: Page, name: string) {
  const status = await page.evaluate(async (workflowName) => {
    const response = await fetch('/rest/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: workflowName, nodes: [], connections: {}, settings: {} }),
    });
    return response.status;
  }, name);
  expect(status).toBeLessThan(300);
}

test('an admin turns MCP on, connects with the key and shares a workflow', async ({ page }) => {
  await signUp(page);
  await createWorkflow(page, 'Shared with MCP');
  await page.goto('/settings/mcp');

  const access = page.getByRole('switch', { name: 'MCP access' });
  await expect(access).toHaveAttribute('aria-checked', 'false');
  await access.click();
  await expect(access).toHaveAttribute('aria-checked', 'true');

  const row = page.getByRole('switch', { name: 'Available in MCP: Shared with MCP' });
  await expect(row).toHaveAttribute('aria-checked', 'false');
  await row.click();
  await expect(row).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: /Connect/ }).click();
  const url = (await page.getByLabel('Server URL', { exact: true }).textContent()) ?? '';
  expect(url).toMatch(/\/mcp-server\/[^/]+\/http$/);

  await page.getByRole('tab', { name: 'Access token' }).click();
  const key = (await page.getByLabel('MCP key', { exact: true }).textContent()) ?? '';
  expect(key).toMatch(/^wfk_/);

  const unauthorized = await page.request.post(url, {
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(unauthorized.status()).toBe(401);
  const authorized = await page.request.post(url, {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(authorized.status()).toBeLessThan(300);
});

test('the consent page sends a signed-out visitor to sign-in', async ({ page }) => {
  await page.goto('/oauth/consent?flow=some-flow');
  await expect(page).toHaveURL(/\/signin\?redirect=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get('redirect') ?? '')).toBe(
    '/oauth/consent?flow=some-flow',
  );
});

test('the consent page says it cannot load a forged request', async ({ page }) => {
  await signUp(page);
  await page.goto('/oauth/consent?flow=forged-flow-token');
  await expect(page.getByText("Couldn't load this request")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});
