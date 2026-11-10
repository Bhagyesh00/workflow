/**
 * P6-15 private credentials in a real browser, on the real server (live, `make start`; written by lane L14,
 * run once by the main session, never by a lane). The spec signs up once (beforeAll: 1 sign-up of the 20 an
 * hour per IP), adds a team project, then:
 *  - creates an OAuth2 credential in that project with the Private credential switch on; after a reload the
 *    modal shows its private part: not connected, 0 users connected, and "Connect my account";
 *  - the credential row shows Private and Not connected; the move dialog warns and offers no personal project;
 *  - switching back to one shared account saves (no connection yet, so no confirm).
 * No provider sign-in runs (no real identity provider): the connect itself is covered by the server tests.
 *
 * Run: make start (the real server), then
 *      E2E_BASE_URL=<server URL> npx playwright test e2e/p6-private-credentials.spec.ts
 */
import { expect, type Page, test } from '@playwright/test';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });

let page: Page;
let projectId = '';
const id = `pc-${Date.now().toString(36)}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Private Tester');
  await page.getByLabel('Work email').fill(`private-${id}@example.com`);
  await page.getByLabel('Password').fill(`private-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Private ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/home\/workflows$/);
  await sidebar(page).getByRole('button', { name: 'Add project' }).click();
  await expect(page).toHaveURL(/\/projects\/([^/]+)\/settings$/);
  projectId = /\/projects\/([^/]+)\//.exec(page.url())?.[1] ?? '';
});

test.afterAll(async () => {
  await page.close();
});

const credentialName = `Team mail ${id}`;

test.describe('Private credentials (P6-15)', () => {
  test('an OAuth2 credential is created private in a team project', async () => {
    await page.goto(`/projects/${projectId}/credentials`);
    await page.getByRole('button', { name: 'Add credential' }).first().click();
    await page.getByLabel('Search credential types').fill('OAuth2 API');
    await page
      .getByRole('button', { name: /^OAuth2 API/ })
      .first()
      .click();
    await page.getByLabel('Name', { exact: true }).fill(credentialName);
    await page
      .getByRole('textbox', { name: /^Authorization URL/ })
      .fill('https://auth.example.com/authorize');
    await page.getByRole('textbox', { name: /^Access Token URL/ }).fill('https://auth.example.com/token');
    await page.getByRole('textbox', { name: /^Client ID/ }).fill('shared-client');
    const toggle = page.getByRole('switch', { name: 'Private credential', exact: true });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const section = page.getByRole('region', { name: 'Private credential', exact: true });
    await expect(section.getByText('Not connected', { exact: true })).toBeVisible();
    await expect(section.getByText('0 users connected', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect my account', exact: true })).toBeVisible();
  });

  test('the list row and the move dialog show it as private after a reload', async () => {
    await page.goto(`/projects/${projectId}/credentials`);
    const row = page.getByRole('listitem').filter({ hasText: credentialName });
    await expect(row.getByText('Private', { exact: true })).toBeVisible();
    await expect(row.getByText('Not connected', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: `Actions for ${credentialName}` }).click();
    await page.getByRole('menuitem', { name: 'Move to project' }).click();
    await expect(
      page.getByText(/This credential is private\. It can't move to a personal project/),
    ).toBeVisible();
    const destination = page.getByLabel('Destination project');
    await expect(destination.getByRole('option', { name: /\(personal\)/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('switching back to one shared account saves', async () => {
    await page.goto(`/projects/${projectId}/credentials`);
    await page.getByRole('button', { name: new RegExp(`^${credentialName}`) }).click();
    const section = page.getByRole('region', { name: 'Private credential', exact: true });
    const toggle = section.getByRole('switch', { name: 'Private credential', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.reload();
    await page.goto(`/projects/${projectId}/credentials`);
    const row = page.getByRole('listitem').filter({ hasText: credentialName });
    await expect(row.getByText('Private', { exact: true })).toHaveCount(0);
  });
});
