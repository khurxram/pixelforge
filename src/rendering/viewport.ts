/**
 * Viewport math: normalized document coordinates ↔ screen coordinates.
 * screen = doc * zoom + pan  (pan is the screen offset of the document origin)
 */
import type { Viewport } from '../core/document/types';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export interface Point {
  x: number;
  y: number;
}

export function docToScreen(p: Point, view: Viewport): Point {
  return { x: p.x * view.zoom + view.panX, y: p.y * view.zoom + view.panY };
}

export function screenToDoc(p: Point, view: Viewport): Point {
  return { x: (p.x - view.panX) / view.zoom, y: (p.y - view.panY) / view.zoom };
}

/** Center the document in the workspace at the largest zoom that fits. */
export function fitView(docW: number, docH: number, cw: number, ch: number, padding = 32): Viewport {
  const availW = Math.max(1, cw - padding * 2);
  const availH = Math.max(1, ch - padding * 2);
  const zoom = clampZoom(Math.min(availW / docW, availH / docH, 1));
  return {
    zoom,
    panX: (cw - docW * zoom) / 2,
    panY: (ch - docH * zoom) / 2,
  };
}

/** Zoom while keeping the document point under `anchor` (screen px) fixed. */
export function zoomAt(view: Viewport, nextZoom: number, anchor: Point): Viewport {
  const z = clampZoom(nextZoom);
  const docPt = screenToDoc(anchor, view);
  return {
    zoom: z,
    panX: anchor.x - docPt.x * z,
    panY: anchor.y - docPt.y * z,
  };
}

/** Zoom around the center of the workspace. */
export function zoomCentered(view: Viewport, nextZoom: number, cw: number, ch: number): Viewport {
  return zoomAt(view, nextZoom, { x: cw / 2, y: ch / 2 });
}

/** Common zoom steps (Photoshop-like percentage ladder). */
export const ZOOM_STEPS = [
  0.02, 0.03, 0.05, 0.0625, 0.083, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32,
];

/** Step zoom to the next percentage in the ladder, keeping `anchor` fixed. */
export function nextZoomStep(
  view: Viewport,
  direction: 1 | -1,
  anchor: Point,
): Viewport {
  const next =
    direction === 1
      ? (ZOOM_STEPS.find((s) => s > view.zoom + 1e-6) ?? MAX_ZOOM)
      : ([...ZOOM_STEPS].reverse().find((s) => s < view.zoom - 1e-6) ?? MIN_ZOOM);
  return zoomAt(view, next, anchor);
}
