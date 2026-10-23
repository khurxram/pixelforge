/**
 * Command-based undo/redo.
 *
 * Every committed change stores the document state *before* and *after* the
 * operation. Because the document model is immutable (operations never mutate
 * buffers in place), these snapshots share pixel data — undo/redo is a pointer
 * swap, and only history entries that get trimmed release their buffers.
 */
import type { EditorDocument } from '../document/types';

export interface HistoryEntry {
  label: string;
  before: EditorDocument;
  after: EditorDocument;
}

export interface HistoryState {
  entries: HistoryEntry[];
  /** Number of applied entries; entries[index - 1] is the last applied change. */
  index: number;
}

export const MAX_ENTRIES = 25;

export function emptyHistory(): HistoryState {
  return { entries: [], index: 0 };
}

export function canUndo(h: HistoryState): boolean {
  return h.index > 0;
}

export function canRedo(h: HistoryState): boolean {
  return h.index < h.entries.length;
}

/** Append a committed change, discarding the redo tail and trimming the oldest entries. */
export function pushEntry(h: HistoryState, entry: HistoryEntry, limit = MAX_ENTRIES): HistoryState {
  const entries = h.entries.slice(0, h.index);
  entries.push(entry);
  let index = entries.length;
  while (entries.length > limit) {
    entries.shift();
    index -= 1;
  }
  return { entries, index };
}

/** Returns the state after one undo step, or null when nothing can be undone. */
export function undoOnce(h: HistoryState): { history: HistoryState; doc: EditorDocument } | null {
  if (!canUndo(h)) return null;
  const entry = h.entries[h.index - 1];
  return { history: { entries: h.entries, index: h.index - 1 }, doc: entry.before };
}

export function redoOnce(h: HistoryState): { history: HistoryState; doc: EditorDocument } | null {
  if (!canRedo(h)) return null;
  const entry = h.entries[h.index];
  return { history: { entries: h.entries, index: h.index + 1 }, doc: entry.after };
}

/**
 * Move the history pointer to `target` (0..entries.length), applying undo/redo
 * steps as needed. `doc` is the restored document, or `undefined` when the
 * pointer was already at the target (caller keeps its current document).
 */
export function jumpTo(
  h: HistoryState,
  target: number,
): { history: HistoryState; doc: EditorDocument | undefined } {
  const clamped = Math.max(0, Math.min(h.entries.length, target));
  if (clamped === h.index) return { history: h, doc: undefined };

  let index = h.index;
  let doc: EditorDocument | undefined;
  while (index > clamped) {
    index -= 1;
    doc = h.entries[index].before;
  }
  while (index < clamped) {
    doc = h.entries[index].after;
    index += 1;
  }
  return { history: { entries: h.entries, index }, doc };
}

export interface HistoryItem {
  label: string;
  position: number;
  current: boolean;
  canJump: boolean;
}

export function historyItems(h: HistoryState): HistoryItem[] {
  return h.entries.map((e, i) => ({
    label: e.label,
    position: i + 1,
    current: i === h.index - 1,
    canJump: true,
  }));
}
