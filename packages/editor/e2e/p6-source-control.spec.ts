/**
 * P6-76 Settings > Environments and the sidebar's Git block on the real server (written by lane L6, run once by
 * the main session at the end of S4, never by a lane). Mode: LIVE (`make start`, the server serves the editor on
 * port 8080); the demo router is not used. The server must be started with SSRF_ALLOW=127.0.0.1, because the bare
 * repository this spec starts (e2e/helpers/git-http.ts: `git http-backend` behind node:http) sits on 127.0.0.1.
 * The spec makes ONE sign-up (the owner, in beforeAll; the server allows 20 per start, routes/auth.ts:57).
 *
 * Flow: an admin connects over a plain http:// remote (a token is never sent over plain http, so none is typed),
 * the sidebar shows the branch with Pull and Push, a workflow is pushed from the Push dialog with a commit
 * message and lands in the bare repository, the protected switch turns the sidebar's Push off, and Disconnect
 * (after its confirm) brings the form back.
 *
 * Run: SSRF_ALLOW=127.0.0.1 make start, then
 *      E2E_BASE_URL=<server URL> npx playwright test e2e/p6-source-control.spec.ts
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { type GitHttpRemote, startGitHttpRemote } from './helpers/git-http';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(baseURL).origin;

test.describe.configure({ mode: 'serial' });

let remote: GitHttpRemote;
let context: BrowserContext;
let page: Page;
const id = Date.now().toString(36);
const workflowName = `Git flow ${id}`;
const commitMessage = `Push ${id} from the page`;

test.beforeAll(async ({ browser }) => {
  remote = await startGitHttpRemote();
  context = await browser.newContext({ baseURL, extraHTTPHeaders: { origin } });
  page = await context.newPage();
  // the only sign-up of this spec
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Git Owner');
  await page.getByLabel('Work email').fill(`git-owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`git-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Git ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);
  const created = await context.request.post('/rest/workflows', {
    data: { name: workflowName, nodes: [], connections: {} },
  });
  expect(created.ok()).toBeTruthy();
});

test.afterAll(async () => {
  await context?.close();
  await remote?.close();
});

test('an admin connects, pushes a workflow from the page, protects the workspace and disconnects', async () => {
  // 1. connect over plain http (no token is sent there)
  await page.goto('/settings/environments');
  await expect(page.getByRole('heading', { name: 'Environments (Classic)' })).toBeVisible();
  await page.getByLabel('Connection type').selectOption('https');
  await page.getByLabel('Repository URL').fill(remote.url);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByLabel('Branch', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Branch', { exact: true }).locator('option', { hasText: 'main' })).toHaveCount(
    1,
  );

  // 2. the sidebar shows the branch with Pull and Push
  const git = page.getByRole('group', { name: 'Git' });
  await expect(git.getByText('main', { exact: true })).toBeVisible();
  await expect(git.getByRole('button', { name: 'Pull' })).toBeEnabled();
  await expect(git.getByRole('button', { name: 'Push' })).toBeEnabled();

  // 3. push the workflow: pick it, write the message, Push
  await git.getByRole('button', { name: 'Push' }).click();
  const dialog = page.getByRole('dialog', { name: 'Push to Git' });
  const push = dialog.getByRole('button', { name: 'Push', exact: true });
  await expect(push).toBeDisabled();
  await dialog.getByRole('checkbox', { name: new RegExp(workflowName) }).check();
  await dialog.getByLabel('Commit message').fill(commitMessage);
  await push.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Pushed 1 file to main/)).toBeVisible();

  // 4. the commit is in the bare repository: the message and one workflow file
  await expect.poll(async () => remote.message()).toBe(commitMessage);
  const files = [...(await remote.files()).keys()];
  expect(files.filter((name) => /^workflows\/[0-9a-f-]{36}\.json$/.test(name))).toHaveLength(1);

  // 5. the protected switch turns Push off, Pull stays on
  await page.getByRole('switch', { name: 'Protected workspace' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Environment settings saved')).toBeVisible();
  await expect(git.getByRole('button', { name: 'Push' })).toBeDisabled();
  await expect(git.getByRole('button', { name: 'Pull' })).toBeEnabled();

  // 6. Disconnect asks first; then the form is back
  await page.getByRole('button', { name: 'Disconnect' }).click();
  const confirm = page.getByRole('dialog', { name: /Disconnect/ });
  await confirm.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();
  await expect(git).toBeHidden();
});
