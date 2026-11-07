/**
 * P5-59 canvas chat in a real browser against a live server (run once by the main session at the end of the
 * stage, never by a lane). One round trip: open a saved Chat Trigger -> Set workflow, click "Open chat", send a
 * message, see the reply in the panel and the run on the canvas. The test POST must stay on the page's origin
 * (CSP connect-src 'self'), which the spec checks on the request itself.
 *
 * Run it against the server, not Vite, with the editor and the widget built
 * (pnpm --filter @workflow/editor build; make start builds the widget):
 * make start, then E2E_BASE_URL=http://localhost:5678.
 */
import { expect, type Page, test } from '@playwright/test';

async function signUp(page: Page) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Owner Olive');
  await page.getByLabel('Work email').fill(`owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`chat-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Canvas chat ${id}`);
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

const REPLY = 'Hello from the canvas chat';

/** a saved, not active workflow: Chat Trigger (not public) -> Set `output` */
async function createChatWorkflow(page: Page) {
  const created = await api(page, 'POST', '/workflows', {
    name: `Canvas chat ${Date.now()}`,
    nodes: [
      {
        id: crypto.randomUUID(),
        name: 'Chat',
        type: 'ai.chatTrigger',
        typeVersion: 1,
        position: [0, 0],
        webhookId: crypto.randomUUID(),
        parameters: { public: false, options: {} },
      },
      {
        id: crypto.randomUUID(),
        name: 'Set',
        type: 'core.set',
        typeVersion: 1,
        position: [260, 0],
        parameters: {
          mode: 'manual',
          assignments: {
            assignments: [{ id: crypto.randomUUID(), name: 'output', value: REPLY, type: 'string' }],
          },
        },
      },
    ],
    connections: { Chat: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
    settings: {},
  });
  return (created.data as { id: string }).id;
}

test('a message in the canvas chat runs the workflow and shows the reply', async ({ page }) => {
  await signUp(page);
  const id = await createChatWorkflow(page);
  await page.goto(`/workflow/${id}`);

  // a chat trigger has no "Listen for test event": the bar opens the chat instead
  await expect(page.getByRole('button', { name: 'Listen for test event' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open chat' }).click();
  await expect(page.getByRole('tab', { name: 'Chat', selected: true })).toBeVisible();

  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/webhook-test/')) posts.push(request.url());
  });

  const input = page.getByPlaceholder('Type your question...');
  await input.fill('Hello canvas');
  await input.press('Enter');

  await expect(page.getByText(REPLY)).toBeVisible();
  // the POST stayed on the page's origin, and the run is on the canvas
  expect(posts).toHaveLength(1);
  expect(new URL(posts[0]).origin).toBe(new URL(page.url()).origin);
  await expect(page.getByRole('link', { name: 'View execution' })).toBeVisible();

  // a second message is a second run
  await input.fill('Again');
  await input.press('Enter');
  await expect.poll(() => posts.length).toBe(2);

  // a new session starts clean
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(page.getByText(REPLY)).toHaveCount(0);
});
