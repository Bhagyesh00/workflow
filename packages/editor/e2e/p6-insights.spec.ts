/**
 * P6-57 Insights page on the real server (written by lane L13, run once by the main session at the end of S3,
 * never by a lane). Mode: live (`make start`, the server serves the editor on port 8080); the demo router is not
 * used. The spec makes ONE sign-up (the owner, in beforeAll; the server allows 20 per start); the member comes
 * from an invitation accepted through the API.
 *
 * Flow: the owner publishes a Webhook workflow and calls its production URL a few times (manual runs are not
 * counted); the collector writes every 30 s, so the spec polls `GET /rest/insights/summary` until the runs show
 * up, then opens Insights and each of the five tiles equals the route's answer; the workflow is in the table
 * with a link; the Overview shows the same numbers in its 7-day strip. A member has no Insights link and the
 * page tells them they have no access.
 *
 * Run: E2E_BASE_URL=<server URL> npx playwright test e2e/p6-insights.spec.ts
 */
import { type APIResponse, type Browser, expect, type Page, test } from '@playwright/test';

// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin;
test.use({ extraHTTPHeaders: { origin } });
// the collector flushes every 30 s: wait for two flushes at most (over playwright.config.ts's 60 s)
test.setTimeout(120_000);

const CALLS = 3;
const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const workflowName = `Insights hook ${id}`;

interface Metric {
  value: number;
  unit: string;
  deviation: number | null;
}
type Summary = Record<'total' | 'failed' | 'failureRate' | 'timeSaved' | 'averageRunTime', Metric>;

const trim = (n: number, places: number) => String(Math.round(n * 10 ** places) / 10 ** places);

/** a tile's text, as the page writes it (SummaryStrip's formatMetric) */
function tileText(type: keyof Summary, { value }: Metric): string {
  if (type === 'failureRate') return `${trim(value * 100, 1)}%`;
  if (type === 'timeSaved') return value >= 60 ? `${trim(value / 60, 1)} h` : `${Math.round(value)} min`;
  if (type === 'averageRunTime') return value >= 1000 ? `${trim(value / 1000, 2)} s` : `${trim(value, 0)} ms`;
  return Math.round(value).toLocaleString('en-US');
}

const week = () => {
  const end = new Date();
  return {
    startDate: new Date(end.getTime() - 7 * 24 * 3_600_000).toISOString(),
    endDate: end.toISOString(),
  };
};

async function data<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: T }).data;
}

let owner: Page;
let workflowId = '';

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { origin } });
  owner = await context.newPage();
  // the only sign-up of this spec
  await owner.goto('/signup');
  await owner.getByLabel('Your name').fill('Insights Owner');
  await owner.getByLabel('Work email').fill(`insights-owner-${id}@example.com`);
  await owner.getByLabel('Password').fill(`insights-pass-${id}1`);
  await owner.getByLabel('Workspace name').fill(`Insights ${id}`);
  await owner.getByRole('button', { name: 'Create workspace' }).click();
  await expect(owner).toHaveURL(/\/home\/workflows$/);
});

test.afterAll(async () => {
  await owner.context().close();
});

test('the tiles, the table and the Overview strip equal the numbers of the summary route', async () => {
  // 1. a published Webhook workflow, called a few times (a manual run is not counted)
  const created = await data<{ id: string }>(
    await owner.request.post('/rest/workflows', {
      data: {
        name: workflowName,
        nodes: [
          {
            id: crypto.randomUUID(),
            name: 'Webhook',
            type: 'core.webhook',
            typeVersion: 1,
            position: [0, 0],
            webhookId: crypto.randomUUID(),
            parameters: { httpMethod: 'GET', path: `insights-${id}` },
          },
        ],
        connections: {},
        settings: {},
      },
    }),
  );
  workflowId = created.id;
  await data(await owner.request.post(`/rest/workflows/${workflowId}/activate`, { data: {} }));
  const urls = await data<Array<{ productionUrl: string }>>(
    await owner.request.get(`/rest/workflows/${workflowId}/webhook-urls`),
  );
  const path = new URL(urls[0].productionUrl).pathname;
  for (let call = 0; call < CALLS; call++) {
    const response = await owner.request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
  }

  // 2. the collector flushes every 30 s: poll the route until the runs are in
  await expect
    .poll(
      async () =>
        (await data<Summary>(await owner.request.get('/rest/insights/summary', { params: week() }))).total
          .value,
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBe(CALLS);
  const summary = await data<Summary>(await owner.request.get('/rest/insights/summary', { params: week() }));

  // 3. the page: each tile equals the route
  await owner.goto('/insights');
  await expect(owner.getByRole('heading', { name: 'Insights' })).toBeVisible();
  for (const type of ['total', 'failed', 'failureRate', 'timeSaved', 'averageRunTime'] as const) {
    await expect(owner.getByTestId(`insights-tile-${type}-value`)).toHaveText(tileText(type, summary[type]));
  }
  await expect(owner.getByText("Manual executions aren't counted.").first()).toBeVisible();

  // the workflow is in the table, with its count and a link to it
  const row = owner.getByRole('row').filter({ has: owner.getByRole('link', { name: workflowName }) });
  await expect(row).toContainText(String(CALLS));
  await expect(owner.getByRole('link', { name: workflowName })).toHaveAttribute(
    'href',
    `/workflow/${workflowId}`,
  );

  // a tile opens its chart: the buckets of the range are there and the bars hold the total
  await owner.getByRole('link', { name: /Failure rate/ }).click();
  await expect(owner).toHaveURL(/\/insights\/failureRate$/);
  await expect(owner.getByRole('figure', { name: 'Failure rate chart' })).toBeVisible();
  await expect(owner.getByTestId('insights-bucket').first()).toBeVisible();

  // a range change asks again: a day is read by the hour
  const byTime = owner.waitForResponse((response) => response.url().includes('/rest/insights/by-time'));
  await owner.getByRole('combobox', { name: 'Date range' }).selectOption('day');
  expect((await byTime).ok()).toBe(true);

  // 4. the 7-day strip on the Overview shows the same numbers
  await owner.goto('/home/workflows');
  const strip = owner.getByRole('region', { name: 'Last 7 days' });
  for (const type of ['total', 'failed', 'failureRate', 'timeSaved', 'averageRunTime'] as const) {
    await expect(strip.getByTestId(`insights-tile-${type}-value`)).toHaveText(tileText(type, summary[type]));
  }
});

test('a member has no Insights link and no access to the page', async ({ browser }) => {
  // invited and accepted through the API, as p6-scope-gates.spec.ts does
  const email = `insights-member-${id}@example.com`;
  const invite = await owner.request.post('/rest/members/invite', { data: { email, role: 'member' } });
  expect(invite.ok()).toBe(true);
  const { token } = (await invite.json()).data as { token: string };
  const context = await browser.newContext({ extraHTTPHeaders: { origin } });
  const page = await context.newPage();
  const accepted = await page.request.post(`/rest/invitations/${token}/accept`, {
    data: { name: 'Insights Member', password: `member-pass-${token.slice(0, 6)}1` },
  });
  expect(accepted.ok()).toBe(true);

  await page.goto('/home/workflows');
  await expect(page.getByRole('link', { name: 'Settings' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Insights' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Last 7 days' })).toHaveCount(0);

  await page.goto('/insights');
  await expect(page.getByText("You don't have access to Insights")).toBeVisible();
  // the server says no as well
  expect((await page.request.get('/rest/insights/summary')).status()).toBe(403);
  await context.close();
});
