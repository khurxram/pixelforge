import { describe, expect, it } from 'vitest';
import { createDocument, replaceLayer } from '../document/ops';
import type { EditorDocument } from '../document/types';
import {
  canRedo,
  canUndo,
  emptyHistory,
  historyItems,
  jumpTo,
  MAX_ENTRIES,
  pushEntry,
  redoOnce,
  undoOnce,
} from './history';

function doc(value: number): EditorDocument {
  const base = createDocument({ name: 'd', width: 1, height: 1, layers: [], now: 0 });
  const layer = { ...base.layers[0], pixels: { width: 1, height: 1, data: new Uint8ClampedArray([value, 0, 0, 255]) } };
  return replaceLayer(base, base.layers[0].id, layer);
}

/** Push a "change value" entry like the editor does. */
function step(h: ReturnType<typeof emptyHistory>, from: number, to: number, label: string) {
  return pushEntry(h, { label, before: doc(from), after: doc(to) });
}

describe('history', () => {
  it('starts empty with no undo/redo', () => {
    const h = emptyHistory();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undoOnce(h)).toBeNull();
    expect(redoOnce(h)).toBeNull();
  });

  it('undoes and redoes committed steps in order', () => {
    let h = emptyHistory();
    h = step(h, 0, 1, 'one');
    h = step(h, 1, 2, 'two');
    expect(h.index).toBe(2);
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);

    const u1 = undoOnce(h)!;
    expect(u1.doc.layers[0].pixels.data[0]).toBe(1);
    expect(u1.history.index).toBe(1);

    const u2 = undoOnce(u1.history)!;
    expect(u2.doc.layers[0].pixels.data[0]).toBe(0);
    expect(canUndo(u2.history)).toBe(false);

    const r1 = redoOnce(u2.history)!;
    expect(r1.doc.layers[0].pixels.data[0]).toBe(1);
    const r2 = redoOnce(r1.history)!;
    expect(r2.doc.layers[0].pixels.data[0]).toBe(2);
    expect(canRedo(r2.history)).toBe(false);
  });

  it('discards the redo tail when a new entry is pushed', () => {
    let h = emptyHistory();
    h = step(h, 0, 1, 'one');
    h = step(h, 1, 2, 'two');
    h = undoOnce(h)!.history;
    h = step(h, 1, 9, 'branch');
    expect(h.entries).toHaveLength(2);
    expect(h.entries[1].label).toBe('branch');
    expect(canRedo(h)).toBe(false);
  });

  it('trims the oldest entries beyond the limit', () => {
    let h = emptyHistory();
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      h = step(h, i, i + 1, `s${i}`);
    }
    expect(h.entries).toHaveLength(MAX_ENTRIES);
    expect(h.index).toBe(MAX_ENTRIES);
    expect(h.entries[0].label).toBe('s5');
    expect(undoOnce(h)!.doc.layers[0].pixels.data[0]).toBe(MAX_ENTRIES + 4);
  });

  it('jumps to arbitrary states both directions', () => {
    let h = emptyHistory();
    h = step(h, 0, 1, 'one');
    h = step(h, 1, 2, 'two');
    h = step(h, 2, 3, 'three');

    const toStart = jumpTo(h, 0);
    expect(toStart.doc?.layers[0].pixels.data[0]).toBe(0);
    expect(toStart.history.index).toBe(0);

    const toMiddle = jumpTo(toStart.history, 2);
    expect(toMiddle.doc?.layers[0].pixels.data[0]).toBe(2);
    expect(toMiddle.history.index).toBe(2);

    const same = jumpTo(toMiddle.history, 2);
    expect(same.doc).toBeUndefined(); // no-op jump reports no change
  });

  it('exposes labelled items for the history panel', () => {
    let h = emptyHistory();
    h = step(h, 0, 1, 'one');
    h = jumpTo(h, 0).history;
    const items = historyItems(h);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: 'one', position: 1, current: false });
  });
});
