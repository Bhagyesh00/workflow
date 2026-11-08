/**
 * P5-62 AI builder panel and draft review in a real browser (written by the lane, run once by the main session
 * at the end of S4, never by a lane). The live server has no model key in a test run, so the spec answers the
 * builder's own routes in the page (`/rest/settings` gets `features.aiBuilder` on, `/rest/ai/sessions` an empty
 * chat, `/rest/ai/build` a scripted NDJSON stream); everything else, the Accept save above all, goes to the
 * real server. It proves: the stream draws progress and the draft on the canvas, nothing saves while the draft
 * is under review (no PATCH for longer than the autosave wait), the review shows the old and new URL, Discard
 * puts the canvas back without a request, and Accept saves once on the version the draft started from.
 *
 * Run against the server with the editor built, or the Vite dev server proxying to it:
 * make start, then E2E_BASE_URL=http://localhost:5678 (or the default http://localhost:8080).
 */
import { expect, type Page, type Request, test } from '@playwright/test';

async function signUp(page: Page) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Builder Bea');
  await page.getByLabel('Work email').fill(`builder-${id}@example.com`);
  await page.getByLabel('Password').fill(`builder-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Builder ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);
}

/** a saved workflow: Manual Trigger -> HTTP Request on the old URL */
async function createWorkflow(page: Page): Promise<{ id: string; versionId: string }> {
  return page.evaluate(async () => {
    const response = await fetch('/rest/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Builder ${Date.now()}`,
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
            name: 'Call API',
            type: 'core.httpRequest',
            typeVersion: 1,
            position: [260, 0],
            parameters: { method: 'GET', url: 'https://api.example.com/old' },
          },
        ],
        connections: { Start: { main: [[{ node: 'Call API', type: 'main', index: 0 }]] } },
      }),
    });
    const { data } = (await response.json()) as { data: { id: string; versionId: string } };
    return { id: data.id, versionId: data.versionId };
  });
}

/** the builder's routes answered in the page; the stream changes the URL and adds a node */
async function fakeBuilder(page: Page, workflowId: string) {
  await page.route('**/rest/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { data: { features?: Record<string, unknown> } };
    body.data.features = { ...body.data.features, aiBuilder: { enabled: true, setup: true } };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/rest/ai/sessions', (route) =>
    route.fulfill({
      json: {
        data: { workflowId, messages: [], activeVersionCardId: null, resumeAfterRestoreMessageId: null },
      },
    }),
  );
  await page.route('**/rest/ai/build', async (route) => {
    const body = route.request().postDataJSON() as {
      workflowData: { nodes: Array<Record<string, unknown> & { name: string }> };
    };
    const nodes: Array<Record<string, unknown>> = body.workflowData.nodes.map((n) =>
      n.name === 'Call API'
        ? { ...n, parameters: { method: 'POST', url: 'https://hooks.example.net/collect' } }
        : n,
    );
    nodes.push({
      id: 'b5c0f6c2-2f43-4c84-9b8a-0d8f3b1f7a10',
      name: 'Shape',
      type: 'core.set',
      typeVersion: 1,
      position: [520, 0],
      parameters: { mode: 'raw' },
    });
    const chunks = [
      { type: 'tool', toolName: 'search_nodes', status: 'running' },
      { type: 'tool', toolName: 'search_nodes', status: 'done', summary: 'Found Edit Fields' },
      {
        type: 'workflow-updated',
        workflow: {
          name: 'Draft',
          nodes,
          connections: {
            Start: { main: [[{ node: 'Call API', type: 'main', index: 0 }]] },
            'Call API': { main: [[{ node: 'Shape', type: 'main', index: 0 }]] },
          },
        },
      },
      { type: 'message', id: 'a1', text: 'I pointed **Call API** at the new endpoint and added Shape.' },
    ];
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
      body: `${chunks.map((c) => JSON.stringify(c)).join('\n')}\n`,
    });
  });
}

const isWorkflowPatch = (id: string) => (request: Request) =>
  request.method() === 'PATCH' && new URL(request.url()).pathname === `/rest/workflows/${id}`;

async function buildDraft(page: Page) {
  await page.getByRole('button', { name: 'Build with AI' }).first().click();
  const panel = page.getByRole('complementary', { name: 'AI builder' });
  await expect(panel).toBeVisible();
  await panel
    .getByRole('textbox', { name: 'Message the AI builder' })
    .fill('Send the leads to the new endpoint');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByText('Found Edit Fields')).toBeVisible();
  await expect(panel.getByText(/I pointed/)).toBeVisible();
  const review = panel.getByRole('region', { name: 'Draft review' });
  await expect(review.getByText(/Edits · 2 nodes/)).toBeVisible();
  return { panel, review };
}

test('the builder drafts on the canvas, saves nothing during the review, and Discard restores it', async ({
  page,
}) => {
  await signUp(page);
  const wf = await createWorkflow(page);
  await fakeBuilder(page, wf.id);
  const patches: Request[] = [];
  page.on('request', (request) => {
    if (isWorkflowPatch(wf.id)(request)) patches.push(request);
  });
  await page.goto(`/workflow/${wf.id}`);
  const { review } = await buildDraft(page);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Shape' })).toBeVisible();
  // the reviewer reads both URLs as text
  const changes = review.getByRole('group', { name: 'Changes to Call API' });
  await expect(changes.getByText('https://api.example.com/old')).toBeVisible();
  await expect(changes.getByText('https://hooks.example.net/collect')).toBeVisible();
  // longer than the autosave wait (5 s): nothing saved the draft
  await page.waitForTimeout(6500);
  expect(patches).toHaveLength(0);

  await review.getByRole('button', { name: 'Discard' }).click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Shape' })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(patches).toHaveLength(0);
});

test('Accept saves the draft once on the version it started from', async ({ page }) => {
  await signUp(page);
  const wf = await createWorkflow(page);
  await fakeBuilder(page, wf.id);
  await page.goto(`/workflow/${wf.id}`);
  const { review } = await buildDraft(page);
  const saved = page.waitForRequest(isWorkflowPatch(wf.id));
  await review.getByRole('button', { name: 'Accept' }).click();
  const request = await saved;
  const body = request.postDataJSON() as {
    versionId: string;
    nodes: Array<{ name: string; parameters: unknown }>;
  };
  expect(body.versionId).toBe(wf.versionId);
  expect(body.nodes.map((n) => n.name)).toEqual(['Start', 'Call API', 'Shape']);
  await expect(review).toHaveCount(0);

  // the saved row holds the draft
  const stored = await page.evaluate(async (id) => {
    const response = await fetch(`/rest/workflows/${id}`);
    return (
      (await response.json()) as { data: { nodes: Array<{ name: string; parameters: { url?: string } }> } }
    ).data;
  }, wf.id);
  expect(stored.nodes.find((n) => n.name === 'Call API')?.parameters.url).toBe(
    'https://hooks.example.net/collect',
  );
});
