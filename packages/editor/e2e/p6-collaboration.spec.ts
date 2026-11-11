/**
 * P6-81 presence and the write lock on the real server (written by lane L14, run once by the main session at
 * the end of S3, never by a lane). Mode: live (`make start`, the server serves the editor on port 8080); the
 * demo router is not used. The spec makes ONE sign-up (the owner, in step 1; the server allows 20 per hour per
 * IP); the admin comes from an invitation accepted through the API (as p6-scope-gates.spec.ts).
 *
 * Flow: the owner and an admin open one team project workflow in two browser contexts. The owner holds the
 * lock; the admin sees the owner's avatar and the read-only banner; the admin takes over after the confirm and
 * the owner turns read-only (banner), with the admin's avatar on the owner's page.
 *
 * Run: E2E_BASE_URL=<server URL> npx playwright test e2e/p6-collaboration.spec.ts
 */
import { expect, test } from '@playwright/test';

// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin;
test.use({ extraHTTPHeaders: { origin } });

test('the second editor sees the first and is read-only, takes over after the confirm, and the first turns read-only', async ({
  page,
  browser,
}) => {
  const id = Date.now().toString(36);

  // 1. the owner: a workspace (the only sign-up of this spec), a team project and a workflow in it
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Collab Owner');
  await page.getByLabel('Work email').fill(`collab-owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`collab-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Collab ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);

  const project = await page.request.post('/rest/projects', { data: { name: `Shared ${id}` } });
  expect(project.ok()).toBe(true);
  const projectId = ((await project.json()).data as { id: string }).id;
  const created = await page.request.post('/rest/workflows', {
    data: { name: `Shared flow ${id}`, nodes: [], connections: {}, projectId },
  });
  expect(created.ok()).toBe(true);
  const workflowId = ((await created.json()).data as { id: string }).id;

  // 2. an admin joins through the API, in their own browser context
  const invite = await page.request.post('/rest/members/invite', {
    data: { email: `collab-admin-${id}@example.com`, role: 'admin' },
  });
  expect(invite.ok()).toBe(true);
  const { token } = (await invite.json()).data as { token: string };
  const context = await browser.newContext({ extraHTTPHeaders: { origin } });
  const adminPage = await context.newPage();
  const accepted = await adminPage.request.post(`/rest/invitations/${token}/accept`, {
    data: { name: 'Collab Admin', password: `admin-pass-${token.slice(0, 6)}1` },
  });
  expect(accepted.ok()).toBe(true);

  // 3. the owner opens the workflow first: holds the lock, no banner
  await page.goto(`/workflow/${workflowId}`);
  await expect(page.getByRole('textbox', { name: 'Workflow name' })).toBeVisible();
  await expect(page.getByTestId('collaborators')).toBeVisible();
  await expect(page.getByTestId('write-lock-banner')).toHaveCount(0);

  // 4. the admin opens it: sees the owner's avatar and the read-only banner, and the owner sees the admin
  await adminPage.goto(`/workflow/${workflowId}`);
  await expect(adminPage.getByRole('textbox', { name: 'Workflow name' })).toBeVisible();
  await expect(adminPage.getByLabel('Collab Owner, editing')).toBeVisible();
  const banner = adminPage.getByTestId('write-lock-banner');
  await expect(banner).toContainText('Collab Owner is editing this workflow.');
  await expect(page.getByLabel('Collab Admin')).toBeVisible();
  await expect(page.getByTestId('write-lock-banner')).toHaveCount(0);

  // 5. the admin takes over after the confirm
  await banner.getByRole('button', { name: 'Take over' }).click();
  const dialog = adminPage.getByRole('dialog');
  await expect(dialog).toContainText('Collab Owner is editing this workflow now');
  await dialog.getByRole('button', { name: 'Take over' }).click();
  await expect(adminPage.getByTestId('write-lock-banner')).toHaveCount(0);
  await expect(adminPage.getByLabel('Collab Admin, editing')).toBeVisible();

  // 6. the owner turns read-only
  await expect(page.getByTestId('write-lock-banner')).toContainText('Collab Admin is editing this workflow.');

  await context.close();
});
