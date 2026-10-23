/**
 * `.pixelforge` native project format.
 *
 * Binary container layout (all little-endian):
 *
 *   bytes 0..9   ASCII magic "PIXELFORGE"
 *   bytes 10..13 u32 headerByteLength
 *   bytes 14..   header JSON (UTF-8) — see migrations.ts ProjectHeader
 *   then         concatenated binary layer payloads, in header layer order:
 *                [pixels][mask?] per layer, sizes given in the header
 *
 * Payload codecs: 'raw' (uncompressed RGBA) and 'deflate' (CompressionStream).
 * Everything validates strictly with actionable error messages.
 */
import type { EditorDocument, Layer } from '../core/document/types';
import { createRasterLayer, createDocument } from '../core/document/ops';
import {
  CURRENT_VERSION,
  HeaderValidationError,
  migrateHeader,
  type HeaderLayerRef,
  type PixelCodec,
  type ProjectHeader,
} from './migrations';

export const MAGIC = 'PIXELFORGE';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const HEADER_OFFSET = MAGIC_BYTES.length + 4;

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

const hasCompression = typeof CompressionStream !== 'undefined';

async function deflate(bytes: Uint8Array | Uint8ClampedArray): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodePayload(
  data: Uint8Array | Uint8ClampedArray,
  codec: PixelCodec,
): Promise<Uint8Array> {
  if (codec === 'deflate' && hasCompression) return deflate(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

async function decodePayload(
  bytes: Uint8Array,
  codec: PixelCodec,
  expectedBytes: number,
  what: string,
): Promise<Uint8Array> {
  let out: Uint8Array;
  try {
    out = codec === 'deflate' ? await inflate(bytes) : bytes;
  } catch {
    throw new ProjectFormatError(`Project file is corrupted: the ${what} payload could not be decompressed.`);
  }
  if (out.length !== expectedBytes) {
    throw new ProjectFormatError(
      `Project file is corrupted: the ${what} payload is ${out.length} bytes, expected ${expectedBytes}.`,
    );
  }
  return out;
}

export interface SerializeOptions {
  /** Defaults to 'deflate' when the browser supports it, else 'raw'. */
  codec?: PixelCodec;
}

function defaultCodec(): PixelCodec {
  return hasCompression ? 'deflate' : 'raw';
}

/** Serialize a document into a `.pixelforge` Blob. */
export async function serializeProject(
  doc: EditorDocument,
  opts: SerializeOptions = {},
): Promise<Blob> {
  const codec = opts.codec ?? defaultCodec();

  const payloads: Uint8Array[] = [];
  const layerRefs: HeaderLayerRef[] = [];

  for (const layer of doc.layers) {
    const pixelBytes = await encodePayload(layer.pixels.data, codec);
    payloads.push(pixelBytes);
    let maskRef: HeaderLayerRef['mask'] = null;
    if (layer.mask) {
      const maskBytes = await encodePayload(new Uint8Array(layer.mask.data), codec);
      payloads.push(maskBytes);
      maskRef = {
        codec,
        byteLength: maskBytes.byteLength,
        width: layer.mask.width,
        height: layer.mask.height,
        enabled: layer.mask.enabled,
      };
    }
    layerRefs.push({
      id: layer.id,
      name: layer.name,
      kind: 'raster',
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      x: layer.x,
      y: layer.y,
      pixels: {
        codec,
        byteLength: pixelBytes.byteLength,
        width: layer.pixels.width,
        height: layer.pixels.height,
      },
      mask: maskRef,
    });
  }

  const header: ProjectHeader = {
    app: 'PixelForge',
    version: CURRENT_VERSION,
    doc: {
      id: doc.id,
      name: doc.name,
      width: doc.width,
      height: doc.height,
      dpi: doc.dpi,
      activeLayerId: doc.activeLayerId,
      guides: doc.guides,
      createdAt: doc.meta.createdAt,
      modifiedAt: doc.meta.modifiedAt,
      sourceFile: doc.meta.sourceFile,
    },
    layers: layerRefs,
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const total = HEADER_OFFSET + headerBytes.byteLength + payloads.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  out.set(MAGIC_BYTES, 0);
  new DataView(out.buffer).setUint32(MAGIC_BYTES.length, headerBytes.byteLength, true);
  out.set(headerBytes, HEADER_OFFSET);

  let offset = HEADER_OFFSET + headerBytes.byteLength;
  for (const payload of payloads) {
    out.set(payload, offset);
    offset += payload.byteLength;
  }
  return new Blob([out as BlobPart], { type: 'application/x-pixelforge' });
}

function readHeaderJson(view: DataView, bytes: Uint8Array): unknown {
  const headerLen = view.getUint32(MAGIC_BYTES.length, true);
  const start = HEADER_OFFSET;
  if (headerLen === 0 || start + headerLen > bytes.byteLength) {
    throw new ProjectFormatError('Project file is truncated or corrupted (bad header length).');
  }
  const json = new TextDecoder().decode(bytes.subarray(start, start + headerLen));
  try {
    return JSON.parse(json);
  } catch {
    throw new ProjectFormatError('Project file is corrupted: the header is not valid JSON.');
  }
}

/** Parse and validate a `.pixelforge` file into a live document. */
export async function parseProject(data: ArrayBuffer | Blob): Promise<EditorDocument> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < HEADER_OFFSET) {
    throw new ProjectFormatError('This file is too small to be a PixelForge project.');
  }
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      throw new ProjectFormatError('This file is not a PixelForge project (bad file signature).');
    }
  }
  const view = new DataView(buffer);
  const rawHeader = readHeaderJson(view, bytes);

  let header: ProjectHeader;
  try {
    header = migrateHeader(rawHeader);
  } catch (e) {
    if (e instanceof HeaderValidationError) throw new ProjectFormatError(e.message);
    throw e;
  }

  let offset = HEADER_OFFSET + view.getUint32(MAGIC_BYTES.length, true);
  const layers: Layer[] = [];

  for (let i = 0; i < header.layers.length; i++) {
    const ref = header.layers[i];
    const p = ref.pixels;
    const pixelExpected = p.width * p.height * 4;
    if (p.codec === 'raw' && p.byteLength !== pixelExpected) {
      throw new ProjectFormatError(
        `Project file is corrupted: layer "${ref.name}" has an inconsistent pixel size.`,
      );
    }
    if (offset + p.byteLength > bytes.byteLength) {
      throw new ProjectFormatError('Project file is truncated or corrupted (missing layer data).');
    }
    const pixelPayload = bytes.subarray(offset, offset + p.byteLength);
    offset += p.byteLength;
    const pixelData = await decodePayload(pixelPayload, p.codec, pixelExpected, `layer "${ref.name}"`);

    let mask: Layer['mask'] = null;
    if (ref.mask) {
      const m = ref.mask;
      const maskExpected = m.width * m.height;
      if (m.codec === 'raw' && m.byteLength !== maskExpected) {
        throw new ProjectFormatError(
          `Project file is corrupted: mask of layer "${ref.name}" has an inconsistent size.`,
        );
      }
      if (offset + m.byteLength > bytes.byteLength) {
        throw new ProjectFormatError('Project file is truncated or corrupted (missing mask data).');
      }
      const maskPayload = bytes.subarray(offset, offset + m.byteLength);
      offset += m.byteLength;
      const decoded = await decodePayload(maskPayload, m.codec, maskExpected, `mask of layer "${ref.name}"`);
      mask = { width: m.width, height: m.height, data: new Uint8Array(decoded), enabled: m.enabled };
    }

    layers.push({
      id: ref.id,
      name: ref.name,
      kind: 'raster',
      visible: ref.visible,
      opacity: ref.opacity,
      blendMode: ref.blendMode as Layer['blendMode'],
      x: ref.x,
      y: ref.y,
      mask,
      pixels: { width: p.width, height: p.height, data: new Uint8ClampedArray(pixelData) },
    });
  }

  const base = createDocument({
    id: header.doc.id,
    name: header.doc.name,
    width: header.doc.width,
    height: header.doc.height,
    dpi: header.doc.dpi,
    layers: layers.length > 0 ? layers : undefined,
    sourceFile: header.doc.sourceFile,
    now: header.doc.createdAt,
  });

  const activeValid = base.layers.some((l) => l.id === header.doc.activeLayerId);
  return {
    ...base,
    activeLayerId: activeValid ? header.doc.activeLayerId : base.activeLayerId,
    guides: header.doc.guides,
    meta: {
      formatVersion: header.version,
      createdAt: header.doc.createdAt,
      modifiedAt: header.doc.modifiedAt,
      sourceFile: header.doc.sourceFile,
    },
  };
}

/** Quick integrity check without fully decoding payloads. */
export async function sniffProjectFile(data: ArrayBuffer | Blob): Promise<boolean> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < MAGIC_BYTES.length) return false;
  return MAGIC_BYTES.every((b, i) => bytes[i] === b);
}

/** Create a blank transparent document (File → New). */
export function createBlankDocument(width: number, height: number, name = 'Untitled'): EditorDocument {
  return createDocument({ name, width, height, layers: [createRasterLayer({ width, height, data: new Uint8ClampedArray(width * height * 4) }, { name: 'Background' })] });
}
