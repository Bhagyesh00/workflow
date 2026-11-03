/**
 * P3-19 workflow reviews against a live server (not run by the lane builders): an admin turns
 * reviews on and Publish asks "Publish or Submit for review"; the submit dialog lists the other
 * members who can publish. The approve-and-publish path is covered against the demo backend in
 * test/workflow-reviews.test.tsx and by the server tests.
 */
import { expect, test } from '@playwright/test';

test('Publish asks for a review while reviews are on', async ({ page }) => {
  const id = Date.now().toString(36);
  const password = `review-pass-${id}1`;

  // 1. the owner creates the workspace and turns workflow reviews on
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Owner Olive');
  await page.getByLabel('Work email').fill(`owner-${id}@example.com`);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Workspace name').fill(`Reviews ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  await page.goto('/settings/security');
  await page.getByRole('switch', { name: 'Workflow reviews' }).click();
  await expect(page.getByRole('switch', { name: 'Workflow reviews' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // 2. the owner builds and saves a workflow with a manual trigger
  await page.goto('/workflow/new');
  await page.getByRole('button', { name: 'Add the first step' }).click();
  const creator = page.getByRole('complementary', { name: 'Node creator' });
  await creator.getByRole('textbox', { name: 'Search nodes' }).fill('manual');
  await creator.getByTestId('creator-item-core.manualTrigger').click();
  await page
    .getByRole('dialog', { name: /details$/ })
    .getByRole('button', { name: 'Close' })
    .click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/workflow\/(?!new)[^/]+$/);

  // 3. Publish asks Publish or Submit for review; a workspace with only the owner has no reviewer
  await page.getByRole('button', { name: 'Publish' }).first().click();
  const choice = page.getByRole('dialog', { name: 'Publish or ask for a review?' });
  await expect(choice).toBeVisible();
  await choice.getByRole('button', { name: 'Submit for review' }).click();
  const submit = page.getByRole('dialog', { name: 'Submit for review' });
  await expect(submit).toBeVisible();
  await expect(submit.getByText('No other member can publish this workflow.')).toBeVisible();
});
