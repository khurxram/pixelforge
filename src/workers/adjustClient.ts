/**
 * Worker client for adjustment processing. Falls back to synchronous
 * processing when Workers are unavailable (tests, older engines), and
 * supports cancelling superseded tasks.
 */
import type { PixelBuffer } from '../core/document/types';
import { applyAdjustments, type AdjustParams } from '../imaging/adjustments';
import type { AdjustResponse } from './adjust.worker';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (b: Uint8ClampedArray<ArrayBuffer>) => void; reject: (e: Error) => void }>();

function failAll(message: string): void {
  for (const [, p] of pending) p.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./adjust.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<AdjustResponse>) => {
      const msg = e.data;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(new Uint8ClampedArray(msg.data));
      else entry.reject(new Error(msg.error));
    };
    worker.onerror = (e) => {
      failAll(e.message || 'Adjustment worker failed.');
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    worker = null;
    return null;
  }
}

/** Reject all in-flight tasks (e.g. when the document changes underneath them). */
export function cancelAdjustments(): void {
  failAll('Cancelled');
}

/**
 * Apply adjustments to a full-resolution buffer. Returns a NEW buffer; the
 * input is never detached or mutated. The worker receives a copy so the
 * document's data stays untouched during transfer.
 */
export async function runAdjustments(buf: PixelBuffer, params: AdjustParams): Promise<PixelBuffer> {
  const w = getWorker();
  if (!w) {
    // Sync fallback — keeps everything correct without a worker.
    return applyAdjustments(buf, params);
  }
  const copy = new Uint8ClampedArray(buf.data);
  return new Promise<PixelBuffer>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {
      resolve: (data) => resolve({ width: buf.width, height: buf.height, data }),
      reject,
    });
    w.postMessage(
      { id, width: buf.width, height: buf.height, data: copy.buffer as ArrayBuffer, params },
      [copy.buffer as ArrayBuffer],
    );
  });
}

/** Terminate the worker (page teardown / tests). */
export function disposeAdjustWorker(): void {
  cancelAdjustments();
  worker?.terminate();
  worker = null;
}
