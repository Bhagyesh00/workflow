/**
 * P6-64 Settings > Log streaming on the real server (written by lane L8, run once by the main session at the end
 * of S5, never by a lane). Mode: LIVE (`make start`, the server serves the editor on port 8080); the demo router
 * is not used. The server must be started with SSRF_ALLOW=127.0.0.1, because the receiver this spec starts
 * (e2e/helpers/http-receiver.ts: `node:http` on 127.0.0.1, port 0) sits on a loopback address.
 * The spec makes ONE sign-up (the owner, in beforeAll; the server allows 20 per start, routes/auth.ts:57).
 *
 * Flow: an admin adds a webhook destination from the page that points at the receiver, saves it, sends a test
 * event and the receiver gets it, then turns the destination on from its card and deletes it after the confirm.
 *
 * Run: SSRF_ALLOW=127.0.0.1 make start, then
 *      E2E_BASE_URL=<server URL> npx playwright test e2e/p6-log-streaming.spec.ts
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { type HttpReceiver, startHttpReceiver } from './helpers/http-receiver';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(baseURL).origin;

test.describe.configure({ mode: 'serial' });

let receiver: HttpReceiver;
let context: BrowserContext;
let page: Page;
const id = Date.now().toString(36);
const label = `Receiver ${id}`;

test.beforeAll(async ({ browser }) => {
  receiver = await startHttpReceiver();
  context = await browser.newContext({ baseURL, extraHTTPHeaders: { origin } });
  page = await context.newPage();
  // the only sign-up of this spec
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Log Owner');
  await page.getByLabel('Work email').fill(`log-owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`log-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Logs ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);
});

test.afterAll(async () => {
  await context?.close();
  await receiver?.close();
});

test('an admin adds a webhook destination, sends a test event, switches it on and deletes it', async () => {
  // 1. add the destination
  await page.goto('/settings/log-streaming');
  await expect(page.getByRole('heading', { name: 'Log streaming' })).toBeVisible();
  await page.getByRole('button', { name: 'Add destination' }).click();
  await page.getByRole('button', { name: 'Webhook', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Label', { exact: true }).fill(label);
  await dialog.getByLabel('URL', { exact: true }).fill(receiver.url);
  await dialog.getByRole('tab', { name: 'Events' }).click();
  await dialog.getByLabel('All workflow events', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Destination saved')).toBeVisible();

  // 2. the test event reaches the receiver
  const seen = receiver.requests().length;
  await dialog.getByRole('button', { name: 'Send test event' }).click();
  await expect(dialog.getByText('Test event delivered.')).toBeVisible();
  const request = await receiver.next(seen);
  expect(request.method).toBe('POST');
  expect(request.path).toBe('/hook');
  expect(request.body).toContain('destination.test');

  // 3. the card shows the destination; the switch turns it on
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByText(label, { exact: true })).toBeVisible();
  const toggle = page.getByRole('switch', { name: `Enable ${label}` });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // 4. delete after the confirm
  await page.getByRole('button', { name: `Delete ${label}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText(label, { exact: true })).toHaveCount(0);
});
