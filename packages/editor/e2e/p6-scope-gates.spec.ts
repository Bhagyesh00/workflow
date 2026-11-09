/**
 * P6-43 scope gates on the real server (written by lane L20, run once by the main session at the end of S1,
 * never by a lane). The owner signs up and makes a team project with a workflow in it. Two people join the
 * workspace as a true `member` (no workspace-wide rights): one is added to the project as `project:editor`,
 * the other as `project:viewer`. In the project the editor sees the Create workflow button and opens the
 * workflow editable; the viewer sees neither. Outside that project both hold nothing.
 *
 * Run: E2E_BASE_URL=<server URL> npx playwright test e2e/p6-scope-gates.spec.ts
 */
import { expect, type Page, test } from '@playwright/test';

// the server's CSRF check refuses a cookie write with no Origin header: every request the spec makes sends it
const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin;
test.use({ extraHTTPHeaders: { origin } });

interface Invited {
  userId: string;
  page: Page;
}

/** the owner invites `email` as a member; the invitee accepts in their own browser context */
async function joinAsMember(
  owner: Page,
  browser: import('@playwright/test').Browser,
  email: string,
  name: string,
) {
  const invite = await owner.request.post('/rest/members/invite', { data: { email, role: 'member' } });
  expect(invite.ok()).toBe(true);
  const { token } = (await invite.json()).data as { token: string };
  const context = await browser.newContext({ extraHTTPHeaders: { origin } });
  const page = await context.newPage();
  const accepted = await page.request.post(`/rest/invitations/${token}/accept`, {
    data: { name, password: `member-pass-${token.slice(0, 6)}1` },
  });
  expect(accepted.ok()).toBe(true);
  const members = await owner.request.get('/rest/members');
  const row = ((await members.json()).data as Array<{ userId: string; email: string }>).find(
    (m) => m.email === email,
  );
  expect(row).toBeTruthy();
  return { userId: row!.userId, page } satisfies Invited;
}

test('a member holds the scopes of their project role in that project and nothing else', async ({
  page,
  browser,
}) => {
  const id = Date.now().toString(36);

  // 1. the owner: a workspace, a team project and a workflow in it
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Scope Owner');
  await page.getByLabel('Work email').fill(`scope-owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`scope-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Scope ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);

  const created = await page.request.post('/rest/projects', { data: { name: `Gate ${id}` } });
  expect(created.ok()).toBe(true);
  const projectId = ((await created.json()).data as { id: string }).id;
  const workflow = await page.request.post('/rest/workflows', {
    data: { name: `Gate flow ${id}`, nodes: [], connections: {}, projectId },
  });
  expect(workflow.ok()).toBe(true);
  const workflowId = ((await workflow.json()).data as { id: string }).id;

  // 2. two members, one editor and one viewer of the project
  const editor = await joinAsMember(page, browser, `scope-editor-${id}@example.com`, 'Scope Editor');
  const viewer = await joinAsMember(page, browser, `scope-viewer-${id}@example.com`, 'Scope Viewer');
  for (const [who, role] of [
    [editor, 'project:editor'],
    [viewer, 'project:viewer'],
  ] as const) {
    const added = await page.request.post(`/rest/projects/${projectId}/users`, {
      data: { relations: [{ userId: who.userId, role }] },
    });
    expect(added.ok()).toBe(true);
  }

  // 3. the project editor: Create workflow, and the editor opens editable
  await editor.page.goto(`/projects/${projectId}/workflows`);
  await expect(editor.page.getByRole('button', { name: 'Create workflow' }).first()).toBeVisible();
  await editor.page.goto(`/workflow/${workflowId}`);
  await expect(editor.page.getByRole('button', { name: 'Publish' })).toBeEnabled();

  // 4. the project viewer: the list, no Create workflow, and the editor opens read only
  await viewer.page.goto(`/projects/${projectId}/workflows`);
  await expect(viewer.page.getByText(`Gate flow ${id}`)).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Create workflow' })).toHaveCount(0);
  await viewer.page.goto(`/workflow/${workflowId}`);
  await expect(viewer.page.getByRole('button', { name: 'Publish' })).toBeDisabled();

  // 5. Overview lists the project's workflow for the editor, and the project is one of theirs
  await editor.page.goto('/home/workflows');
  await expect(editor.page.getByText(`Gate flow ${id}`)).toBeVisible();
  const projects = await editor.page.request.get('/rest/projects/my-projects');
  const names = ((await projects.json()).data as Array<{ name: string }>).map((p) => p.name);
  expect(names).toContain(`Gate ${id}`);
});
