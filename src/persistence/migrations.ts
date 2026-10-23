/**
 * Project header schema, validation, and version migrations.
 *
 * The header is JSON (readable for debugging); pixel payloads are binary
 * blobs appended after it in the container defined by projectFormat.ts.
 */

export const SUPPORTED_VERSIONS = [1] as const;
export const CURRENT_VERSION = 1;

export type PixelCodec = 'raw' | 'deflate';

export interface HeaderLayerRef {
  id: string;
  name: string;
  kind: 'raster';
  visible: boolean;
  opacity: number;
  blendMode: string;
  x: number;
  y: number;
  pixels: { codec: PixelCodec; byteLength: number; width: number; height: number };
  mask: { codec: PixelCodec; byteLength: number; width: number; height: number; enabled: boolean } | null;
}

export interface ProjectHeader {
  app: 'PixelForge';
  version: number;
  doc: {
    id: string;
    name: string;
    width: number;
    height: number;
    dpi: number;
    activeLayerId: string | null;
    guides: Array<{ id: string; axis: 'horizontal' | 'vertical'; position: number }>;
    createdAt: number;
    modifiedAt: number;
    sourceFile?: string;
  };
  layers: HeaderLayerRef[];
}

export class HeaderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeaderValidationError';
  }
}

const CODECS: PixelCodec[] = ['raw', 'deflate'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function reqNum(o: Record<string, unknown>, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HeaderValidationError(`Project header: "${path}.${key}" must be a number.`);
  }
  return v;
}

function reqStr(o: Record<string, unknown>, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string') {
    throw new HeaderValidationError(`Project header: "${path}.${key}" must be a string.`);
  }
  return v;
}

function validateCodec(ref: unknown, path: string): HeaderLayerRef['pixels'] {
  if (!isRecord(ref)) throw new HeaderValidationError(`Project header: "${path}" must be an object.`);
  const codec = reqStr(ref, 'codec', path) as PixelCodec;
  if (!CODECS.includes(codec)) {
    throw new HeaderValidationError(`Project header: "${path}.codec" uses unknown codec "${codec}".`);
  }
  const byteLength = reqNum(ref, 'byteLength', path);
  const width = reqNum(ref, 'width', path);
  const height = reqNum(ref, 'height', path);
  if (byteLength < 0 || width < 1 || height < 1) {
    throw new HeaderValidationError(`Project header: "${path}" has invalid dimensions or size.`);
  }
  return { codec, byteLength, width, height };
}

/** Structural validation of an unknown JSON value into a ProjectHeader. */
export function validateHeader(raw: unknown): ProjectHeader {
  if (!isRecord(raw)) throw new HeaderValidationError('Project header must be a JSON object.');
  if (raw.app !== 'PixelForge') {
    throw new HeaderValidationError('Project header: unknown application marker.');
  }
  const version = reqNum(raw, 'version', 'header');
  const doc = raw.doc;
  if (!isRecord(doc)) throw new HeaderValidationError('Project header: "doc" must be an object.');
  const layersRaw = raw.layers;
  if (!Array.isArray(layersRaw)) throw new HeaderValidationError('Project header: "layers" must be an array.');

  const layers: HeaderLayerRef[] = layersRaw.map((l, i) => {
    if (!isRecord(l)) throw new HeaderValidationError(`Project header: layers[${i}] must be an object.`);
    const kind = reqStr(l, 'kind', `layers[${i}]`);
    if (kind !== 'raster') {
      throw new HeaderValidationError(`Project header: layers[${i}] has unsupported kind "${kind}".`);
    }
    let mask: HeaderLayerRef['mask'] = null;
    if (l.mask != null) {
      const m = validateCodec(l.mask, `layers[${i}].mask`) as HeaderLayerRef['mask'] & object;
      mask = { ...m, enabled: typeof (m as { enabled?: unknown }).enabled === 'boolean' ? (m as { enabled: boolean }).enabled : true };
    }
    return {
      id: reqStr(l, 'id', `layers[${i}]`),
      name: reqStr(l, 'name', `layers[${i}]`),
      kind,
      visible: l.visible !== false,
      opacity: typeof l.opacity === 'number' ? Math.min(1, Math.max(0, l.opacity)) : 1,
      blendMode: typeof l.blendMode === 'string' ? l.blendMode : 'normal',
      x: reqNum(l, 'x', `layers[${i}]`),
      y: reqNum(l, 'y', `layers[${i}]`),
      pixels: validateCodec(l.pixels, `layers[${i}].pixels`),
      mask,
    };
  });

  const guides: ProjectHeader['doc']['guides'] = Array.isArray(doc.guides)
    ? doc.guides.flatMap((g, i) => {
        if (!isRecord(g)) throw new HeaderValidationError(`Project header: guides[${i}] must be an object.`);
        const axis = reqStr(g, 'axis', `guides[${i}]`);
        if (axis !== 'horizontal' && axis !== 'vertical') {
          throw new HeaderValidationError(`Project header: guides[${i}] has invalid axis.`);
        }
        return [{ id: reqStr(g, 'id', `guides[${i}]`), axis, position: reqNum(g, 'position', `guides[${i}]`) }];
      })
    : [];

  const header: ProjectHeader = {
    app: 'PixelForge',
    version,
    doc: {
      id: reqStr(doc, 'id', 'doc'),
      name: reqStr(doc, 'name', 'doc'),
      width: reqNum(doc, 'width', 'doc'),
      height: reqNum(doc, 'height', 'doc'),
      dpi: reqNum(doc, 'dpi', 'doc'),
      activeLayerId: typeof doc.activeLayerId === 'string' ? doc.activeLayerId : null,
      guides,
      createdAt: reqNum(doc, 'createdAt', 'doc'),
      modifiedAt: reqNum(doc, 'modifiedAt', 'doc'),
      sourceFile: typeof doc.sourceFile === 'string' ? doc.sourceFile : undefined,
    },
    layers,
  };

  if (header.doc.width < 1 || header.doc.height < 1 || header.doc.width > 16_384 || header.doc.height > 16_384) {
    throw new HeaderValidationError('Project header: document dimensions are out of range.');
  }
  return header;
}

type Migration = (header: ProjectHeader) => ProjectHeader;

/**
 * Version migration chain: MIGRATIONS[n] upgrades a version-n header to n+1.
 * Version 1 is the initial shipped format, so the chain is currently empty.
 * Future formats only need to add a step here.
 */
const MIGRATIONS: Record<number, Migration> = {};

/** Validate + migrate a parsed header to the current version. */
export function migrateHeader(raw: unknown): ProjectHeader {
  let header = validateHeader(raw);
  if (!SUPPORTED_VERSIONS.includes(header.version as 1)) {
    if (header.version > CURRENT_VERSION) {
      throw new HeaderValidationError(
        `This project was saved by a newer version of PixelForge (format v${header.version}; this build supports v${CURRENT_VERSION}).`,
      );
    }
    throw new HeaderValidationError(`Unsupported project format version v${header.version}.`);
  }
  while (header.version < CURRENT_VERSION) {
    const step = MIGRATIONS[header.version];
    if (!step) {
      throw new HeaderValidationError(`No migration available from format v${header.version}.`);
    }
    header = step(header);
  }
  return header;
}
