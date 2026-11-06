/**
 * P4-01 Form Trigger in a real browser against a live server (not run by the lane builders): the page
 * lives in the CSP sandbox, so its POST has Origin null, and a redirect and a sanitized description
 * can only be proved here. The rest is covered by server/test/forms.test.ts.
 */
import { expect, type Page, test } from '@playwright/test';

async function signUp(page: Page) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Owner Olive');
  await page.getByLabel('Work email').fill(`owner-${id}@example.com`);
  await page.getByLabel('Password').fill(`form-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Forms ${id}`);
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

/** publishes a workflow with one Form Trigger and answers its path on this origin */
async function publishForm(page: Page, parameters: Record<string, unknown>) {
  const created = await api(page, 'POST', '/workflows', {
    name: `Form ${Date.now()}`,
    nodes: [
      {
        id: crypto.randomUUID(),
        name: 'Form',
        type: 'core.formTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: { path: `form-${crypto.randomUUID()}`, formTitle: 'Contact us', ...parameters },
      },
    ],
    connections: {},
    settings: {},
  });
  const { id } = created.data as { id: string };
  await api(page, 'POST', `/workflows/${id}/activate`, {});
  const urls = await api(page, 'GET', `/workflows/${id}/webhook-urls`);
  const [{ productionUrl }] = urls.data as Array<{ productionUrl: string }>;
  return { id, path: new URL(productionUrl).pathname };
}

const nameField = {
  formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text', requiredField: true }] },
};

test('a person opens the form, is told what is missing, submits, and a run starts', async ({
  page,
  context,
}) => {
  await signUp(page);
  const { id, path } = await publishForm(page, nameField);

  const visitor = await context.newPage();
  const response = await visitor.goto(path);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain('sandbox');
  expect(response?.headers()['content-security-policy']).not.toContain('allow-same-origin');
  expect(response?.headers()['set-cookie']).toBeUndefined();

  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(visitor.getByText('This field is required')).toBeVisible();

  await visitor.getByLabel('Name').fill('Ann');
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(visitor.getByText('Your response has been recorded')).toBeVisible();

  await expect
    .poll(async () => {
      const runs = await page.evaluate(async (workflowId) => {
        const answer = await fetch(`/rest/executions?workflowId=${workflowId}`);
        return JSON.stringify(await answer.json());
      }, id);
      return runs.includes(id);
    })
    .toBe(true);
});

test('a redirect ending leaves the sandboxed page', async ({ page, context }) => {
  await signUp(page);
  const target = new URL('/signin', page.url()).href;
  const { path } = await publishForm(page, {
    ...nameField,
    options: { respondWithOptions: { values: { respondWith: 'redirect', redirectUrl: target } } },
  });

  const visitor = await context.newPage();
  await visitor.goto(path);
  await visitor.getByLabel('Name').fill('Ann');
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(visitor).toHaveURL(/\/signin/);
});

test('a description cannot run a script', async ({ page, context }) => {
  await signUp(page);
  const { path } = await publishForm(page, {
    formDescription: `<b>Welcome</b><img src="https://invalid.example/x" onerror="document.title='owned'"><script>document.title='owned'</script>`,
  });

  const visitor = await context.newPage();
  await visitor.goto(path);
  await expect(visitor.getByText('Welcome')).toBeVisible();
  await expect(visitor).toHaveTitle('Contact us');
});
