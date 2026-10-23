/**
 * Image import: decode local files (JPEG/PNG/WebP/GIF/AVIF as supported by the
 * browser) into PixelBuffers, with dimension validation and a two-phase probe
 * so unusually large images can be confirmed BEFORE big allocations.
 */
import type { PixelBuffer } from '../core/document/types';
import { MAX_IMAGE_DIMENSION, WARN_IMAGE_MEGAPIXELS } from '../core/document/types';

export class ImageDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|gif|avif|bmp|svg)$/i;

export function isAcceptedImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return ACCEPTED_EXTENSIONS.test(file.name);
}

export interface ProbeResult {
  bitmap: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
}

function decodeWithImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImageDecodeError(`Could not decode "${file.name}". The file may be damaged or in an unsupported format.`));
    };
    img.src = url;
  });
}

/** Decode a file to a bitmap without reading pixel data yet. */
export async function probeImage(file: File): Promise<ProbeResult> {
  if (!isAcceptedImageFile(file)) {
    throw new ImageDecodeError(`"${file.name}" is not a supported image file.`);
  }
  if (file.size === 0) {
    throw new ImageDecodeError(`"${file.name}" is empty.`);
  }
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new ImageDecodeError(
        `Could not decode "${file.name}". The file may be damaged or in an unsupported format.`,
      );
    }
    if (bitmap.width > MAX_IMAGE_DIMENSION || bitmap.height > MAX_IMAGE_DIMENSION) {
      bitmap.close();
      throw new ImageDecodeError(
        `Image is ${bitmap.width}×${bitmap.height}; the maximum supported dimension is ${MAX_IMAGE_DIMENSION}px.`,
      );
    }
    return { bitmap, width: bitmap.width, height: bitmap.height };
  }
  const img = await decodeWithImageElement(file);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new ImageDecodeError(
      `Image is ${width}×${height}; the maximum supported dimension is ${MAX_IMAGE_DIMENSION}px.`,
    );
  }
  return { bitmap: img, width, height };
}

export function megapixels(width: number, height: number): number {
  return (width * height) / 1e6;
}

export function exceedsWarningThreshold(width: number, height: number): boolean {
  return megapixels(width, height) > WARN_IMAGE_MEGAPIXELS;
}

/** Read pixels from a probed bitmap into a new PixelBuffer (full allocation). */
export function readPixels(bitmap: ProbeResult['bitmap']): PixelBuffer {
  const width = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
  const height = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ImageDecodeError('Canvas 2D is unavailable in this browser.');
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  if ('close' in bitmap) bitmap.close();
  return { width, height, data: imageData.data };
}

/** One-shot decode with the size warning handled by the caller beforehand. */
export async function decodeImageFile(file: File): Promise<PixelBuffer> {
  const probe = await probeImage(file);
  return readPixels(probe.bitmap);
}
