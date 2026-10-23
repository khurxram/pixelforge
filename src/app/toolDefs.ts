import {
  Bandage,
  Blend,
  Brush,
  Circle,
  CircleDashed,
  Crop,
  Droplet,
  Droplets,
  Eraser,
  Eye,
  Focus,
  Frame,
  Hand,
  Hexagon,
  Lasso,
  Magnet,
  Minus,
  Moon,
  Move,
  PaintBucket,
  Paintbrush,
  Palette,
  Pencil,
  Pipette,
  Pointer,
  RectangleHorizontal,
  RectangleVertical,
  ScanSearch,
  Scissors,
  Search,
  Sparkles,
  Spline,
  Squircle,
  Stamp,
  Square,
  SquareDashed,
  Sun,
  Type,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import type { ToolId } from '../core/document/types';

export interface ToolDef {
  id: ToolId;
  label: string;
  shortcut: string;
  Icon: LucideIcon;
  group: 1 | 2 | 3 | 4 | 5;
}

/** Canonical tool list: toolbar rail, options bar, and hints all derive from it. */
export const TOOLS: ToolDef[] = [
  { id: 'move', label: 'Move', shortcut: 'V', Icon: Move, group: 1 },
  { id: 'marquee', label: 'Rectangular Marquee', shortcut: 'M', Icon: SquareDashed, group: 1 },
  { id: 'marquee-ellipse', label: 'Elliptical Marquee', shortcut: 'M', Icon: CircleDashed, group: 1 },
  { id: 'marquee-row', label: 'Single Row Marquee', shortcut: 'M', Icon: RectangleHorizontal, group: 1 },
  { id: 'marquee-col', label: 'Single Column Marquee', shortcut: 'M', Icon: RectangleVertical, group: 1 },
  { id: 'lasso', label: 'Lasso', shortcut: 'L', Icon: Lasso, group: 1 },
  { id: 'lasso-poly', label: 'Polygonal Lasso', shortcut: 'L', Icon: Spline, group: 1 },
  { id: 'lasso-magnetic', label: 'Magnetic Lasso', shortcut: 'L', Icon: Magnet, group: 1 },
  { id: 'wand', label: 'Magic Wand', shortcut: 'W', Icon: WandSparkles, group: 1 },
  { id: 'quickselect', label: 'Quick Selection', shortcut: 'W', Icon: Paintbrush, group: 1 },
  { id: 'objectselect', label: 'Object Selection', shortcut: 'W', Icon: ScanSearch, group: 1 },

  { id: 'crop', label: 'Crop', shortcut: 'C', Icon: Crop, group: 2 },
  { id: 'eyedropper', label: 'Eyedropper', shortcut: 'I', Icon: Pipette, group: 2 },
  { id: 'hand', label: 'Hand (pan)', shortcut: 'H', Icon: Hand, group: 2 },
  { id: 'zoom', label: 'Zoom', shortcut: 'Z', Icon: Search, group: 2 },

  { id: 'brush', label: 'Brush', shortcut: 'B', Icon: Brush, group: 3 },
  { id: 'pencil', label: 'Pencil', shortcut: 'B', Icon: Pencil, group: 3 },
  { id: 'brush-replace', label: 'Color Replacement', shortcut: 'B', Icon: Palette, group: 3 },
  { id: 'eraser', label: 'Eraser', shortcut: 'E', Icon: Eraser, group: 3 },
  { id: 'eraser-magic', label: 'Magic Eraser', shortcut: 'E', Icon: Sparkles, group: 3 },
  { id: 'eraser-bg', label: 'Background Eraser', shortcut: 'E', Icon: Scissors, group: 3 },
  { id: 'clone', label: 'Clone Stamp', shortcut: 'S', Icon: Stamp, group: 3 },
  { id: 'healing', label: 'Healing Brush', shortcut: 'J', Icon: Sparkles, group: 3 },
  { id: 'healing-spot', label: 'Spot Healing', shortcut: 'J', Icon: Bandage, group: 3 },
  { id: 'patch', label: 'Patch', shortcut: 'J', Icon: Frame, group: 3 },
  { id: 'redeye', label: 'Red Eye', shortcut: 'J', Icon: Eye, group: 3 },

  { id: 'gradient', label: 'Gradient', shortcut: 'G', Icon: Blend, group: 4 },
  { id: 'bucket', label: 'Paint Bucket', shortcut: '⇧G', Icon: PaintBucket, group: 4 },
  { id: 'blur', label: 'Blur', shortcut: 'R', Icon: Droplets, group: 4 },
  { id: 'sharpen', label: 'Sharpen', shortcut: 'Y', Icon: Focus, group: 4 },
  { id: 'smudge', label: 'Smudge', shortcut: 'R', Icon: Pointer, group: 4 },
  { id: 'dodge', label: 'Dodge', shortcut: 'O', Icon: Sun, group: 4 },
  { id: 'burn', label: 'Burn', shortcut: '⇧O', Icon: Moon, group: 4 },
  { id: 'sponge', label: 'Sponge', shortcut: 'O', Icon: Droplet, group: 4 },

  { id: 'text', label: 'Text', shortcut: 'T', Icon: Type, group: 5 },
  { id: 'shape', label: 'Shape', shortcut: 'U', Icon: Square, group: 5 },
  { id: 'shape-round', label: 'Rounded Rectangle', shortcut: 'U', Icon: Squircle, group: 5 },
  { id: 'shape-ellipse', label: 'Ellipse', shortcut: 'U', Icon: Circle, group: 5 },
  { id: 'shape-poly', label: 'Polygon', shortcut: 'U', Icon: Hexagon, group: 5 },
  { id: 'shape-line', label: 'Line', shortcut: 'U', Icon: Minus, group: 5 },
];

export const TOOL_BY_ID: Record<ToolId, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t]),
) as Record<ToolId, ToolDef>;

/**
 * Toolbar slots: one rail button per slot. Slots with more than one tool show
 * a flyout (hover for 240 ms, right-click, long-press, or click-while-active) and cycle on
 * repeated shortcut presses — Photoshop-style tool groups.
 * The first tool in each slot is its default/primary tool.
 */
export const TOOL_SLOTS: ToolId[][] = [
  ['move'],
  ['marquee', 'marquee-ellipse', 'marquee-row', 'marquee-col'],
  ['lasso', 'lasso-poly', 'lasso-magnetic'],
  ['wand', 'quickselect', 'objectselect'],
  ['crop'],
  ['eyedropper'],
  ['hand'],
  ['zoom'],
  ['brush', 'pencil', 'brush-replace'],
  ['eraser', 'eraser-magic', 'eraser-bg'],
  ['clone'],
  ['healing', 'healing-spot', 'patch', 'redeye'],
  ['gradient', 'bucket'],
  ['blur', 'sharpen', 'smudge'],
  ['dodge', 'burn', 'sponge'],
  ['text'],
  ['shape', 'shape-round', 'shape-ellipse', 'shape-poly', 'shape-line'],
];

/** Every tool grouped by its slot (for cycling and flyout membership). */
export const TOOL_GROUP: Record<ToolId, ToolId[]> = Object.fromEntries(
  TOOL_SLOTS.map((slot) => [slot[0], slot]),
) as Record<ToolId, ToolId[]>;

/** Repeat-press cycling order for grouped shortcut keys (M, L, G). */
export function cycleToolInGroup(current: ToolId, group: ToolId[]): ToolId {
  const i = group.indexOf(current);
  return group[(i + 1) % group.length];
}
