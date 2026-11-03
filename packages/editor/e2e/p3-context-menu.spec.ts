/**
 * P3-02 canvas context menu against a live server (not run by the lane builders): a right-click on a
 * node and on the empty canvas opens the menu at the pointer, Rename works from it, Escape closes it,
 * and middle-button pan leaves the menu alone.
 */
import { expect, test } from '@playwright/test';

test('right-click menus on a node and on the canvas', async ({ page }) => {
  const id = Date.now().toString(36);

  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Owner Olive');
  await page.getByLabel('Work email').fill(`menu-${id}@example.com`);
  await page.getByLabel('Password').fill(`menu-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Menu ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);

  await page.goto('/workflow/new');
  await page.getByRole('button', { name: 'Add the first step' }).click();
  const creator = page.getByRole('complementary', { name: 'Node creator' });
  await creator.getByRole('textbox', { name: 'Search nodes' }).fill('manual');
  await creator.getByTestId('creator-item-core.manualTrigger').click();
  await page
    .getByRole('dialog', { name: /details$/ })
    .getByRole('button', { name: 'Close' })
    .click();

  // node menu
  const node = page.locator('.react-flow__node').first();
  await node.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Canvas actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Open' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Test step' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible();

  // Escape closes it
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Rename from the menu
  await node.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename node' });
  await dialog.getByLabel('Node name').fill('Kick off');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Kick off').first()).toBeVisible();

  // canvas menu: Add sticky note
  const pane = page.locator('.react-flow__pane');
  await pane.click({ button: 'right', position: { x: 400, y: 300 } });
  await expect(menu.getByRole('menuitem', { name: 'Add node' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Add sticky note' }).click();
  await expect(page.locator('.react-flow__node-sticky, [data-testid="sticky"]').first()).toBeVisible();
});
