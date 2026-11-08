/**
 * P5-67 the Assistant page in a real browser (written by lane L2, run once by the main session at the end of S5,
 * never by a lane). It runs on the demo build (`vite build --mode demo`, or the dev server with `--mode demo`),
 * where the demo backend answers every request and `demoAssistantStream` plays scripted events, so no model key
 * and no server are needed. It proves: a message streams into the thread (tool row, answer, title in the list),
 * the workflow artifact opens a read-only canvas, markup in a message stays text, Stop ends a turn and the thread
 * answers again, and a chat can be renamed and deleted.
 *
 * Run: E2E_BASE_URL=<demo URL> npx playwright test e2e/p5s5-assistant.spec.ts
 */
import { expect, type Page, test } from '@playwright/test';

async function openAssistant(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assistant' }).click();
  await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();
  await expect(page.getByText('Ask about your workflows, or ask me to build one')).toBeVisible();
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

const chat = (page: Page) => page.getByRole('log', { name: 'Assistant chat' });

test.describe('Assistant (P5-67)', () => {
  test('streams an answer with a tool row and opens the workflow artifact read only', async ({ page }) => {
    await openAssistant(page);
    await send(page, 'Show my workflows');
    await expect(chat(page).getByText('Show my workflows')).toBeVisible();
    await expect(chat(page).getByText(/You have \d+ workflows?\./)).toBeVisible({ timeout: 15_000 });
    const row = chat(page).locator('li[data-tool-call]').filter({ hasText: 'list workflows' });
    await expect(row).toHaveAttribute('data-state', 'done');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Chats' }).getByText('Show my workflows'),
    ).toBeVisible();

    const panel = page.getByRole('region', { name: 'Artifacts' });
    const open = panel.getByRole('button', { name: /^Open / }).first();
    await expect(open).toBeVisible();
    await open.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Read only/)).toBeVisible();
    await expect(dialog.locator('.react-flow')).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Open' })).toHaveAttribute('href', /\/workflow\//);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('keeps markup in a message as text', async ({ page }) => {
    let alerted = false;
    page.on('dialog', async (dialog) => {
      alerted = true;
      await dialog.dismiss();
    });
    await openAssistant(page);
    await send(page, '<img src=x onerror="alert(1)"> <b>bold</b>');
    await expect(chat(page).getByText('<img src=x onerror="alert(1)">', { exact: false })).toBeVisible();
    await expect(chat(page).getByText(/This is the demo Assistant/)).toBeVisible({ timeout: 15_000 });
    await expect(chat(page).locator('img')).toHaveCount(0);
    await expect(chat(page).locator('b')).toHaveCount(0);
    expect(alerted).toBe(false);
  });

  test('stops a turn, then answers again', async ({ page }) => {
    await openAssistant(page);
    await send(page, 'Tell me about the Assistant');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await send(page, 'Now answer in full');
    await expect(
      chat(page)
        .getByText(/This is the demo Assistant/)
        .last(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('renames and deletes a chat', async ({ page }) => {
    await openAssistant(page);
    await send(page, 'Chat to rename');
    await expect(chat(page).getByText(/This is the demo Assistant/)).toBeVisible({ timeout: 15_000 });
    const list = page.getByRole('navigation', { name: 'Chats' });
    await list.getByRole('button', { name: 'Rename Chat to rename' }).click();
    const field = list.getByRole('textbox', { name: 'Chat name' });
    await field.fill('Renamed in the browser');
    await field.press('Enter');
    await expect(list.getByText('Renamed in the browser')).toBeVisible();

    await list.getByRole('button', { name: 'Delete Renamed in the browser' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(list.getByText('Renamed in the browser')).toHaveCount(0);
    await expect(page.getByText('Ask about your workflows, or ask me to build one')).toBeVisible();
  });
});
