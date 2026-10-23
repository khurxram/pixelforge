# PixelForge

A professional, **local-first photo editor that runs entirely in your browser**. No backend, no accounts, no uploads — every pixel is processed on your device with Canvas 2D, Web Workers, and IndexedDB.

> **Status: Phases 1–7 complete, plus a quality/feature pass.** The marketing site (features / privacy / tech pages, directional page transitions, theme toggle) and the full editor are implemented: marquee/lasso (incl. polygonal & magnetic)/wand/quick-selection/object selection, brush, pencil, color replacement, eraser (incl. magic & background), clone, healing/spot healing/patch/red-eye, paint bucket, five gradient shapes, blur, sharpen, smudge, dodge, burn, sponge, move (with alignment buttons), text, and shapes (rounded rect, ellipse, polygon, line) — all live, all undoable, all tested. The editor opens behind an **animated loading screen** with a real progress bar; the Pro grader has **Curves** and a live **histogram** plus **Auto Tone / Contrast / Color**; there's a **Free Transform** (`Ctrl+T`) and a full batch of professional keyboard shortcuts. A dedicated quality pass fixed the grading-preview sizing bug, made the magnetic lasso snap to real photo edges (per-channel, chroma-aware edge map), bounded the selection engines so painting a selection no longer lags on large images, and rebuilt the stroke machinery so slow strokes space their dabs correctly and uniform effects (blur/sharpen/dodge/burn/sponge) compute from a stroke-start snapshot instead of stacking to blow-out. The eyedropper now shows a **live loupe** (crosshair ring, fg/bg swatch, hex + RGB readout) under the cursor. Remaining gaps are listed under [Limitations](#limitations).

## Quick start

```sh
npm install
npm run dev
```

Open `http://localhost:4321` — you land on the editorial home page. Click **Open the editor** to reach the editor at `/editor`, then drag an image onto the canvas or use **Open** in the toolbar. The brand mark in the editor links back to the home page; the nav links to separate **Features**, **Privacy**, and **Tech** pages.

## Commands

| Command             | Action                                             |
| :------------------ | :------------------------------------------------- |
| `npm install`       | Install dependencies                               |
| `npm run dev`       | Start dev server at `localhost:4321`               |
| `npm run build`     | Production build to `./dist/`                      |
| `npm run preview`   | Preview the production build                       |
| `npm run check`     | TypeScript/Astro type checking                     |
| `npm test`          | Unit tests (Vitest)                                |
| `npm run test:watch`| Unit tests in watch mode                           |
| `npm run clean`     | Remove build output & tool caches (`dist/`, `.astro/`, `test-results/`, `.wrangler/`) |
| `npm run e2e`       | End-to-end tests (Playwright; builds + previews)   |
| `npm run preview:cf`| Build, then serve `dist/` with a local Pages sim   |
| `npm run deploy`    | Build, then upload `dist/` to Cloudflare Pages     |

## Deploying to Cloudflare

PixelForge is fully static — no SSR, no functions, no origin server — so the
deploy is just the contents of `dist/`.

```sh
npx wrangler login        # once
npm run deploy            # astro build && wrangler deploy
```

Wrangler 4 dropped `pages_build_output_dir`, so the site deploys as an
**asset-only Worker with Workers Static Assets** (the path Cloudflare steers
all new projects to). It is served from the edge at
`https://pixelforge.<your-subdomain>.workers.dev`, and `npm run preview:cf`
serves the same build locally on `:8787`. Add a custom domain from
*Workers & Pages → pixelforge → Settings → Domains & Routes*.

Configured for you:

- **`wrangler.toml`** — `[assets] directory = "./dist"` plus
  `not_found_handling = "404-page"` so unknown routes render `404.html`.
- **`public/_headers`** — `/_astro/*` (content-hashed) is served
  `max-age=31536000, immutable`; HTML keeps Cloudflare's default
  `max-age=0, must-revalidate` so a deploy is visible immediately. Also
  `nosniff`, a locked-down `frame-ancestors`/`X-Frame-Options`, a
  `Permissions-Policy` that disables camera/mic/geolocation, and a CSP that
  only allows `'self'` + the inline bootstraps (no third-party origins — the
  app never talks to one). Each header is declared in exactly one rule so
  Cloudflare never comma-joins conflicting values.
- **`src/pages/404.astro`** — rendered for unknown paths.
- **`public/robots.txt`** — indexes the marketing pages, keeps `/editor/` out.

CI alternative: run `npm run deploy` in a pipeline with Wrangler auth
(`CLOUDFLARE_API_TOKEN`), or any static host pointed at `dist/`.

## What works today

- **Import** — file picker or drag-and-drop (PNG, JPEG, WebP, GIF, AVIF, BMP) with size warnings for very large images.
- **Instant open** — `/editor` ships its chrome as a static first frame in the HTML (no blank flash), and the landing page warms the editor bundle on hover/focus/press. On top of that sits an **animated loading screen** with a progress bar that eases toward 90% while the React app hydrates, snaps to 100% on a real "app-ready" signal (not a fake timer), then animates away — motion-aware and skipped under `prefers-reduced-motion`.
- **Navigate** — zoom (wheel, shortcuts, zoom field), pan (Space-drag / Hand tool / right-drag), fit-to-screen, 100% view.
- **Selections** — rectangular / elliptical / single-row / single-column marquee, freehand & polygonal lasso, **magnetic lasso** (chroma-aware Sobel edge snapping with Width / Contrast / Frequency — it locks onto real photo edges, not just black↔white steps), magic wand (tolerance, contiguous, anti-alias, current layer or all layers), **Quick Selection** (paint-to-grow under the brush, tolerance-aware, bounded so a dab costs brush-area, not image-area), **Object Selection** (click inside an object — growth fills matching color but stops at strong edges; a local, convolution-only isolator, no ML), professional selection modes (new / add / subtract / intersect), select all / deselect / inverse, feather — marching-ants overlay, and every paint/fill/adjustment op honors the mask.
- **Paint tools** — brush, pencil (hard aliased edge) & color-replacement brush, eraser with **magic eraser** (one-click tolerance flood) and **background eraser** (samples the color under the brush; continuous or once), clone stamp & healing brush (Alt-click source; aligned or point sampling, all-layers option) plus **Spot Healing** (no source needed), **Patch** (drag a defect selection to a clean area), and **Red Eye** (thresholded pupil correction), paint bucket (contiguous or global flood fill, tolerance, opacity), linear / radial / angle / reflected / diamond gradient (reversible), blur, sharpen, **smudge**, dodge & burn with tonal ranges (shadows / midtones / highlights), and **sponge** (saturate / desaturate). One drag = one undo step; strokes re-render incrementally via dirty-rect uploads. A **brush-size cursor ring** follows the pointer over the canvas (system cursor hidden), `[` / `]` resize it live, and a short-lived HUD reports size / opacity / hardness while you adjust.
- **Move, text & shapes** — drag layers with snapping (Shift) or nudge with arrow keys (Shift = 10 px), optional **Auto-Select** (pick the layer under the click) and **Show Transform Controls** (interactive handles on the active layer), click to place text as a new layer (font, size, alignment), and drag rectangles / rounded rectangles / ellipses / regular polygons (3–12 sides) / lines with optional stroke width (clipped to the selection).
- **Free Transform** — `Ctrl+T` puts the active layer into a live transform: drag inside to move, drag the corner/edge handles to scale (Shift = keep aspect, Alt = from center), or drag outside the box to rotate (Shift = 15° snap). `Enter`/double-click commits (one undo step), `Esc` cancels; the options bar swaps to commit/cancel controls. The transform is committed through a premultiplied bilinear resample, so rotation and non-integer scaling stay sharp and halo-free.
- **Selection modify** — Feather (with an explicit radius via a dialog), Grow, Shrink, and Smooth operate on the active mask and are undoable; feather uses a multi-pass approximation of a Gaussian falloff rather than a hard box.
- **Toolbar flyouts** — grouped tools (marquee, lasso, wand/quick-select, brush, eraser, healing/patch/red-eye, gradient/bucket, blur/sharpen/smudge, dodge/burn/sponge, shape) open an animated flyout on **hover** (no right-click needed), and also on right-click, long-press, or a second click on the active tool; repeat-pressing a shared shortcut (`M`, `L`, `W`, `B`, `E`, `J`, `G`, `R`, `O`, `U`) cycles the family.
- **Geometry** — rotate 90° CW/CCW/180°, flip horizontal/vertical, crop (with aspect presets), resize image (resamples all layers).
- **Color grading** — a **Pro** grader (live RGB parade scope + **histogram**, **Curves** graph editor with per-channel tone curves, Lift/Gamma/Gain trackball wheels with neutral masters, primaries sliders, **Auto Tone / Auto Contrast / Auto Color** one-click corrections, stylization controls, and one-click "Looks" presets) and a **Beginner** slider grader — switchable from the panel header. Live low-resolution preview; **Apply** recomputes at full resolution in a Web Worker.
- **Stylization** — Threshold, Posterize, Gradient Map, and Photo Filter adjustments sit in the live pipeline alongside the tone/color controls, previewed live and applied as one undo step.
- **Tool options bar** — a horizontal strip under the top bar that always shows the active tool's controls (brush size/hardness/flow/smoothing, selection modes + feather, marquee style/ratio/fixed size, wand/quick-select/magic-eraser tolerance, object-select Edge barrier strength, wand & quick-select sample source, contiguous & opacity for fills/erasers, background-eraser sample mode, magnetic Width/Contrast/Frequency, sponge mode, gradient shape (5 kinds) + reverse, shape kind/radius/sides/stroke-weight, move Auto-Select, transform controls & six align buttons, zoom Fit/100%/200%, tone range, text font/align, eyedropper sample size, crop aspect + apply/cancel) with a per-tool hint.
- **Layers** — add, duplicate, delete, rename, reorder, hide, opacity, and 16 blend modes (W3C Compositing formulas), with thumbnails.
- **History** — 25-step undo/redo; the History panel can jump to any state.
- **Export** — PNG, JPEG (quality), WebP at full document resolution — never the screen preview.
- **Projects** — save/open/download the native binary `.pixelforge` format (validated, forward-migratable header), plus IndexedDB autosave with a one-click recovery prompt on reload.
- **Chrome** — professional inspector: every section collapsed on open, collapsible rail, and a drag-resizable width (double-click resets, persisted in `localStorage`).
- **Keyboard shortcuts** — see below (full list in **Help → Keyboard Shortcuts**).

## Keyboard shortcuts

| Shortcut | Action | Shortcut | Action |
| :--- | :--- | :--- | :--- |
| `Ctrl+O` | Open image | `Ctrl+S` | Save project to browser |
| `Ctrl+Shift+S` | Export image | `Ctrl+Shift+P` | Download `.pixelforge` |
| `Ctrl+Z` | Undo | `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Ctrl+0` | Fit to screen | `Ctrl+1` | Zoom 100% |
| `+` / `-` | Zoom in / out | `Enter` | Apply adjustment / crop |
| `Esc` | Cancel adjustment / crop / dialog / selection | `Space` (hold) | Pan |
| `V` Move · `M` Marquee · `L` Lasso · `W` Wand | Selection & transform | `B` Brush · `E` Eraser | Paint |
| `S` Clone · `J` Healing | Retouch (Alt-click sets source) | `G` Gradient · `Shift+G` Paint bucket | Fills |
| `R` Blur · `Y` Sharpen | Detail | `O` Dodge · `Shift+O` Burn | Exposure |
| `T` Text · `U` Shape | Place elements | `C` Crop · `I` Eyedropper | Capture |
| `H` Hand · `Z` Zoom | Navigate | `X` / `D` | Swap / default colors |
| `Ctrl+A` | Select all | `Ctrl+D` | Deselect |
| `Ctrl+Shift+I` | Inverse selection | `Delete` | Clear selection (or layer) |
| `Alt+Backspace` | Fill with foreground | `Ctrl+Backspace` | Fill with background |
| `Ctrl+I` | Invert colors | `Ctrl+Shift+N` | New layer |
| `Ctrl+T` | Free Transform | `Ctrl+J` | Layer via copy (no selection: duplicate) |
| `Ctrl+Shift+J` | Layer via cut | `Ctrl+E` | Merge layer down |
| `Alt+Ctrl+Z` | Step backward (history) | `Shift+F6` | Feather selection… |
| `1`–`9` / `0` | Set layer opacity (10–90% / 100%) | `Ctrl+=` / `Ctrl+-` | Zoom in / out |
| `Arrow` (Move tool) | Nudge 1 px (`Shift` = 10 px) | `Enter` / `Esc` (Polygonal lasso) | Close / cancel polygon |

`Ctrl` also accepts `⌘` on macOS. Shortcuts are suppressed while you type into fields. Pressing a grouped shortcut again cycles its family: `M` → rect / ellipse / row / column marquee, `L` → lasso / polygonal / magnetic, `W` → wand / quick selection / object selection, `B` → brush / pencil / color replacement, `E` → eraser / magic / background, `J` → healing / spot healing / patch / red eye, `G` → gradient / paint bucket, `R` → blur / sharpen / smudge, `O` → dodge / burn / sponge, `U` → shape / rounded rect / ellipse / polygon / line. `[` / `]` shrink / grow the brush cursor (`Shift` = 10× step).

## Architecture

```
src/
├── app/           # Store (useSyncExternalStore), actions, shortcuts, App shell
├── core/
│   ├── document/  # Types, pure document ops, selection model (masks, wand, lasso)
│   └── history/   # Snapshot-based undo/redo (entries share immutable buffers)
├── imaging/       # Pure pixel math: adjustments, filters, resampling, paint engine
│                  #   (brush/fill/retouch ops), geometry, compositing, import/export
├── persistence/   # .pixelforge serializer/parser (+ migrations), IndexedDB
├── rendering/     # Viewport math + scene renderer (checkerboard, selection ants,
│                  #   tool drafts, dirty-rect stroke uploads)
├── workers/       # Adjustment Web Worker (+ sync fallback)
├── components/    # UI (CSS Modules): TopBar, Toolbar, Canvas, inspector, dialogs
├── pages/         # Astro routes: `/` landing, `/features` `/privacy` `/tech`, `/editor`
└── styles/        # Design tokens (DESIGN.md: warm cream + coral, theme-aware stage)
```

Design rules the code follows:

- **UI never contains processing math.** All imaging code is pure and DOM-free, so it runs identically in the app, in a worker, and in Node unit tests.
- **The document is immutable.** Operations return new documents; history entries share pixel buffers, making undo/redo a pointer swap.
- **Compositing follows the W3C Compositing spec**; exports always recomposite at full resolution.
- **Honest UI.** Tools/features not yet implemented are visibly disabled with an explanation instead of pretending to work.

## Design

The UI follows `DESIGN.md` — a warm editorial system: cream canvas (`#faf9f5`), warm ink text (`#141413`), hairline borders, and the signature coral accent (`#cc785c`) for primary actions and active states. The image stage is theme-aware — dark (`#181715`) in dark mode, warm paper (`#e3dcd0`) in light mode — and the renderer reads the live `--bg-canvas` token so the painted stage always matches the CSS around it. Serif display type is reserved for the landing page headlines.

**Dark mode.** Both routes ship a full dark theme built from DESIGN.md's dark surfaces (`#181715` / `#1f1e1b` / `#252320`), switched with `data-theme="dark"` on `<html>`. The theme switch is a sliding sun/moon toggle (landing nav + editor top bar); the choice persists in `localStorage` and falls back to the OS preference, applied before first paint so there is no flash.

**Motion.** Theme changes wipe across the screen as a coral circle expanding from the toggle button (View Transitions API, with a CSS-transition fallback). Page navigation is directional with a motion-blur ramp: entering `/editor` drops the landing page away (smearing as it accelerates) while the editor slides in from the top and sharpens as it settles; returning home reverses the move. The editor's chrome ships as a static first frame, and the landing CTA warms the editor's HTML/JS/CSS into the HTTP cache on hover, keyboard focus, or press, plus an idle pass pre-warms it shortly after first paint — so the **loading overlay** (a real progress bar that eases toward 90% during hydration and snaps away on the app-ready signal) is usually visible for only a frame or two. The landing page animates on load (staggered hero), reveals sections on scroll (IntersectionObserver, progressive — visible without JS), and lifts cards/buttons on hover. Editor chrome sits still on entry (no busy slide-ins) so the tool UI appears instantly; micro-motion inside the editor (toolbar flyouts, options-bar swaps, panel expands, slider thumbs, wheel trackballs) is subtle and snaps off under `prefers-reduced-motion`.

## Privacy

Everything is local: no network requests, no analytics, no external APIs or CDN assets. Saved projects and autosaves live in your browser's IndexedDB and can be wiped from **File → Storage & Privacy**.

## Testing

- **Unit** (`npm test`) — 259 Vitest tests covering adjustment math (the lift/gamma/gain grading wheels, tone curves, threshold/posterize/gradient-map/photo-filter stylization, and the auto tone/contrast/color corrections), affine geometry + the premultiplied-bilinear transform resampler, resampling, filters, compositing/blend modes, the selection model (rect/lasso/wand/invert/feather/outline + combine modes + grow/shrink/smooth + quick-select expansion and selection offsets, with a perceptual wand metric, brush-bounded dab flooding with a reused scratch buffer, and the object-select edge barrier), the paint engine (brush, pencil, color replacement, erase incl. magic/background flood erase, clone/heal, spot heal, patch, red eye, smudge, sponge, flood fill, all five gradient shapes, shape rasterizers, dodge/burn from stroke-start snapshots, fills, invert, gates, plus cross-event stroke spacing), edge detection for the magnetic lasso (per-channel Sobel, chroma-aware), document ops, history, the `.pixelforge` round-trip + corruption cases, IndexedDB persistence (fake-indexeddb), and shortcut dispatch.
- **E2E** (`npm run e2e`) — 31 Playwright flows: landing page + “Open the editor” routing, nav & top bar theme toggles (light/dark + persistence), open image, invalid-file error, apply adjustment + undo/redo, rotate via menu, save/reopen from browser storage, PNG export download, zoom shortcuts, brush stroke → history (with cursor-ring visibility + `[` / `]` sizing), marquee selection → Select menu, paint bucket fill, the tool options bar switching per tool, hover-open tool flyouts switching subtools + selection modes + polygonal lasso, the Pro/Beginner color grader (scope + wheels + look preset → Apply, style switch), the loading overlay dismissing on app-ready, curves + histogram rendering, auto-tone → history, stylization controls, Free Transform (`Ctrl+T` → drag → Enter → history), the Feather dialog, digit-key layer opacity, plus the Phase 7 flows: magnetic-lasso cycle → traced selection, quick-selection painting, the angle gradient → history, the line shape → history, and Move-tool transform controls → free transform → Esc; and the quality-pass flows: object-selection cycling → click isolation → status, the eyedropper loupe (attach → hex/RGB readout → unmount on leave), and move-tool align-to-selection.

## Phase 6 highlights

- **Animated loading screen** — the editor opens behind an overlay with a real progress bar that eases toward 90% during hydration, completes on an app-ready signal, and animates out (reduced-motion aware). No blank flash, no fake spinner.
- **Curves + histogram** — the Pro grader gains a draggable per-channel tone-curve editor and a live RGB/luma histogram, wired into the full-resolution pipeline.
- **Auto corrections** — *Auto Tone / Auto Contrast / Auto Color* run as direct, undoable layer actions using clipped histograms, gated by the active selection.
- **Stylization** — Threshold, Posterize, Gradient Map, and Photo Filter adjustments join the live pipeline.
- **Free Transform** (`Ctrl+T`) — move, scale (with aspect/from-center modifiers), and rotate the active layer with live handles; committed via a premultiplied-bilinear resample that stays sharp and halo-free.
- **Professional shortcuts** — a large batch of new bindings (`Ctrl+T`/`J`/`Shift+J`/`E`, `Alt+Ctrl+Z`, `Shift+F6`, `Ctrl+=`/`-`, digit-key opacity) plus a feather dialog and Grow/Shrink/Smooth selection commands.
- **Tool accuracy pass** — the magic wand now uses a perceptual color distance (instead of a naive per-channel one) and feathering approximates a Gaussian falloff, so masks and cut-outs are meaningfully cleaner.

## Phase 7 highlights

- **Selection family completes** — **Magnetic Lasso** (Sobel edge map with Width / Contrast / Frequency controls) and **Quick Selection** (brush-bounded perceptual floods unioned live under the active selection mode) join the flyout, both covered by engine + pointer tests.
- **Retouch family completes** — **Spot Healing** (ring-projection repair), **Patch** (drag a defect selection to clean area, mean-brightness matched), and **Red Eye** (thresholded pupil neutralization) join the healing flyout.
- **Brush family grows** — hard-edged **Pencil** and a **Color Replacement** brush (recolors only pixels near the sampled color, preserving luminosity).
- **Eraser family grows** — **Magic Eraser** (one-click tolerance flood with opacity) and **Background Eraser** (continuous / once color sampling with a tolerance-gated contiguous or global erase).
- **Retouch extras** — **Smudge** (drag pixels along the stroke) and **Sponge** (saturate / desaturate) with strength controls.
- **Shapes & gradients** — rounded rectangle, regular polygon (3–12 sides), and line shapes; angle / reflected / diamond gradient shapes round out the linear and radial ones.
- **Move tool parity** — **Auto-Select** picks the layer under the click and **Show Transform Controls** draws interactive handles that arm a real Free Transform only after the pointer actually moves (a stray click on an edge never traps the pointer).

## Limitations (honest list)

- **Filter menu** — *Levels*, *Gaussian Blur*, *Unsharp Mask*, and *Vignette* are still disabled. Curves and the blur/sharpen/level-style corrections they imply live in the Color Grading panel, so the menu items are stubs that point there rather than fake entries that do nothing.
- **Merge & flatten** — *Layer → Merge Down* works (bakes the active layer into the one below as a single undo step); a full *Flatten Image* and per-layer raster effects aren't wired to the menu yet.
- **Object selection is heuristic, not learned** — *Object Selection* grows a click into a region bounded by color distance and strong image edges (a local, convolution-only isolator), so it performs best where boundaries have real contrast. There is no ML *Select Subject*-style segmentation — that would require a model (or cloud API) this project deliberately doesn't ship. The magic wand uses a perceptual color metric, the magnetic lasso snaps to real photo edges, and the selection tools (feather/grow/shrink/smooth) are tuned for production masking quality.
- **No generative or heavy content-aware fill** — generative fill, high-quality content-aware fill, and *Remove Background* would need local ML models or cloud APIs; honest stand-ins exist instead (Patch tool, spot healing, background eraser), but nothing pretends to synthesize pixels.
- No pen paths / vector curves, no artboards, no slices, no Liquify, no text-on-path / typography dialog, no adjustment layers, no smart objects, and no PSD interop.
- Undo history is capped at 25 steps and is not persisted in project files.

## Stack

React 19 · TypeScript (strict) · Vite via Astro · Canvas 2D · Web Workers · IndexedDB · CSS Modules · Lucide icons · Vitest · Playwright
