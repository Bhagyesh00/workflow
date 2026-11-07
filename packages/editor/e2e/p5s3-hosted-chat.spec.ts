/**
 * P5-56 hosted chat page in a real browser against a live server (run once by the main session at the end
 * of the stage, never by a lane). The page lives in the CSP sandbox (opaque origin, `Origin: null`), loads
 * the widget from /chat-widget (cross-origin-resource-policy: cross-origin) and reaches the chat with its
 * page token; only a real browser proves those. The reply comes from a Set node, so no model key is needed.
 *
 * Run it against the server, not Vite, with the editor and the widget built
 * (pnpm --filter @workflow/editor build; make start builds the widget):
 * CORS_ORIGINS=http://localhost:5678 make start, then E2E_BASE_URL=http://localhost:5678.
 */
import { expect, type Page, test } from '@playwright/test';

async function signUp(page: Page) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Owner Olive');
  await page.getByLabel('Work email').fill(`owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`chat-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Chats ${id}`);
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

const REPLY = 'Hello from the hosted chat';

/**
 * Publishes Chat Trigger (public, hosted page, a specific origin list so only the page token lets the
 * sandbox in) -> Set `output`, and answers the chat path on this origin.
 */
async function publishChat(page: Page) {
  const created = await api(page, 'POST', '/workflows', {
    name: `Hosted chat ${Date.now()}`,
    nodes: [
      {
        id: crypto.randomUUID(),
        name: 'Chat',
        type: 'ai.chatTrigger',
        typeVersion: 1,
        position: [0, 0],
        webhookId: crypto.randomUUID(),
        parameters: {
          public: true,
          mode: 'hostedChat',
          initialMessages: 'Welcome to the test chat',
          options: { title: 'Hosted test chat', allowedOrigins: 'https://shop.example.com' },
        },
      },
      {
        id: crypto.randomUUID(),
        name: 'Set',
        type: 'core.set',
        typeVersion: 1,
        position: [200, 0],
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
  const { id } = created.data as { id: string };
  await api(page, 'POST', `/workflows/${id}/activate`, {});
  const urls = await api(page, 'GET', `/workflows/${id}/webhook-urls`);
  const hooks = urls.data as Array<{ method: string; productionUrl: string }>;
  const setup = hooks.find((h) => h.method === 'GET') ?? hooks[0];
  return { id, path: new URL(setup.productionUrl).pathname };
}

test('a visitor opens the hosted chat, sends a message, sees the reply, and a reload keeps the session', async ({
  page,
  context,
}) => {
  await signUp(page);
  const { path } = await publishChat(page);

  const visitor = await context.newPage();
  const problems: string[] = [];
  visitor.on('console', (message) => {
    const text = message.text();
    if (
      /localStorage|sessionStorage|SecurityError|Cross-Origin-Resource-Policy|ERR_BLOCKED_BY_RESPONSE/i.test(
        text,
      )
    ) {
      problems.push(text);
    }
  });
  visitor.on('pageerror', (error) => problems.push(error.message));
  visitor.on('requestfailed', (request) => {
    if (request.url().includes('/chat-widget/'))
      problems.push(`${request.url()} ${request.failure()?.errorText}`);
  });

  const response = await visitor.goto(path);
  expect(response?.status()).toBe(200);
  const headers = response?.headers() ?? {};
  expect(headers['content-security-policy']).toContain('sandbox');
  expect(headers['content-security-policy']).not.toContain('allow-same-origin');
  expect(headers['cache-control']).toBe('no-store');
  expect(headers['set-cookie']).toBeUndefined();

  await expect(visitor.getByText('Welcome to the test chat')).toBeVisible();
  await visitor.locator('.chat-input').fill('Hi there');
  await visitor.locator('.chat-input-send-button').click();
  await expect(visitor.locator('.chat-message-from-bot', { hasText: REPLY })).toBeVisible();

  // the session id is in the fragment, so a reload keeps it
  await expect.poll(() => new URL(visitor.url()).hash).toMatch(/sessionId=/);
  const session = new URL(visitor.url()).hash;
  await visitor.reload();
  await expect(visitor.locator('.chat-input')).toBeVisible();
  expect(new URL(visitor.url()).hash).toBe(session);

  expect(problems).toEqual([]);
});
