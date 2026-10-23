/**
 * Landing page: the entry point users see before opening the editor.
 * Verifies the marketing page renders in the DESIGN.md style and that its
 * primary CTA actually routes into the editor.
 */
import { expect, test } from '@playwright/test';

test('landing page renders and its CTA opens the editor', async ({ page }) => {
  await page.goto('/');

  // Editorial hero from DESIGN.md: serif display headline + coral CTA.
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('Photo editing that never leaves your device.');

  const cta = page.getByRole('link', { name: 'Open the editor' }).first();
  await expect(cta).toBeVisible();
  await cta.click();

  // Now inside the editor shell.
  await expect(page).toHaveURL(/\/editor\/?$/);
  const status = page.getByRole('status', { name: 'Status bar' });
  await expect(status).toBeVisible();
  await expect(status).toContainText('No document');

  // The editor brand links back home.
  await page.getByTestId('brand-home').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Photo editing that never leaves your device.',
  );
});

test('nav theme toggle switches to dark mode and persists', async ({ page }) => {
  await page.goto('/');

  const html = page.locator('html');
  const initial = (await html.getAttribute('data-theme')) ?? 'light';

  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toBeVisible();

  // Flip to the opposite theme (animated via the View Transitions API).
  await toggle.click();
  await expect(html).not.toHaveAttribute('data-theme', initial);
  const flipped = await html.getAttribute('data-theme');
  await expect(toggle).toHaveAttribute(
    'aria-label',
    flipped === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
  );

  // The choice survives a reload (localStorage).
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', flipped!);

  // Flip back so the toggle round-trips in both directions.
  await page.getByTestId('theme-toggle').click();
  await expect(html).toHaveAttribute('data-theme', initial);
});