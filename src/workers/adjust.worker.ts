/** Full-resolution adjustment processing in a Web Worker (sync fallback exists). */
import { applyAdjustments, type AdjustParams } from '../imaging/adjustments';

export interface AdjustRequest {
  id: number;
  width: number;
  height: number;
  /** Transferred RGBA buffer (owned by the worker after posting). */
  data: ArrayBuffer;
  params: AdjustParams;
}

export type AdjustResponse =
  | { id: number; ok: true; data: ArrayBuffer }
  | { id: number; ok: false; error: string };

const workerSelf = self as unknown as {
  onmessage: ((e: MessageEvent<AdjustRequest>) => void) | null;
  postMessage(msg: AdjustResponse, transfer?: Transferable[]): void;
};

workerSelf.onmessage = (e) => {
  const { id, width, height, data, params } = e.data;
  try {
    const src = { width, height, data: new Uint8ClampedArray(data) };
    const result = applyAdjustments(src, params);
    workerSelf.postMessage({ id, ok: true, data: result.data.buffer as ArrayBuffer }, [result.data.buffer as ArrayBuffer]);
  } catch (err) {
    workerSelf.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
