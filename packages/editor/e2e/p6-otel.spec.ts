/**
 * P6-68 Settings > OpenTelemetry on the real server (written by lane L12, run once by the main session at the end
 * of S5, never by a lane). Mode: LIVE (`make start`, the server serves the editor on port 8080); the demo router
 * is not used. The server must be started with SSRF_ALLOW=127.0.0.1, because the receiver this spec starts
 * (e2e/helpers/otlp-receiver.ts: `node:http` on 127.0.0.1, port 0, never 4317 or 4318) sits on a loopback
 * address. The spec makes ONE sign-up (the owner, in beforeAll; the server allows 20 per start, routes/auth.ts:57).
 *
 * Flow: an admin opens the page, saves an `http://` endpoint with no header (a header over `http://` is
 * refused), sends a test trace from the page and the receiver gets one OTLP request on /v1/traces, then switches
 * tracing on and the page shows it after a reload.
 *
 * Run: SSRF_ALLOW=127.0.0.1 make start, then
 *      E2E_BASE_URL=<server URL> npx playwright test e2e/p6-otel.spec.ts
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { type OtlpReceiver, startOtlpReceiver } from './helpers/otlp-receiver';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(baseURL).origin;

test.describe.configure({ mode: 'serial' });

let receiver: OtlpReceiver;
let context: BrowserContext;
let page: Page;
const id = Date.now().toString(36);

test.beforeAll(async ({ browser }) => {
  receiver = await startOtlpReceiver();
  context = await browser.newContext({ baseURL, extraHTTPHeaders: { origin } });
  page = await context.newPage();
  // the only sign-up of this spec
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Otel Owner');
  await page.getByLabel('Work email').fill(`otel-owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`otel-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Otel ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);
});

test.afterAll(async () => {
  await context?.close();
  await receiver?.close();
});

test('an admin saves an http:// endpoint, sends a test trace and switches tracing on', async () => {
  // 1. the page starts switched off, with the defaults
  await page.goto('/settings/opentelemetry');
  await expect(page.getByRole('heading', { name: 'OpenTelemetry', exact: true })).toBeVisible();
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible();

  // 2. save an endpoint on the local receiver (no header: headers over http:// are refused)
  await page.getByLabel('Endpoint', { exact: true }).fill(receiver.url);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('OpenTelemetry settings saved')).toBeVisible();

  // 3. the test trace reaches the receiver
  const seen = receiver.requests().length;
  await page.getByRole('button', { name: 'Send test trace' }).click();
  await expect(page.getByText('Test trace delivered.')).toBeVisible();
  const request = await receiver.next(seen);
  expect(request.method).toBe('POST');
  expect(request.path).toBe('/v1/traces');
  expect(request.contentType).toContain('application/x-protobuf');
  expect(request.body.length).toBeGreaterThan(0);
  // the span is named test_trace
  expect(request.body.includes(Buffer.from('test_trace'))).toBe(true);

  // 4. switch tracing on, save, and the state survives a reload
  await page.getByRole('switch', { name: 'Enable OpenTelemetry' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('OpenTelemetry settings saved').first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Endpoint', { exact: true })).toHaveValue(receiver.url);
});
