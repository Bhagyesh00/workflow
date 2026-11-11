/**
 * P6-80 (L9) the protected workspace in the editor on the real server (written by lane L9, run once by the main
 * session at the end of S4, never by a lane). Mode: live (`make start`, the server serves the editor on port
 * 8080); the demo router is not used. The spec makes ONE sign-up (the owner, in step 1; the server allows 20 per
 * start); the member joins by invitation through the API.
 *
 * Flow: the owner makes a team project and a workflow in it, invites a member as project editor, then turns the
 * switch on through PATCH /rest/source-control/preferences { branchReadOnly: true } (no connection: the settings
 * page shows the switch only once connected). The member sees the lock in the sidebar, no Create workflow, New
 * folder or Add credential button, the canvas read only and Save off, and Publish still enabled. The owner sees
 * the workspace variables page with no Add form and a read-only key, and the value still saves. The switch goes
 * off again and the Create workflow button comes back.
 *
 * Run: E2E_BASE_URL=<server URL> npx playwright test e2e/p6-protected.spec.ts
 */
import { expect, test } from '@playwright/test';

// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin;
test.use({ extraHTTPHeaders: { origin } });

test('a protected workspace locks the canvas and the create buttons, and Publish stays', async ({
  page,
  browser,
}) => {
  const id = Date.now().toString(36);

  // 1. the owner: a workspace (the only sign-up of this spec), a team project and a workflow made before the switch
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Protected Owner');
  await page.getByLabel('Work email').fill(`protected-owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`protected-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Protected ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);

  const created = await page.request.post('/rest/projects', { data: { name: `Locked ${id}` } });
  expect(created.ok()).toBe(true);
  const projectId = ((await created.json()).data as { id: string }).id;
  const workflow = await page.request.post('/rest/workflows', {
    data: { name: `Locked flow ${id}`, nodes: [], connections: {}, projectId },
  });
  expect(workflow.ok()).toBe(true);
  const workflowId = ((await workflow.json()).data as { id: string }).id;
  const variable = await page.request.post('/rest/variables', { data: { key: `region_${id}`, value: 'eu' } });
  expect(variable.ok()).toBe(true);

  // 2. a member by invitation, project editor of that project
  const memberEmail = `protected-member-${id}@example.com`;
  const invite = await page.request.post('/rest/members/invite', {
    data: { email: memberEmail, role: 'member' },
  });
  expect(invite.ok()).toBe(true);
  const { token } = (await invite.json()).data as { token: string };
  const memberContext = await browser.newContext({ extraHTTPHeaders: { origin } });
  const member = await memberContext.newPage();
  const accepted = await member.request.post(`/rest/invitations/${token}/accept`, {
    data: { name: 'Protected Member', password: `member-pass-${token.slice(0, 6)}1` },
  });
  expect(accepted.ok()).toBe(true);
  const members = await page.request.get('/rest/members');
  const row = ((await members.json()).data as Array<{ userId: string; email: string }>).find(
    (m) => m.email === memberEmail,
  );
  expect(row).toBeTruthy();
  const added = await page.request.post(`/rest/projects/${projectId}/users`, {
    data: { relations: [{ userId: row?.userId, role: 'project:editor' }] },
  });
  expect(added.ok()).toBe(true);

  // before the switch the member creates and edits
  await member.goto(`/projects/${projectId}/workflows`);
  await expect(member.getByRole('button', { name: 'Create workflow' }).first()).toBeVisible();
  await member.goto(`/workflow/${workflowId}`);
  await expect(member.getByRole('button', { name: 'Publish' })).toBeEnabled();
  await expect(member.getByRole('status', { name: /Protected workspace/ })).toHaveCount(0);

  // 3. the owner turns the switch on with no connection
  const on = await page.request.patch('/rest/source-control/preferences', {
    data: { branchReadOnly: true },
  });
  expect(on.ok()).toBe(true);

  // 4. the member: the lock, no create buttons, the canvas read only, Publish still enabled
  await member.goto(`/projects/${projectId}/workflows`);
  await expect(member.getByRole('status', { name: /Protected workspace/ })).toBeVisible();
  await expect(member.getByText(`Locked flow ${id}`)).toBeVisible();
  await expect(member.getByRole('button', { name: 'Create workflow' })).toHaveCount(0);
  await expect(member.getByRole('button', { name: 'New folder' })).toHaveCount(0);
  await member.goto('/home/credentials');
  await expect(member.getByRole('heading', { name: 'Credentials' })).toBeVisible();
  await expect(member.getByRole('button', { name: 'Add credential' })).toHaveCount(0);
  await member.goto(`/workflow/${workflowId}`);
  await expect(member.getByRole('button', { name: 'Publish' })).toBeEnabled();
  await expect(member.getByRole('button', { name: /^Save/ })).toBeDisabled();

  // 5. the owner: the variables page has no Add form, no Delete, and a read-only key; the value still saves
  await page.goto('/settings/variables');
  const value = page.getByLabel(`Value of region_${id}`);
  await expect(value).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Delete region_${id}` })).toHaveCount(0);
  await expect(page.getByLabel('Key')).toHaveAttribute('readonly', '');
  await value.fill('us');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Variable saved')).toBeVisible();

  // 6. the switch off: the lock goes and the create button returns
  const off = await page.request.patch('/rest/source-control/preferences', {
    data: { branchReadOnly: false },
  });
  expect(off.ok()).toBe(true);
  await member.goto(`/projects/${projectId}/workflows`);
  await expect(member.getByRole('button', { name: 'Create workflow' }).first()).toBeVisible();
  await expect(member.getByRole('status', { name: /Protected workspace/ })).toHaveCount(0);
  await memberContext.close();
});
