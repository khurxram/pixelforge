/**
 * Export: full-document-resolution compositing to PNG/JPEG/WebP blobs.
 * Never touches the screen preview — always recomposites at document size.
 */
import type { EditorDocument, PixelBuffer } from '../core/document/types';
import { compositeDocument } from './composite';

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export const EXPORT_MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const MAX_EXPORT_DIMENSION = 16_384;
/** Practical browser canvas budget (~268 MP, Chrome's canvas area limit). */
export const MAX_EXPORT_PIXELS = 268_000_000;

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface ExportOptions {
  format: ExportFormat;
  /** 0..1, ignored for PNG. */
  quality?: number;
  /** Color used to flatten transparency (JPEG has no alpha channel). */
  background?: string | null;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  if (width > MAX_EXPORT_DIMENSION || height > MAX_EXPORT_DIMENSION) {
    throw new ExportError(
      `Export failed: ${width}×${height} exceeds the browser canvas limit of ${MAX_EXPORT_DIMENSION}px per side.`,
    );
  }
  if (width * height > MAX_EXPORT_PIXELS) {
    throw new ExportError('Export failed: the document exceeds the browser canvas memory budget.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function hexToRgb01(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Composite the document (optionally flattening onto a background color). */
export function renderForExport(doc: EditorDocument, opts: ExportOptions): PixelBuffer {
  const bg = opts.background ? hexToRgb01(opts.background) : null;
  if (!bg) return compositeDocument(doc);
  const data = new Uint8ClampedArray(doc.width * doc.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bg[0] * 255;
    data[i + 1] = bg[1] * 255;
    data[i + 2] = bg[2] * 255;
    data[i + 3] = 255;
  }
  return compositeDocument(doc, { background: { width: doc.width, height: doc.height, data } });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new ExportError(`The browser could not encode ${mime}. Try a smaller document.`));
      },
      mime,
      quality,
    );
  });
}

/** Export the document at full resolution. */
export async function exportDocument(doc: EditorDocument, opts: ExportOptions): Promise<Blob> {
  const buffer = renderForExport(doc, opts);
  const canvas = makeCanvas(buffer.width, buffer.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ExportError('Canvas 2D is unavailable in this browser.');
  ctx.putImageData(new ImageData(buffer.data, buffer.width, buffer.height), 0, 0);
  const quality = opts.format === 'png' ? undefined : opts.quality ?? 0.92;
  return canvasToBlob(canvas, EXPORT_MIME[opts.format], quality);
}

/** Trigger a browser download for a generated blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportFilename(docName: string, format: ExportFormat): string {
  const base = docName.replace(/\.[a-z0-9]+$/i, '') || 'image';
  const ext = format === 'jpeg' ? 'jpg' : format;
  return `${base}.${ext}`;
}
