/**
 * Marching-squares contour tracing for selection masks.
 *
 * Why this exists: the renderer used to stamp the selection boundary into an
 * RGBA bitmap at *document* resolution and blit it scaled. That only looks
 * right at exactly 100% zoom — fit a 4000 px photo into a 1000 px viewport and
 * the 1 px ring is downsampled with smoothing off, so the ants break into
 * sparse dots; at 400% it becomes a chunky staircase. Tracing the boundary into
 * polylines lets the renderer stroke it in *screen* space: 1 px, smooth joins,
 * dashes that follow the contour, at any zoom.
 *
 * Pure, DOM-free, unit tested in Node.
 *
 * Marching squares runs over the cell grid (a cell's corners are the centres of
 * four neighbouring pixels, so the grid extends one cell past each border and
 * out-of-image counts as unselected — a selection that touches its bounds closes
 * cleanly along the edge). Each crossing pair becomes one segment, oriented so
 * the **selected region lies on its right**; chains are then stitched
 * end-to-start back to the loop's origin, which yields closed contours without
 * needing a visited-pixel set.
 */

/** Edge midpoints of a cell, as ×2 integers so every key is an exact int. */
const LEFT = 0;
const TOP = 1;
const RIGHT = 2;
const BOTTOM = 3;

/**
 * Segment endpoints per marching-squares case (index = TL·8 + TR·4 + BR·2 + BL).
 * `[]` for the two uniform cases. Both saddle cases (5: TR+BL, 10: TL+BR) are
 * resolved by isolating each selected corner, which is the choice that keeps a
 * diagonal pinch from smearing two regions into one.
 */
const CASES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [], // 0  — all out
  [
    [LEFT, BOTTOM],
  ], // 1  BL
  [
    [BOTTOM, RIGHT],
  ], // 2  BR
  [
    [LEFT, RIGHT],
  ], // 3  BL+BR
  [
    [RIGHT, TOP],
  ], // 4  TR
  [
    [RIGHT, TOP],
    [LEFT, BOTTOM],
  ], // 5  TR+BL (saddle)
  [
    [BOTTOM, TOP],
  ], // 6  TR+BR
  [
    [LEFT, TOP],
  ], // 7  all but TL
  [
    [TOP, LEFT],
  ], // 8  TL
  [
    [TOP, BOTTOM],
  ], // 9  TL+BL
  [
    [TOP, LEFT],
    [BOTTOM, RIGHT],
  ], // 10 TL+BR (saddle)
  [
    [TOP, RIGHT],
  ], // 11 all but TR
  [
    [RIGHT, LEFT],
  ], // 12 TL+TR
  [
    [RIGHT, BOTTOM],
  ], // 13 all but BR
  [
    [BOTTOM, LEFT],
  ], // 14 all but BL
  [], // 15 — all in
];

/** Midpoint of cell edge `e`, doubled to stay on the integer lattice. */
function edgePoint(cx: number, cy: number, e: number): readonly [number, number] {
  if (e === LEFT) return [cx * 2, cy * 2 + 1];
  if (e === TOP) return [cx * 2 + 1, cy * 2];
  if (e === RIGHT) return [cx * 2 + 2, cy * 2 + 1];
  return [cx * 2 + 1, cy * 2 + 2];
}

/** Vertex key. Doubles stay far apart, so the pair is injective for any image
 *  that could ever be loaded (offset +2 keeps the out-of-image ring positive). */
function vertexKey(x: number, y: number): number {
  return (x + 2) * 4_000_000 + (y + 2);
}

/**
 * Trace every boundary of `mask` into a closed polyline.
 *
 * @param mask Alpha mask, `width * height` bytes, 0..255 (≥128 = selected).
 * @returns One `Float32Array` per loop, laid out as `[x0, y0, x1, y1, …]` in
 *          **bounds-local** coordinates — add `bounds.x` / `bounds.y` to reach
 *          document space. The last vertex does not repeat the first; close the
 *          path when stroking. Loops are returned in scan order and each is
 *          guaranteed to have at least three vertices.
 */
export function traceContours(mask: Uint8Array, width: number, height: number): Float32Array[] {
  if (width <= 0 || height <= 0) return [];

  // One pass to a plain 0/1 image; the cell sweep then reads bytes only.
  const bin = new Uint8Array(width * height);
  for (let i = 0; i < bin.length; i++) bin[i] = mask[i] >= 128 ? 1 : 0;
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : bin[y * width + x];

  const segs: number[] = []; // flat x1, y1, x2, y2 (×2 integers)
  const heads = new Map<number, number[]>(); // segment start → its index

  for (let cy = -1; cy < height; cy++) {
    for (let cx = -1; cx < width; cx++) {
      const tl = at(cx, cy);
      const tr = at(cx + 1, cy);
      const br = at(cx + 1, cy + 1);
      const bl = at(cx, cy + 1);
      // Uniform cells carry no crossing — skip the 12 M of them on a full-doc
      // selection without ever building a key.
      if ((tl | tr | br | bl) === 0 || (tl & tr & br & bl) === 1) continue;
      const segments = CASES[(tl << 3) | (tr << 2) | (br << 1) | bl];
      for (let s = 0; s < segments.length; s++) {
        const a = edgePoint(cx, cy, segments[s][0]);
        const b = edgePoint(cx, cy, segments[s][1]);
        const index = segs.length / 4;
        segs.push(a[0], a[1], b[0], b[1]);
        const key = vertexKey(a[0], a[1]);
        const list = heads.get(key);
        if (list) list.push(index);
        else heads.set(key, [index]);
      }
    }
  }

  const total = segs.length / 4;
  if (total === 0) return [];
  const used = new Uint8Array(total);
  const out: Float32Array[] = [];

  for (let i = 0; i < total; i++) {
    if (used[i]) continue;
    const startX = segs[i * 4];
    const startY = segs[i * 4 + 1];
    const startKey = vertexKey(startX, startY);
    const pts: number[] = [];
    let cur = i;
    while (cur >= 0 && !used[cur]) {
      used[cur] = 1;
      const b = cur * 4;
      pts.push(segs[b], segs[b + 1]);
      if (vertexKey(segs[b + 2], segs[b + 3]) === startKey) break; // closed
      const list = heads.get(vertexKey(segs[b + 2], segs[b + 3]));
      let next = -1;
      if (list) {
        for (let k = 0; k < list.length; k++) {
          if (!used[list[k]]) {
            next = list[k];
            break;
          }
        }
      }
      cur = next;
    }
    // Three vertices minimum: a single selected pixel traces four segments.
    if (pts.length >= 6) {
      const loop = new Float32Array(pts.length);
      for (let k = 0; k < pts.length; k++) loop[k] = pts[k] * 0.5;
      out.push(loop);
    }
  }
  return out;
}
