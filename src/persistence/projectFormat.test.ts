import { describe, expect, it } from 'vitest';
import { createDocument, createPixelBuffer, createRasterLayer } from '../core/document/ops';
import type { EditorDocument } from '../core/document/types';
import { CURRENT_VERSION } from './migrations';
import { parseProject, serializeProject } from './projectFormat';

/** Two-layer fixture with distinct pixels and a mask on the top layer. */
function fixture(): EditorDocument {
  const base = createDocument({
    name: 'My Project',
    width: 3,
    height: 2,
    layers: [],
    now: 1234,
    sourceFile: 'photo.jpg',
  });
  const bgPixels = createPixelBuffer(3, 2, 0);
  for (let i = 0; i < bgPixels.data.length; i += 4) {
    bgPixels.data[i] = i; // distinct reds
    bgPixels.data[i + 3] = 255;
  }
  const bg = createRasterLayer(bgPixels, { name: 'Background', id: 'layer-bg' });

  const topPixels = createPixelBuffer(2, 1, 0);
  topPixels.data.set([10, 20, 30, 255, 40, 50, 60, 200]);
  const top = {
    ...createRasterLayer(topPixels, { name: 'Top', id: 'layer-top', x: 1, y: 1, opacity: 0.75 }),
    blendMode: 'multiply' as const,
    visible: true,
    mask: { width: 2, height: 1, data: new Uint8Array([0, 255]), enabled: true },
  };

  return {
    ...base,
    layers: [bg, top],
    activeLayerId: 'layer-top',
    guides: [{ id: 'g', axis: 'vertical', position: 2 }],
  };
}

function readHeader(blob: Blob): Promise<Record<string, unknown>> {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    const headerLen = new DataView(buf).getUint32(10, true);
    return JSON.parse(new TextDecoder().decode(bytes.slice(14, 14 + headerLen)));
  });
}

/** Rebuild a container around a modified header (payloads preserved). */
async function rebuildWith(blob: Blob, mutate: (header: Record<string, unknown>) => void): Promise<Blob> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const headerLen = new DataView(buf).getUint32(10, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(14, 14 + headerLen)));
  mutate(header);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(14 + json.length + (bytes.length - 14 - headerLen));
  out.set(new TextEncoder().encode('PIXELFORGE'));
  new DataView(out.buffer).setUint32(10, json.length, true);
  out.set(json, 14);
  out.set(bytes.slice(14 + headerLen), 14 + json.length);
  return new Blob([out as BlobPart]);
}

function expectSameDoc(actual: EditorDocument, expected: EditorDocument) {
  expect(actual.name).toBe(expected.name);
  expect(actual.width).toBe(expected.width);
  expect(actual.height).toBe(expected.height);
  expect(actual.dpi).toBe(expected.dpi);
  expect(actual.activeLayerId).toBe(expected.activeLayerId);
  expect(actual.guides).toEqual(expected.guides);
  expect(actual.meta.sourceFile).toBe(expected.meta.sourceFile);
  expect(actual.layers).toHaveLength(expected.layers.length);
  for (let i = 0; i < expected.layers.length; i++) {
    const a = actual.layers[i];
    const e = expected.layers[i];
    expect(a.id).toBe(e.id);
    expect(a.name).toBe(e.name);
    expect(a.x).toBe(e.x);
    expect(a.y).toBe(e.y);
    expect(a.opacity).toBe(e.opacity);
    expect(a.blendMode).toBe(e.blendMode);
    expect(a.visible).toBe(e.visible);
    expect(a.pixels.width).toBe(e.pixels.width);
    expect(a.pixels.height).toBe(e.pixels.height);
    expect(Array.from(a.pixels.data)).toEqual(Array.from(e.pixels.data));
    if (e.mask) {
      expect(a.mask).toBeTruthy();
      expect(a.mask!.width).toBe(e.mask.width);
      expect(a.mask!.height).toBe(e.mask.height);
      expect(a.mask!.enabled).toBe(e.mask.enabled);
      expect(Array.from(a.mask!.data)).toEqual(Array.from(e.mask.data));
    } else {
      expect(a.mask).toBeFalsy();
    }
  }
}

describe('serializeProject / parseProject', () => {
  it('round-trips with the raw codec', async () => {
    const doc = fixture();
    const blob = await serializeProject(doc, { codec: 'raw' });
    expect(blob.type).toBe('application/x-pixelforge');
    expect(blob.size).toBeGreaterThan(0);
    const parsed = await parseProject(blob);
    expectSameDoc(parsed, doc);
  });

  it('round-trips with the deflate codec', async () => {
    const doc = fixture();
    const deflated = await serializeProject(doc, { codec: 'deflate' });
    const header = await readHeader(deflated);
    expect((header.layers as Array<{ pixels: { codec: string } }>)[0].pixels.codec).toBe('deflate');
    const parsed = await parseProject(deflated);
    expectSameDoc(parsed, doc);
  });

  it('writes the current format version in the header', async () => {
    const blob = await serializeProject(fixture(), { codec: 'raw' });
    const header = await readHeader(blob);
    expect(header.version).toBe(CURRENT_VERSION);
    expect(header.app).toBe('PixelForge');
    expect(header.layers).toHaveLength(2);
  });

  it('rejects a file with the wrong magic', async () => {
    const blob = await serializeProject(fixture(), { codec: 'raw' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    bytes[0] = 'X'.charCodeAt(0);
    await expect(parseProject(new Blob([bytes as BlobPart]))).rejects.toThrow(/pixelforge/i);
  });

  it('rejects a truncated file', async () => {
    const blob = await serializeProject(fixture(), { codec: 'raw' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await expect(parseProject(new Blob([bytes.slice(0, 20) as BlobPart]))).rejects.toThrow(/truncat/i);
  });

  it('rejects an unsupported (future) version', async () => {
    const blob = await serializeProject(fixture(), { codec: 'raw' });
    const tampered = await rebuildWith(blob, (h) => {
      h.version = CURRENT_VERSION + 99;
    });
    await expect(parseProject(tampered)).rejects.toThrow(/version/i);
  });

  it('rejects payloads that do not match the declared pixel sizes', async () => {
    const blob = await serializeProject(fixture(), { codec: 'raw' });
    const tampered = await rebuildWith(blob, (h) => {
      const layers = h.layers as Array<{ pixels: { byteLength: number } }>;
      layers[0].pixels.byteLength = 4; // real buffer is 3×2×4 = 24
    });
    await expect(parseProject(tampered)).rejects.toThrow(/inconsistent/i);
  });

  it('round-trips a blank single transparent layer', async () => {
    const doc = createDocument({ name: 'blank', width: 1, height: 1, layers: [], now: 1 });
    const parsed = await parseProject(await serializeProject(doc, { codec: 'deflate' }));
    expect(parsed.name).toBe('blank');
    expect(parsed.layers).toHaveLength(1);
    expect(parsed.layers[0].pixels.data[3]).toBe(0);
  });

  it('sniffs valid and invalid files', async () => {
    const blob = await serializeProject(fixture(), { codec: 'raw' });
    const { sniffProjectFile } = await import('./projectFormat');
    expect(await sniffProjectFile(blob)).toBe(true);
    expect(await sniffProjectFile(new Blob(['hello world']))).toBe(false);
  });
});
