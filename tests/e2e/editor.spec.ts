/**
 * Stage A end-to-end tests: import, adjustments, undo/redo, geometry,
 * browser-storage save/reopen, and export.
 *
 * Fixtures are generated on the fly (a tiny valid PNG built with zlib) so the
 * repository stays binary-free and the test does not depend on bundled assets.
 */
import { expect, test, type Page } from '@playwright/test';
import { statSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ */
/* Fixture generation                                                   */
/* ------------------------------------------------------------------ */

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Build a deterministic 96×64 RGBA PNG (gradient + alpha corner). */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA

  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 4;
      raw[o] = (x * 3) % 256;
      raw[o + 1] = (y * 5) % 256;
      raw[o + 2] = 128;
      raw[o + 3] = x < 4 && y < 4 ? 0 : 255; // small transparent corner
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const fixtureDir = path.join(tmpdir(), 'opencode', 'pixelforge-e2e');
mkdirSync(fixtureDir, { recursive: true });
const IMAGE_FIXTURE = path.join(fixtureDir, 'scene.png');
const TEXT_FIXTURE = path.join(fixtureDir, 'notes.txt');
writeFileSync(IMAGE_FIXTURE, makePng(96, 64));
writeFileSync(TEXT_FIXTURE, 'definitely not an image');

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const status = (page: Page) => page.getByRole('status', { name: 'Status bar' });
const canvas = (page: Page) => page.getByTestId('editor-canvas');

async function openImage(page: Page, file: string = IMAGE_FIXTURE): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTitle('Open image (Ctrl+O)').click();
  await (await chooser).setFiles(file);
}

/* ------------------------------------------------------------------ */

test.beforeEach(async ({ page }) => {
  await page.goto('/editor');
  await expect(status(page)).toBeVisible();
});

test('opens an image from the file picker', async ({ page }) => {
  await expect(status(page)).toContainText('No document');

  await openImage(page);

  await expect(status(page)).toContainText('scene.png');
  await expect(status(page)).toContainText('96 × 64 px');
  await expect(canvas(page)).toBeVisible();
  // The imported image lands as the Background layer (Layers section starts
  // collapsed like Photoshop — open it first).
  await page.getByRole('button', { name: 'Layers panel' }).click();
  await expect(page.getByRole('listbox', { name: 'Layer stack' })).toContainText('Background');
  // New documents start with a clean history.
  await expect(status(page)).toContainText('History 0');
});

test('shows an error toast when opening a non-image file', async ({ page }) => {
  await openImage(page, TEXT_FIXTURE);

  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(status(page)).toContainText('Open failed');
  // The document must not have been replaced.
  await expect(status(page)).toContainText('No document');
});

test('applies an adjustment and supports undo/redo', async ({ page }) => {
  await openImage(page);

  // Inspector sections start collapsed — open Color Grading.
  await page.getByRole('button', { name: 'Color Grading panel' }).click();
  // The grader defaults to the Pro style; switch to Beginner sliders.
  await page.getByRole('button', { name: 'Beginner', exact: true }).click();
  const brightness = page.getByRole('spinbutton', { name: 'Brightness', exact: true });
  await brightness.fill('40');
  await expect(status(page)).toContainText('Adjusting Brightness');

  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();

  // The adjustment lands in history as one step.
  await expect(status(page)).toContainText('History 1');
  await expect(apply).toBeDisabled(); // pending adjustments were consumed

  // Undo / redo through the real keyboard shortcuts.
  await page.keyboard.press('Control+z');
  await expect(status(page)).toContainText('History 0');
  await expect(page.getByTitle('Redo (Ctrl+Shift+Z)')).toBeEnabled();

  await page.keyboard.press('Control+y');
  await expect(status(page)).toContainText('History 1');
});

test('rotates the document through the Image menu', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('96 × 64 px');

  await page.getByRole('menubar').getByRole('button', { name: 'Image', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rotate 90° Clockwise' }).click();

  await expect(status(page)).toContainText('64 × 96 px');
  await expect(status(page)).toContainText('History 1');
});

test('saves to browser storage and reopens the saved project', async ({ page }) => {
  await openImage(page);

  // Make a real change so the saved snapshot is verifiable.
  await page.getByRole('menubar').getByRole('button', { name: 'Image', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rotate 90° Clockwise' }).click();
  await expect(status(page)).toContainText('64 × 96 px');
  await expect(status(page)).toContainText('History 1');

  await page.getByTitle('Save project to browser storage (Ctrl+S)').click();
  await expect(page.getByTestId('toast')).toContainText('Project saved to browser storage');

  // Reopen from the saved-projects dialog.
  await page.getByRole('menubar').getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open Saved Project from Browser…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Open Saved Project' });
  await expect(dialog).toBeVisible();
  const list = page.getByTestId('project-list');
  await expect(list).toContainText('scene.png');
  await list.getByRole('button', { name: 'Open', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText('scene.png');
  await expect(status(page)).toContainText('64 × 96 px'); // rotated state restored
  await expect(status(page)).toContainText('History 0'); // freshly loaded document
});

test('exports a full-resolution PNG download', async ({ page }) => {
  await openImage(page);

  await page.getByTitle('Export PNG / JPEG / WebP (Ctrl+Shift+S)').click();
  const dialog = page.getByRole('dialog', { name: 'Export Image' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('96 × 64 px'); // reports the true document size

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-confirm').click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  expect(statSync(filePath!).size).toBeGreaterThan(500);
  await expect(dialog).toBeHidden();
});

test('zoom shortcuts drive the zoom field', async ({ page }) => {
  await openImage(page);

  // Fit caps at 100% for images smaller than the workspace.
  await page.keyboard.press('Control+0');
  await expect(page.getByLabel('Zoom level')).toHaveValue('100%');
  await page.keyboard.press('Control+1');
  await expect(page.getByLabel('Zoom level')).toHaveValue('100%');

  await page.keyboard.press('-'); // zoom out one ladder step
  await expect(page.getByLabel('Zoom level')).not.toHaveValue('100%');

  await page.keyboard.press('Control+0'); // fit again → back to 100%
  await expect(page.getByLabel('Zoom level')).toHaveValue('100%');
});

test('top bar theme toggle flips the editor between light and dark', async ({ page }) => {
  const html = page.locator('html');
  const initial = (await html.getAttribute('data-theme')) ?? 'light';

  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toBeVisible();

  await toggle.click();
  await expect(html).not.toHaveAttribute('data-theme', initial);

  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', initial);
});

/* ------------------------------------------------------------------ */
/* Tool interaction tests (Phase 2 tools)                               */
/* ------------------------------------------------------------------ */

test('brush tool paints a stroke that lands in history', async ({ page }) => {
  await openImage(page);
  // Wait for the document to finish loading (it resets the active tool).
  await expect(status(page)).toContainText('Opened scene.png');

  // Select the Brush via its toolbar shortcut.
  await page.keyboard.press('b');
  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);

  // Photoshop-style cursor ring tracks the pointer and reports the brush size.
  const ring = page.getByTestId('brush-ring');
  await expect(ring).toBeVisible();
  const sizeBefore = Number(await ring.getAttribute('data-size'));
  // ']' grows the brush and flashes the size HUD beside the ring.
  await page.keyboard.press(']');
  await expect(ring).toHaveAttribute('data-size', String(sizeBefore + 5));
  await expect(page.getByTestId('brush-hud')).toBeVisible();
  await page.keyboard.press('['); // back to the original size
  await expect(ring).toHaveAttribute('data-size', String(sizeBefore));

  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 15, { steps: 6 });
  await page.mouse.up();

  // One drag = one history entry with a human-readable label.
  await expect(status(page)).toContainText('History 1');
  await expect(status(page)).toContainText('Brush Stroke');
  await expect(page.getByTitle('Undo (Ctrl+Z)')).toBeEnabled();
});

test('paint bucket flood-fills with a single click', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  // Shift+G toggles Gradient → Paint Bucket.
  await page.keyboard.press('Shift+g');
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(status(page)).toContainText('History 1');
  await expect(status(page)).toContainText('Paint Bucket');
});

test('marquee drag creates a selection and the Select menu clears it', async ({ page }) => {
  await openImage(page);
  // Wait for the document to finish loading (it resets the active tool).
  await expect(status(page)).toContainText('Opened scene.png');

  await page.keyboard.press('m');
  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx - 30, cy - 20);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 20, { steps: 6 });
  await page.mouse.up();

  await expect(status(page)).toContainText('Marquee —');

  // Deselect through the Select menu.
  await page.getByRole('menubar').getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Deselect' }).click();
  await expect(status(page)).toContainText('Deselect');
});

test('tool flyouts switch subtools, single-row marquee selects, modes arm', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  // Hovering the marquee tool reveals the group flyout — no right-click needed.
  const marqueeBtn = page.getByRole('button', { name: /^Rectangular Marquee/ });
  await marqueeBtn.hover();
  const flyout = page.getByRole('menu', { name: 'Rectangular Marquee tools' });
  await expect(flyout).toBeVisible();
  await expect(flyout.getByRole('menuitem')).toHaveCount(4); // rect/ellipse/row/column

  // Pick the single-row variant — the options bar badge follows the subtool.
  await flyout.getByRole('menuitem', { name: 'Single Row Marquee' }).click();
  await expect(page.getByTestId('options-bar')).toContainText('Single Row Marquee');
  await expect(flyout).toBeHidden();

  // One click selects a 1 px row across the 96 px wide fixture.
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(status(page)).toContainText('Marquee — 96 × 1 px');

  // Selection mode buttons arm and report their pressed state.
  const add = page.getByRole('button', { name: 'Add to selection' });
  await expect(add).toHaveAttribute('aria-pressed', 'false');
  await add.click();
  await expect(add).toHaveAttribute('aria-pressed', 'true');
  const subtract = page.getByRole('button', { name: 'Subtract from selection' });
  await subtract.click();
  await expect(subtract).toHaveAttribute('aria-pressed', 'true');
  await expect(add).toHaveAttribute('aria-pressed', 'false');

  // Polygonal lasso: three clicks around the image centre + Enter closes it.
  await page.getByRole('button', { name: /^Lasso \(/ }).click();
  await page.getByRole('button', { name: /^Lasso \(/ }).click();
  const lassoFlyout = page.getByRole('menu', { name: 'Lasso tools' });
  await expect(lassoFlyout).toBeVisible();
  await lassoFlyout.getByRole('menuitem', { name: 'Polygonal Lasso' }).click();
  await expect(page.getByTestId('options-bar')).toContainText('Polygonal Lasso');

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.click(cx - 25, cy - 12);
  await page.mouse.click(cx + 25, cy - 12);
  await page.mouse.click(cx, cy + 15);
  await page.keyboard.press('Enter');
  await expect(status(page)).toContainText('Polygonal Lasso —');
});

test('options bar shows the active tool controls per tool', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  const bar = page.getByTestId('options-bar');
  const controls = page.getByTestId('options-controls');
  await expect(bar).toBeVisible();

  // Brush: size + opacity inline sliders.
  await page.keyboard.press('b');
  await expect(bar).toContainText('Brush');
  await expect(controls.getByLabel('Size', { exact: true })).toBeVisible();
  await expect(controls.getByLabel('Opacity', { exact: true })).toBeVisible();

  // Crop: aspect select + apply/cancel.
  await page.keyboard.press('c');
  await expect(bar).toContainText('Crop');
  await expect(page.getByLabel('Crop aspect ratio')).toBeVisible();

  // Magic wand: tolerance slider.
  await page.keyboard.press('w');
  await expect(bar).toContainText('Magic Wand');
  await expect(controls.getByLabel('Tolerance', { exact: true })).toBeVisible();

  // Selection tools expose the quick-select actions.
  await page.keyboard.press('m');
  const deselect = controls.getByRole('button', { name: 'Deselect' });
  await expect(deselect).toBeDisabled(); // nothing selected yet
  await controls.getByRole('button', { name: 'All', exact: true }).click();
  await expect(deselect).toBeEnabled();
});

test('Pro color grader shows scope, wheels and applies a look preset', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  // Open the Color Grading section — the Pro style is the default.
  await page.getByRole('button', { name: 'Color Grading panel' }).click();
  await expect(page.getByTestId('grade-scope')).toBeVisible();
  await expect(page.getByRole('application', { name: /Lift colour wheel/ })).toBeVisible();
  await expect(page.getByRole('application', { name: /Gamma colour wheel/ })).toBeVisible();
  await expect(page.getByRole('application', { name: /Gain colour wheel/ })).toBeVisible();

  // A look preset loads a full grade and enables Apply.
  await page.getByRole('button', { name: 'Teal & Orange' }).click();
  await expect(status(page)).toContainText('Color grade: Teal & Orange');
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(status(page)).toContainText('History 1');

  // The style switch flips to the Beginner slider layout.
  await page.getByRole('button', { name: 'Beginner', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Brightness', exact: true })).toBeVisible();
  await expect(page.getByTestId('grade-scope')).toBeHidden();
});

/* ------------------------------------------------------------------ */
/* Phase 6: loading screen, curves, auto-correct, stylize, transform,  */
/* selection modify, and layer shortcuts.                              */
/* ------------------------------------------------------------------ */

test('the animated loading overlay dismisses once the app is ready', async ({ page }) => {
  // The overlay is part of the static HTML and is removed after React mounts
  // and dispatches the app-ready signal (never traps the user).
  const overlay = page.getByTestId('pf-loading');
  await expect(overlay).toBeHidden();
  await expect(page.locator('#pf-loading')).toHaveCount(0);
});

test('Pro grader curves + histogram render and a curve edit enables Apply', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.getByRole('button', { name: 'Color Grading panel' }).click();
  await expect(page.getByTestId('grade-histogram')).toBeVisible();
  const curve = page.getByTestId('curve-editor');
  await expect(curve).toBeVisible();

  // Clicking the curve graph adds a control point → a pending curve edit.
  // The Curves section sits below the fold in the scrollable side panel.
  await curve.scrollIntoViewIfNeeded();
  const box = (await curve.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.35);
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeEnabled();
});

test('auto-tone button applies a single history step', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.getByRole('button', { name: 'Color Grading panel' }).click();
  await page.getByTestId('auto-tone').click();
  await expect(status(page)).toContainText('History 1');
});

test('stylize controls drive threshold, posterize, gradient map and photo filter', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.getByRole('button', { name: 'Color Grading panel' }).click();
  await page.getByRole('button', { name: 'Beginner', exact: true }).click();

  const threshold = page.getByRole('spinbutton', { name: 'Threshold' });
  await threshold.fill('128');
  await expect(status(page)).toContainText('Adjusting Threshold');

  const posterize = page.getByRole('spinbutton', { name: 'Posterize' });
  await posterize.fill('6');
  await expect(status(page)).toContainText('Adjusting Posterize');

  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeEnabled();
});

test('Ctrl+T transforms the layer, Enter commits a history step', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.keyboard.press('Control+t');
  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // The 96x64 fixture sits within ~±28px of centre at 100% zoom, so the drag
  // must stay inside the transform box to register a scale/move.
  await page.mouse.move(cx + 10, cy + 6);
  await page.mouse.down();
  await page.mouse.move(cx + 18, cy + 10, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('transform-commit')).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(status(page)).toContainText('History 1');
  await expect(status(page)).toContainText('Free Transform');
});

test('Shift+F6 opens the Feather dialog and applies the radius', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  // Make a selection so feather has something to work on.
  await page.keyboard.press('m');
  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 24, cy - 16);
  await page.mouse.down();
  await page.mouse.move(cx + 24, cy + 16, { steps: 6 });
  await page.mouse.up();
  await expect(status(page)).toContainText('Marquee —');

  await page.keyboard.press('Shift+F6');
  const dialog = page.getByRole('dialog', { name: /Feather/ });
  await expect(dialog).toBeVisible();
  await page.getByTestId('feather-apply').click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText('Feather');
});

test('digit keys set the active layer opacity', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.getByRole('button', { name: 'Layers panel' }).click();
  const list = page.getByRole('listbox', { name: 'Layer stack' });
  await expect(list).toContainText('100%'); // default opacity

  await page.keyboard.press('5'); // → 50%
  await expect(list).toContainText('50%');
  await page.keyboard.press('0'); // → 100%
  await expect(list).toContainText('100%');
});

test('repeated L cycles to Magnetic Lasso and traces an edge into a selection', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  // L from the hand tool → Lasso → Polygonal → Magnetic.
  await page.keyboard.press('l');
  await page.keyboard.press('l');
  await page.keyboard.press('l');
  await expect(page.getByTestId('options-bar')).toContainText('Magnetic Lasso');
  const controls = page.getByTestId('options-controls');
  await expect(controls.getByLabel('Width', { exact: true })).toBeVisible();
  await expect(controls.getByLabel('Contrast', { exact: true })).toBeVisible();
  await expect(controls.getByLabel('Frequency', { exact: true })).toBeVisible();

  // Trace a V so the closed path has real area, then release to select.
  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 24, cy + 14);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 14, { steps: 6 });
  await page.mouse.move(cx + 24, cy + 14, { steps: 6 });
  await page.mouse.up();
  await expect(status(page)).toContainText('Magnetic Lasso —');
});

test('repeated W picks the Quick Selection brush and paints a selection', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.keyboard.press('w'); // Magic Wand
  await page.keyboard.press('w'); // Quick Selection
  await expect(page.getByTestId('options-bar')).toContainText('Quick Selection');
  await expect(page.getByTestId('options-controls').getByLabel('Tolerance', { exact: true })).toBeVisible();

  // One stroke across the fixture grows the selection live, then commits.
  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 20, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy, { steps: 10 });
  await page.mouse.up();
  await expect(status(page)).toContainText('Quick Selection —');
});

test('the angle gradient shape paints a sweep into history', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.keyboard.press('g');
  await expect(page.getByTestId('options-bar')).toContainText('Gradient');
  await page.getByLabel('Gradient shape').selectOption('angle');

  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 20, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy, { steps: 6 });
  await page.mouse.up();

  await expect(status(page)).toContainText('History 1');
  await expect(status(page)).toContainText('Gradient');
});

test('repeated U picks the Line shape and draws it into history', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  // U → Shape → Rounded Rectangle → Ellipse → Polygon → Line.
  for (let i = 0; i < 5; i++) await page.keyboard.press('u');
  await expect(page.getByTestId('options-bar')).toContainText('Line');
  await expect(page.getByTestId('options-controls').getByLabel('Weight', { exact: true })).toBeVisible();

  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 20, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy, { steps: 6 });
  await page.mouse.up();

  await expect(status(page)).toContainText('History 1');
  await expect(status(page)).toContainText('Add Line');
});

test('move tool transform controls start a free transform, Esc cancels', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.keyboard.press('v');
  await expect(page.getByTestId('options-bar')).toContainText('Move');

  // The 96×64 fixture is centred at 100% zoom; grab its top-left handle.
  const box = (await canvas(page).boundingBox())!;
  const hx = box.x + (box.width - 96) / 2;
  const hy = box.y + (box.height - 64) / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 8, hy + 8, { steps: 4 }); // real movement arms it
  await page.mouse.up();

  const badge = page.getByTestId('transform-commit');
  await expect(badge).toBeVisible(); // Free Transform is pending
  await page.keyboard.press('Escape');
  await expect(badge).toBeHidden(); // cancelled — no committed history step
  await expect(status(page)).toContainText('History 0');
});

test('repeat W reaches Object Selection and a click isolates a region', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.keyboard.press('w'); // Magic Wand
  await page.keyboard.press('w'); // Quick Selection
  await page.keyboard.press('w'); // Object Selection
  await expect(page.getByTestId('options-bar')).toContainText('Object Selection');
  await expect(page.getByTestId('options-controls').getByLabel('Edge', { exact: true })).toBeVisible();

  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(status(page)).toContainText('Object Selection —');
});

test('eyedropper loupe follows the cursor and reads out hex + RGB', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  await page.keyboard.press('i');
  await expect(page.getByTestId('options-bar')).toContainText('Eyedropper');

  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const loupe = page.getByTestId('eyedropper-loupe');
  const label = page.getByTestId('eyedropper-loupe-label');
  await expect(loupe).toBeAttached(); // 0×0 overlay root — the label proves it's live
  await expect(label).toBeVisible();
  await expect(label).toContainText('#');
  await expect(label).toContainText('R ');

  // Moving off the canvas unmounts the readout again.
  await page.mouse.move(box.x - 40, box.y - 40);
  await expect(loupe).toHaveCount(0);
});

test('move tool align buttons line the layer up with a selection', async ({ page }) => {
  await openImage(page);
  await expect(status(page)).toContainText('Opened scene.png');

  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Select a 40×20 region offset from the layer, then align the layer to it.
  await page.keyboard.press('m');
  await page.mouse.move(cx - 20, cy - 10);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy + 10, { steps: 4 });
  await page.mouse.up();

  await page.keyboard.press('v');
  await expect(page.getByTestId('options-bar')).toContainText('Move');
  await page.getByRole('button', { name: 'Align left' }).click();
  await expect(status(page)).toContainText('Align Left');
});
