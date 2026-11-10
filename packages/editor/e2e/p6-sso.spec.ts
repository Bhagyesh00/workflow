/**
 * P6-13 the Authentication settings in a real browser (written by lane L11, run once by the main session at the
 * end of S2, never by a lane). Mode: demo (`VITE_DEMO_ROUTER=browser pnpm dev:demo`, editor on port 8080): the
 * demo backend answers every request, so no server and no key are needed, and the spec makes NO sign-ups (the
 * demo opens as the workspace owner). The demo router is in memory by default, so start the demo dev server
 * with VITE_DEMO_ROUTER=browser, or every toHaveURL check fails.
 *
 * Flow: the hub lists SSO, LDAP, two-factor, provisioning and SCIM; an admin opens Single sign-on, saves a SAML
 * metadata URL, sees the entity ID and ACS URL to give the provider, confirms before turning SAML on, and then
 * finds the Members page's Invite button disabled with its tooltip; turning SAML off enables it again. The OIDC
 * form keeps the client secret blank after a save.
 *
 * Run: E2E_BASE_URL=<demo URL> npx playwright test e2e/p6-sso.spec.ts
 */
import { expect, test } from '@playwright/test';

test.describe('Authentication settings (P6-13)', () => {
  test('the hub lists every sign-in setting an admin may open', async ({ page }) => {
    await page.goto('/settings/authentication');
    await expect(page.getByRole('heading', { name: 'Authentication', exact: true })).toBeVisible();
    for (const name of [/Single sign-on/, /LDAP/, /Two-factor authentication/, /Role provisioning/, /SCIM/]) {
      await expect(page.getByRole('main').getByRole('link', { name })).toBeVisible();
    }
    await page
      .getByRole('main')
      .getByRole('link', { name: /Single sign-on/ })
      .click();
    await expect(page).toHaveURL(/\/settings\/sso$/);
    await expect(page.getByRole('heading', { name: 'SAML settings' })).toBeVisible();
  });

  test('an admin sets up SAML, turns it on after a confirmation and Invite is disabled', async ({ page }) => {
    await page.goto('/settings/sso');
    await expect(page.getByRole('heading', { name: 'SAML settings' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Allow SAML sign-in' })).toBeDisabled();

    await page.getByLabel('Metadata URL').fill('https://idp.example.com/metadata');
    await page.getByRole('button', { name: 'Save SAML settings' }).click();
    await expect(page.getByLabel('Entity ID', { exact: true })).toHaveValue(/\/sso\/saml\/.+\/metadata$/);
    await expect(page.getByLabel('Assertion consumer service URL', { exact: true })).toHaveValue(/\/acs$/);
    await expect(page.getByRole('button', { name: 'Copy Entity ID', exact: true })).toBeVisible();

    const toggle = page.getByRole('switch', { name: 'Allow SAML sign-in' });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(page.getByText('Turn on SAML sign-in?')).toBeVisible();
    await page.getByRole('button', { name: 'Turn on SAML', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await page.goto('/settings/members');
    const invite = page.getByRole('button', { name: 'Invite', exact: true });
    await expect(invite).toBeDisabled();
    await expect(invite).toHaveAttribute('title', /managed by your identity provider/);

    await page.goto('/settings/sso');
    await page.getByRole('switch', { name: 'Allow SAML sign-in' }).click();
    await expect(page.getByRole('switch', { name: 'Allow SAML sign-in' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await page.goto('/settings/members');
    await expect(page.getByRole('button', { name: 'Invite', exact: true })).toBeEnabled();
  });

  test('the OIDC client secret stays blank after a save', async ({ page }) => {
    await page.goto('/settings/sso');
    await page.getByLabel('Protocol').selectOption('oidc');
    await expect(page.getByRole('heading', { name: 'OpenID Connect settings' })).toBeVisible();
    await page.getByLabel('Discovery URL').fill('https://idp.example.com/.well-known/openid-configuration');
    await page.getByLabel('Client ID').fill('client-abc');
    await page.getByLabel('Client secret').fill('super-secret-value');
    await page.getByRole('button', { name: 'Save OIDC settings' }).click();
    await expect(page.getByLabel('Redirect URL', { exact: true })).toHaveValue(/\/callback$/);
    await expect(page.getByLabel('Client secret')).toHaveValue('');
  });
});
