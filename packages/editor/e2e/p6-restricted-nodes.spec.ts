/**
 * P6-50 restricted nodes on the real server (written by lane L5, run once by the main session at the end of S3,
 * never by a lane). Mode: live (`make start`, the server serves the editor on port 8080); the demo router is not
 * used. The spec makes ONE sign-up (the owner, in beforeAll; the server allows 20 per start).
 *
 * There is no policy page in the editor (the documents are written through the public API), so the owner makes
 * an API key with `nodeTypePolicy:manage` through POST /rest/api-keys, saves a workflow that holds a node type,
 * and then denies that type through the public /api/v1/node-type-policies rows (`x-api-key`). After that the
 * node creator lists the type greyed and last in its section, picking it adds nothing and shows the toast, the
 * canvas shows the lock badge, and the workflows page filter "Blocked by a policy" finds the saved workflow and
 * leaves the clean one out.
 *
 * Run: E2E_BASE_URL=<server URL> npx playwright test e2e/p6-restricted-nodes.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin;
test.use({ extraHTTPHeaders: { origin } });
test.describe.configure({ mode: 'serial' });

const id = Date.now().toString(36);
const BLOCKED = 'core.noOp';
let page: Page;
let blockedWorkflowId = '';

const node = (nodeId: string, name: string, type: string, x: number) => ({
  id: nodeId,
  name,
  type,
  typeVersion: 1,
  position: [x, 120],
  parameters: {},
});

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { origin } });
  page = await context.newPage();
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Policy Owner');
  await page.getByLabel('Work email').fill(`policy-owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`policy-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Policy ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);
});

test.afterAll(async () => {
  await page.context().close();
});

test('the owner saves a workflow, then denies its node type through the public API', async () => {
  const clean = await page.request.post('/rest/workflows', {
    data: {
      name: `Clean flow ${id}`,
      nodes: [node('a1', 'Start', 'core.manualTrigger', 0)],
      connections: {},
    },
  });
  expect(clean.ok()).toBe(true);
  const saved = await page.request.post('/rest/workflows', {
    data: {
      name: `Blocked flow ${id}`,
      nodes: [node('b1', 'Start', 'core.manualTrigger', 0), node('b2', 'Nothing', BLOCKED, 300)],
      connections: { Start: { main: [[{ node: 'Nothing', type: 'main', index: 0 }]] } },
    },
  });
  expect(saved.ok()).toBe(true);
  blockedWorkflowId = ((await saved.json()).data as { id: string }).id;

  // a key that may manage node type policies (labels are unique per user)
  const made = await page.request.post('/rest/api-keys', {
    data: { name: `policy-key-${id}`, scopes: ['nodeTypePolicy:manage'] },
  });
  expect(made.ok()).toBe(true);
  const key = ((await made.json()).data as { key: string }).key;
  const headers = { 'x-api-key': key };

  const doc = await page.request.post('/api/v1/node-type-policies/policies', {
    headers,
    data: {
      name: `Deny ${BLOCKED} ${id}`,
      rules: [{ id: randomUUID(), action: 'deny', selector: { name: BLOCKED } }],
    },
  });
  expect(doc.ok()).toBe(true);
  const policyId = ((await doc.json()).data as { id: string }).id;

  const scope = await page.request.get('/api/v1/node-type-policies/instance', { headers });
  expect(scope.ok()).toBe(true);
  const version = ((await scope.json()).data as { version: number }).version;
  const attached = await page.request.put('/api/v1/node-type-policies/instance', {
    headers,
    data: { defaultAction: 'allow', attachments: [{ policyId, priority: 0, isFloor: false }], expectedVersion: version },
  });
  expect(attached.ok()).toBe(true);
});

test('the node creator lists the type greyed and last, and adding it adds nothing', async () => {
  await page.goto(`/workflow/${blockedWorkflowId}`);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.getByTestId('canvas-lock-badge')).toHaveCount(1);

  await page
    .getByRole('button', { name: /^Add a node after/ })
    .first()
    .click();
  const creator = page.getByRole('complementary', { name: 'Node creator' });
  const row = creator.getByTestId(`creator-item-${BLOCKED}`);
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  // last in its section
  const lastInSection = await row.evaluate((el) => {
    const items = el.closest('section')?.querySelectorAll('[data-testid^="creator-item-"]');
    return items?.[items.length - 1] === el;
  });
  expect(lastInSection).toBe(true);

  // force: Playwright will not click an aria-disabled button; the row still answers a click with the toast
  await row.click({ force: true });
  await expect(page.getByText('is restricted').first()).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);

  // the lock popover says why
  await creator.getByRole('button', { name: /^Why .* is restricted$/ }).click();
  await expect(page.getByText(/policy of this workspace blocks this node/)).toBeVisible();
});

test('the workflows filter finds the saved workflow and leaves the clean one out', async () => {
  await page.goto('/workflows');
  await expect(page.getByText(`Clean flow ${id}`)).toBeVisible();
  await expect(page.getByText(`Blocked flow ${id}`)).toBeVisible();
  await page.getByRole('checkbox', { name: 'Blocked by a policy' }).check();
  await expect(page.getByText(`Blocked flow ${id}`)).toBeVisible();
  await expect(page.getByText(`Clean flow ${id}`)).toHaveCount(0);
  await expect(page.getByText('Blocked by policy')).toBeVisible();
});
