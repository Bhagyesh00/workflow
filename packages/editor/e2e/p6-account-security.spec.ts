/**
 * P6-19 account and password reset on the real server (written by lane L3, run once by the main session at
 * the end of S2, never by a lane). Mode: live (`make start`, the server serves the editor on port 8080); the
 * demo router is not used. The spec makes ONE sign-up (the owner, in step 1; the server allows 20 per hour per
 * IP); the member comes from an invitation accepted through the API. The workspace has no mail set up.
 *
 * Flow: the owner changes the name and the password in Settings > Your account (a wrong current password is
 * refused with the server's text); the owner copies a member's reset link from the Members page, the member
 * opens it, the token leaves the address bar, a new password is chosen and the old one stops working; the same
 * link works once; the forgot password page shows the server's text because no mail is set up.
 *
 * Run: E2E_BASE_URL=<server URL> npx playwright test e2e/p6-account-security.spec.ts
 */
import { expect, test } from '@playwright/test';

// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin;
test.use({ extraHTTPHeaders: { origin } });

test('an owner changes the account, an admin copies a reset link and the member uses it once', async ({
  page,
  browser,
}) => {
  const id = Date.now().toString(36);
  const ownerEmail = `account-owner-${id}@example.com`;
  const ownerPassword = `account-pass-${id}1`;
  const newOwnerPassword = `account-new-${id}2`;

  // 1. the owner: a workspace (the only sign-up of this spec)
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Account Owner');
  await page.getByLabel('Work email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByLabel('Workspace name').fill(`Account ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);

  // 2. the name
  await page.goto('/settings/account');
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('Account Owner Two');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Name saved')).toBeVisible();

  // 3. the password: a wrong current password is refused, the right one works
  await page.getByRole('button', { name: 'Change password' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change password' });
  await dialog.getByLabel('Current password').fill('not-the-password-1');
  await dialog.getByLabel('New password', { exact: true }).fill(newOwnerPassword);
  await dialog.getByLabel('Repeat the new password').fill(newOwnerPassword);
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(dialog.getByText('The current password is not correct')).toBeVisible();
  await dialog.getByLabel('Current password').fill(ownerPassword);
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed')).toBeVisible();
  await expect(dialog).toBeHidden();

  // the old password no longer signs in, the new one does
  const other = await browser.newContext({ extraHTTPHeaders: { origin } });
  const check = await other.request.post('/rest/auth/login', {
    data: { email: ownerEmail, password: ownerPassword },
  });
  expect(check.status()).toBe(401);
  const okLogin = await other.request.post('/rest/auth/login', {
    data: { email: ownerEmail, password: newOwnerPassword },
  });
  expect(okLogin.status()).toBe(200);
  await other.close();

  // 4. a member by invitation (no mail: the answer carries the token)
  const memberEmail = `account-member-${id}@example.com`;
  const memberPassword = `member-pass-${id}1`;
  const invite = await page.request.post('/rest/members/invite', {
    data: { email: memberEmail, role: 'member' },
  });
  expect(invite.ok()).toBeTruthy();
  const token = ((await invite.json()) as { data: { token: string } }).data.token;
  const memberContext = await browser.newContext({ extraHTTPHeaders: { origin } });
  const accepted = await memberContext.request.post(`/rest/invitations/${token}/accept`, {
    data: { name: 'Account Member', password: memberPassword },
  });
  expect(accepted.ok()).toBeTruthy();
  await memberContext.close();

  // 5. the owner copies the member's reset link
  const clipboardContext = page.context();
  await clipboardContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto('/settings/members');
  await page.getByRole('button', { name: 'Copy password reset link for Account Member' }).click();
  await expect(page.getByText('Reset link copied')).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('/reset-password?token=');
  // an owner has no such button
  await expect(page.getByRole('button', { name: /Copy password reset link for Account Owner/ })).toHaveCount(
    0,
  );

  // 6. the member opens it: the token leaves the address bar, a new password is chosen
  const brandNew = `member-new-${id}2`;
  const resetContext = await browser.newContext({ extraHTTPHeaders: { origin } });
  const reset = await resetContext.newPage();
  await reset.goto(link);
  await expect(reset.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await expect(reset).toHaveURL(/\/reset-password$/);
  await reset.getByLabel('New password', { exact: true }).fill(brandNew);
  await reset.getByLabel('Repeat the new password').fill(brandNew);
  await reset.getByRole('button', { name: 'Change password' }).click();
  await expect(reset.getByText('Password changed')).toBeVisible();

  // 7. the old password is dead, the new one signs in, and the link works once
  const oldLogin = await resetContext.request.post('/rest/auth/login', {
    data: { email: memberEmail, password: memberPassword },
  });
  expect(oldLogin.status()).toBe(401);
  const newLogin = await resetContext.request.post('/rest/auth/login', {
    data: { email: memberEmail, password: brandNew },
  });
  expect(newLogin.status()).toBe(200);
  const again = await resetContext.newPage();
  await again.goto(link);
  await expect(again.getByText('This link does not work')).toBeVisible();
  await resetContext.close();

  // 8. no mail is set up: the forgot password page says so with the server's text
  await page.context().clearCookies();
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/Email sending must be set up/)).toBeVisible();
});
