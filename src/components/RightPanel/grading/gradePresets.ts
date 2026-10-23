import type { AdjustParams } from '../../../imaging/adjustments';

export interface GradePreset {
  id: string;
  name: string;
  /** Tooltip describing the look. */
  blurb: string;
  /** Grading values merged into the pending adjustments when selected. */
  grade: Partial<AdjustParams>;
}

/**
 * One-click looks — the grader's "LUT gallery". Each preset sets the
 * lift/gamma/gain wheels plus a few trim sliders; Apply commits for real.
 */
export const GRADE_PRESETS: GradePreset[] = [
  {
    id: 'neutral',
    name: 'Neutral',
    blurb: 'Clean starting point — no grade.',
    grade: {},
  },
  {
    id: 'teal-orange',
    name: 'Teal & Orange',
    blurb: 'Blockbuster split tone: teal shadows, amber highlights.',
    grade: { liftX: -0.35, liftY: -0.12, gainX: 0.3, gainY: 0.05, saturation: 12 },
  },
  {
    id: 'warm-film',
    name: 'Warm Film',
    blurb: 'Faded blacks and honey highlights, gentle warmth.',
    grade: { liftM: 6, gammaX: 0.15, gammaY: -0.05, gainX: 0.18, temperature: 15, saturation: 5 },
  },
  {
    id: 'cold-noir',
    name: 'Cold Noir',
    blurb: 'Steel-blue, high-contrast, near-monochrome.',
    grade: { saturation: -75, contrast: 30, temperature: -22, gainY: 0.1, liftM: -8 },
  },
  {
    id: 'vintage-fade',
    name: 'Vintage Fade',
    blurb: 'Lifted blacks, creamy whites, faded print.',
    grade: { liftM: 14, gainM: -12, gammaX: 0.1, contrast: -8, saturation: -10, temperature: 10 },
  },
  {
    id: 'vivid',
    name: 'Vivid',
    blurb: 'Punchy contrast and saturated color.',
    grade: { saturation: 28, contrast: 18, exposure: 4, gammaY: -0.06 },
  },
  {
    id: 'bleach',
    name: 'Bleach Bypass',
    blurb: 'Desaturated silver-halide grit.',
    grade: { saturation: -45, contrast: 32, exposure: 5, liftM: 8 },
  },
  {
    id: 'portrait',
    name: 'Portrait Soft',
    blurb: 'Warm, gentle glow with softened contrast.',
    grade: { exposure: 5, contrast: -10, temperature: 10, liftY: -0.05, gammaX: 0.05, saturation: 6 },
  },
  {
    id: 'arctic',
    name: 'Arctic',
    blurb: 'Icy cyan shadows on a cool frame.',
    grade: { liftX: -0.15, liftY: -0.25, gainY: 0.15, temperature: -28, saturation: 8 },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    blurb: 'Golden-hour warmth in the highlights.',
    grade: { gainX: 0.32, gainY: 0.1, gammaX: 0.1, temperature: 24, saturation: 12 },
  },
];
