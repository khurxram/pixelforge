// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SHORTCUTS, isTypingTarget, shortcutFor } from './shortcuts';

function key(
  k: string,
  opts: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; target?: EventTarget } = {},
): KeyboardEvent {
  return {
    key: k,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
    metaKey: opts.meta ?? false,
    target: opts.target ?? document.body,
  } as unknown as KeyboardEvent;
}

describe('shortcutFor', () => {
  it('maps undo/redo chords', () => {
    expect(shortcutFor(key('z', { ctrl: true }))).toBe('undo');
    expect(shortcutFor(key('z', { ctrl: true, shift: true }))).toBe('redo');
    expect(shortcutFor(key('Z', { ctrl: true, shift: true }))).toBe('redo');
    expect(shortcutFor(key('y', { ctrl: true }))).toBe('redo2');
    // macOS equivalents
    expect(shortcutFor(key('z', { meta: true }))).toBe('undo');
    expect(shortcutFor(key('s', { meta: true, shift: true }))).toBe('export');
  });

  it('maps file and view chords', () => {
    expect(shortcutFor(key('o', { ctrl: true }))).toBe('open');
    expect(shortcutFor(key('s', { ctrl: true }))).toBe('save');
    expect(shortcutFor(key('p', { ctrl: true, shift: true }))).toBe('downloadProject');
    expect(shortcutFor(key('0', { ctrl: true }))).toBe('fit');
    expect(shortcutFor(key('1', { ctrl: true }))).toBe('actual');
  });

  it('maps single-key tools and color shortcuts (no modifiers)', () => {
    expect(shortcutFor(key('c'))).toBe('tool-crop');
    expect(shortcutFor(key('v'))).toBe('tool-move');
    expect(shortcutFor(key('h'))).toBe('tool-hand');
    expect(shortcutFor(key('b'))).toBe('tool-brush');
    expect(shortcutFor(key('x'))).toBe('swapColors');
    expect(shortcutFor(key('d'))).toBe('defaultColors');
    expect(shortcutFor(key('Enter'))).toBe('applyAdjust');
    expect(shortcutFor(key('Escape'))).toBe('cancelAdjust');
    expect(shortcutFor(key('+'))).toBe('zoomIn');
    expect(shortcutFor(key('-'))).toBe('zoomOut');
  });

  it('maps paint fills, invert, new layer and bracket brush sizing', () => {
    expect(shortcutFor(key('Backspace', { alt: true }))).toBe('fillFg');
    expect(shortcutFor(key('Backspace', { ctrl: true }))).toBe('fillBg');
    expect(shortcutFor(key('Backspace'))).toBe('deletePixels'); // plain still clears
    expect(shortcutFor(key('i', { ctrl: true }))).toBe('invertPixels');
    expect(shortcutFor(key('i', { ctrl: true, shift: true }))).toBe('inverse');
    expect(shortcutFor(key('n', { ctrl: true, shift: true }))).toBe('newLayer');
    expect(shortcutFor(key('['))).toBe('brushSmaller');
    expect(shortcutFor(key(']'))).toBe('brushLarger');
    expect(shortcutFor(key('[', { shift: true }))).toBe('brushSmallerBig');
    expect(shortcutFor(key(']', { shift: true }))).toBe('brushLargerBig');
  });

  it('maps the transform, layer and history chords', () => {
    expect(shortcutFor(key('t', { ctrl: true }))).toBe('transform');
    expect(shortcutFor(key('j', { ctrl: true }))).toBe('layerViaCopy');
    expect(shortcutFor(key('j', { ctrl: true, shift: true }))).toBe('layerViaCut');
    expect(shortcutFor(key('e', { ctrl: true }))).toBe('mergeDown');
    expect(shortcutFor(key('z', { ctrl: true, alt: true }))).toBe('stepBack');
    expect(shortcutFor(key('F6', { shift: true }))).toBe('feather');
    // Ctrl+= / Ctrl+- zoom chords (plus the plain +/- forms).
    expect(shortcutFor(key('=', { ctrl: true }))).toBe('zoomIn');
    expect(shortcutFor(key('-', { ctrl: true }))).toBe('zoomOut');
  });

  it('maps plain digits to layer opacity (0 = 100 %)', () => {
    expect(shortcutFor(key('5'))).toBe('opacity-5');
    expect(shortcutFor(key('0'))).toBe('opacity-0');
    expect(shortcutFor(key('9'))).toBe('opacity-9');
    // Modified digits stay unbound (they belong to zoom/fit chords).
    expect(shortcutFor(key('5', { ctrl: true }))).toBeNull();
    expect(shortcutFor(key('5', { alt: true }))).toBeNull();
    expect(shortcutFor(key('5', { shift: true }))).toBeNull();
  });

  it('returns null for unbound keys and modifier-only chords', () => {
    expect(shortcutFor(key('?'))).toBeNull();
    expect(shortcutFor(key(' '))).toBeNull(); // Space pans locally on the canvas
    expect(shortcutFor(key('c', { ctrl: true }))).toBeNull();
    expect(shortcutFor(key('q', { ctrl: true }))).toBeNull();
    expect(shortcutFor(key('c', { alt: true }))).toBeNull();
  });

  it('returns null while typing in form fields', () => {
    const input = document.createElement('input');
    const ta = document.createElement('textarea');
    const select = document.createElement('select');
    document.body.append(input, ta, select);
    expect(shortcutFor(key('z', { ctrl: true, target: input }))).toBeNull();
    expect(shortcutFor(key('c', { target: ta }))).toBeNull();
    expect(shortcutFor(key('c', { target: select }))).toBeNull();
    expect(shortcutFor(key('c', { target: document.body }))).toBe('tool-crop');
    input.remove();
    ta.remove();
    select.remove();
  });

  it('exposes a table of labelled shortcuts for the help dialog', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(10);
    for (const s of SHORTCUTS) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.keys.length).toBeGreaterThan(0);
      expect(['File', 'Edit', 'View', 'Tools', 'Other']).toContain(s.group);
    }
    const undo = SHORTCUTS.find((s) => s.id === 'undo');
    expect(undo?.keys).toBe('Ctrl+Z');
  });
});

describe('isTypingTarget', () => {
  it('detects editable regions only', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});
