/**
 * P3-04 canvas groups against a live server: build Manual Trigger -> Edit Fields -> Edit Fields1,
 * group the two Edit Fields nodes with Ctrl+G, rename the group inline, drag its title bar (every
 * member moves), save, reload (the group and its expanded state come back), then collapse it into
 * one card and expand it again. Run with `pnpm --filter @workflow/editor e2e`.
 */
import { expect, type Page, test } from '@playwright/test';

async function addNode(page: Page, search: string, type: string) {
  const creator = page.getByRole('complementary', { name: 'Node creator' });
  await creator.getByRole('textbox', { name: 'Search nodes' }).fill(search);
  await creator.getByTestId(`creator-item-${type}`).click();
  const ndv = page.getByRole('dialog', { name: /details$/ });
  await expect(ndv).toBeVisible();
  await ndv.getByRole('button', { name: 'Close' }).click();
}

const nodeBox = async (page: Page, name: string) => {
  const box = await page.locator('.react-flow__node-workflowNode', { hasText: name }).first().boundingBox();
  if (!box) throw new Error(`no box for ${name}`);
  return box;
};

test('group two nodes, rename, drag the title, save, reload, collapse and expand', async ({ page }) => {
  const id = Date.now().toString(36);
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Groups Tester');
  await page.getByLabel('Work email').fill(`groups-${id}@example.com`);
  await page.getByLabel('Password').fill(`groups-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Groups ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);

  await page.getByRole('button', { name: 'Create workflow' }).first().click();
  await page.getByRole('button', { name: 'Add the first step' }).click();
  await addNode(page, 'manual', 'core.manualTrigger');
  await page.getByRole('button', { name: 'Add node' }).click();
  await addNode(page, 'edit fields', 'core.set');
  await page.getByRole('button', { name: 'Add node' }).click();
  await addNode(page, 'edit fields', 'core.set');

  // select both Edit Fields nodes and group them
  await page.locator('.react-flow__node-workflowNode', { hasText: 'Edit Fields' }).first().click();
  await page
    .locator('.react-flow__node-workflowNode', { hasText: 'Edit Fields1' })
    .click({ modifiers: ['Shift'] });
  await expect(page.getByRole('toolbar', { name: 'Selection actions' })).toContainText('2 selected');
  await page.keyboard.press('Control+g');

  const nameInput = page.getByRole('textbox', { name: 'Group name' });
  await expect(nameInput).toBeFocused();
  await nameInput.fill('Prepare');
  await nameInput.press('Enter');
  const frame = page.locator('.react-flow__node-nodeGroup', { hasText: 'Prepare' });
  await expect(frame).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse group Prepare' })).toBeVisible();

  // drag the title bar: both members move by the same step, the trigger stays
  const before = [await nodeBox(page, 'Edit Fields'), await nodeBox(page, 'Edit Fields1')];
  const trigger = await nodeBox(page, 'When clicking');
  const title = await frame.getByTestId('group-title').boundingBox();
  if (!title) throw new Error('no title bar');
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(title.x + title.width / 2 + 120, title.y + title.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  const after = [await nodeBox(page, 'Edit Fields'), await nodeBox(page, 'Edit Fields1')];
  const dx = after[0].x - before[0].x;
  expect(dx).toBeGreaterThan(40);
  expect(Math.round(after[1].x - before[1].x)).toBe(Math.round(dx));
  expect(Math.round((await nodeBox(page, 'When clicking')).x)).toBe(Math.round(trigger.x));

  // one undo puts both back
  await page.keyboard.press('Control+z');
  expect(Math.round((await nodeBox(page, 'Edit Fields')).x)).toBe(Math.round(before[0].x));
  await page.keyboard.press('Control+y');

  // save, reload: the group comes back expanded (this browser remembers it)
  await page.keyboard.press('Control+s');
  await expect(page).toHaveURL(/\/workflow\/[0-9a-f-]{8,}/);
  await page.reload();
  await expect(page.locator('.react-flow__node-nodeGroup', { hasText: 'Prepare' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse group Prepare' })).toBeVisible();

  // collapse into one card that takes the cables, then expand again
  await page.getByRole('button', { name: 'Collapse group Prepare' }).click();
  const card = page.locator('.react-flow__node-nodeGroup', { hasText: 'Prepare' });
  await expect(card).toContainText('2 nodes');
  await expect(page.locator('.react-flow__node-workflowNode', { hasText: 'Edit Fields1' })).toHaveCSS(
    'opacity',
    '0',
  );
  await page.getByRole('button', { name: 'Expand group Prepare' }).click();
  await expect(page.locator('.react-flow__node-workflowNode', { hasText: 'Edit Fields1' })).toHaveCSS(
    'opacity',
    '1',
  );
});
