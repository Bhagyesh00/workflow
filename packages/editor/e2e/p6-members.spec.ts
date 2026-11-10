/**
 * P6-20 members page on the real server (written by lane L4, run once by the main session at the end of S2,
 * never by a lane). Mode: live (`make start`, the server serves the editor on port 8080); the demo router is
 * not used. The spec makes ONE sign-up (in the first step; the server allows 20 per hour per IP) and does the
 * rest through the owner's session. The workspace has no mail set up, so every invitation answers its link.
 *
 * Flow: the owner invites three people at once from the dialog, sees three Pending rows and three links; one
 * invitation is resent in the UI and its old link stops working (404 on accept) while the new one works; the
 * list is searched, filtered by role and sorted; a second accepted member shows in the list as active.
 *
 * Run: E2E_BASE_URL=<server URL> npx playwright test e2e/p6-members.spec.ts
 */
import { expect, test } from '@playwright/test';

// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin;
test.use({ extraHTTPHeaders: { origin } });

test('an owner invites several people, resends one invitation and finds people in the list', async ({
  page,
  browser,
}) => {
  const id = Date.now().toString(36);

  // 1. the owner: a workspace (the only sign-up of this spec)
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Members Owner');
  await page.getByLabel('Work email').fill(`members-owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`members-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Members ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);

  // 2. three people at once from the dialog
  const emails = [`ann-${id}@example.com`, `bob-${id}@example.com`, `cy-${id}@example.com`];
  await page.goto('/settings/members');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite a member' });
  await dialog.getByLabel('Email', { exact: true }).fill(emails.join(', '));
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  const results = dialog.getByRole('list', { name: 'Invitation results' });
  await expect(results.locator('code')).toHaveCount(3);
  const firstLink = (await results.locator('code').first().textContent()) ?? '';
  expect(firstLink).toMatch(/\/invitation\/.+/);
  const oldToken = firstLink.slice(firstLink.lastIndexOf('/') + 1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();

  // 3. the three are Pending rows
  await expect(page.getByText('Pending', { exact: true })).toHaveCount(3);

  // 4. resend the first one: a new link is shown (no mail here) and the old link is dead
  const annRow = page.getByRole('listitem').filter({ hasText: emails[0] });
  await annRow.getByRole('button', { name: 'Resend' }).click();
  const linkDialog = page.getByRole('dialog', { name: 'Invitation link' });
  const newLink = (await linkDialog.locator('code').textContent()) ?? '';
  expect(newLink).toMatch(/\/invitation\/.+/);
  const newToken = newLink.slice(newLink.lastIndexOf('/') + 1);
  expect(newToken).not.toBe(oldToken);
  await linkDialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  const stale = await page.request.post(`/rest/invitations/${oldToken}/accept`, {
    data: { name: 'Ann', password: `member-pass-${id}1` },
    headers: { origin },
  });
  expect(stale.status()).toBe(404);
  const accepted = await browser.newContext({ extraHTTPHeaders: { origin } });
  const joined = await accepted.request.post(`/rest/invitations/${newToken}/accept`, {
    data: { name: 'Ann Adams', password: `member-pass-${id}1` },
  });
  expect(joined.ok()).toBe(true);
  await accepted.close();

  // 5. search, filter and sort
  await page.reload();
  await expect(page.getByText('Pending', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Ann Adams')).toBeVisible();
  await page.getByLabel('Search members').fill(`bob-${id}`);
  await expect(page.getByRole('listitem').filter({ hasText: emails[1] })).toBeVisible();
  await expect(page.getByText('Ann Adams')).toHaveCount(0);
  await page.getByLabel('Search members').fill('');
  await page.getByLabel('Filter by role').selectOption('admin');
  await expect(page.getByText('No members match')).toBeVisible();
  await page.getByLabel('Filter by role').selectOption('');
  await page.getByRole('button', { name: 'Sort by Role' }).click();
  await expect(page.getByRole('button', { name: 'Sort by Role' })).toHaveAttribute('aria-pressed', 'true');
});
