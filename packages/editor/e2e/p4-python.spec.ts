/**
 * P4-06 Python in the Code node against a live server (not run by the lane builders): sign up, build
 * Manual Trigger -> Code in Python, run it, read the output, then show that an import is refused.
 */
import { expect, test } from '@playwright/test';

test('a Python Code node transforms items, and an import is refused', async ({ page }) => {
  test.setTimeout(120_000);
  const id = Date.now().toString(36);

  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Python Tester');
  await page.getByLabel('Work email').fill(`python-${id}@example.com`);
  await page.getByLabel('Password').fill(`python-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Python ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);

  await page.getByRole('button', { name: 'Create workflow' }).first().click();
  await expect(page).toHaveURL(/\/workflow\/new$/);
  await page.getByRole('button', { name: 'Add the first step' }).click();
  const creator = page.getByRole('complementary', { name: 'Node creator' });
  await creator.getByRole('textbox', { name: 'Search nodes' }).fill('manual');
  await creator.getByTestId('creator-item-core.manualTrigger').click();
  const ndv = page.getByRole('dialog', { name: /details$/ });
  await expect(ndv).toBeVisible();
  await ndv.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Add node' }).click();
  await creator.getByRole('textbox', { name: 'Search nodes' }).fill('python');
  await creator.getByTestId('creator-item-core.code').click();
  await expect(ndv).toBeVisible();

  // the language swaps the editor and its default code
  await ndv.getByLabel('Language').selectOption({ label: 'Python' });
  const editor = ndv.getByTestId('code-editor-python');
  await expect(editor).toContainText('my_new_field');
  await expect(ndv.getByText('Debug with print()')).toBeVisible();

  const replaceCode = async (code: string) => {
    await editor.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(code);
  };

  await replaceCode('return [{"answer": 6 * 7}]');
  await ndv.getByRole('button', { name: 'Close' }).click();

  // the first Python run of a server starts the interpreter, so it may take a while
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page).toHaveURL(/\/workflow\/[0-9a-f-]{8,}/);
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 60_000 });
  const codeNode = page.locator('.react-flow__node', { hasText: 'Code' });
  await codeNode.dblclick();
  const output = ndv.getByRole('region', { name: 'Output' });
  await expect(output.getByText('answer').first()).toBeVisible();
  await expect(output.getByText('42').first()).toBeVisible();

  await replaceCode('import os\nreturn []');
  await ndv.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await codeNode.dblclick();
  await expect(
    ndv.getByText("Import of standard library module 'os' is disallowed", { exact: false }).first(),
  ).toBeVisible({ timeout: 60_000 });
});
