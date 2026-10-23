import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, Check, Copy, Move, SquareDashed, SquareMinus, SquarePlus, X } from 'lucide-react';
import styles from './OptionsBar.module.css';
import {
  alignActiveLayer,
  cancelFreeTransform,
  commitFreeTransform,
  cropActiveDocument,
  deselect,
  featherActiveSelection,
  fitToScreen,
  invertSelection,
  selectAll,
  setBrushOpacity,
  setBrushSize,
  setCropRect,
  setShapeKind,
  setTextSize,
  setTextValue,
  setEdgeThreshold,
  setWandTolerance,
  zoomToPercent,
} from '../../app/actions';
import { setState, useEditorStore, type CropAspect } from '../../app/editorStore';
import { TOOL_BY_ID } from '../../app/toolDefs';
import type { ToolId } from '../../core/document/types';
import type { SelectionMode } from '../../core/document/selection';

/** One-line, tool-specific hint shown at the right of the bar. */
const TOOL_HINTS: Record<ToolId, string> = {
  move: 'Drag to move the active layer — Shift snaps to 10 px, arrow keys nudge. The Align buttons line the layer up with the selection or the canvas.',
  marquee: 'Drag to select a rectangle. Ctrl+D deselects, Delete clears.',
  'marquee-ellipse': 'Drag to select an ellipse. Hold Shift-style ratios in the Style menu.',
  'marquee-row': 'Click to select a single-pixel row across the image.',
  'marquee-col': 'Click to select a single-pixel column down the image.',
  lasso: 'Draw a freehand outline — release to close the shape and select inside it.',
  'lasso-poly': 'Click to place corners, click the first point or press Enter to close, Esc cancels.',
  'lasso-magnetic': 'Drag along an edge — anchors snap to strong edges. Width, Contrast and Frequency tune the detection.',
  wand: 'Click once to select the color range under the cursor.',
  quickselect: 'Paint over an area to grow the selection; each stroke unions under the current selection mode.',
  objectselect: 'Click inside an object — growth fills matching color but stops at strong edges. Edge sets how strong a boundary must be.',
  crop: 'Drag a crop area on the canvas. Enter applies, Esc cancels.',
  brush: 'Paint with the foreground color (rail swatches, X swaps).',
  pencil: 'Hard-edged aliased painting — crisp single-pixel lines for pixel art.',
  'brush-replace': 'Recolor pixels near the sampled color with the foreground, keeping their shading. Tolerance sets the match.',
  eraser: 'Erase back to transparency on the active layer.',
  'eraser-magic': 'One click erases the matching color range (tolerance, contiguous, and opacity apply).',
  'eraser-bg': 'Erase only the sampled color under the brush — great for knocking out a background.',
  clone: 'Alt-click to sample a source point, then paint the copy.',
  healing: 'Alt-click to sample a source point — the patch blends into the local brightness.',
  'healing-spot': 'Paint over small defects — they are rebuilt from the surrounding pixels. No source point needed.',
  patch: 'Draw around a defect, then drag the selection to a clean area — release to patch it in.',
  redeye: 'Paint over a flash-red pupil to neutralize it — Amount controls the correction.',
  bucket: 'Click to flood-fill with the foreground color. Tolerance sets how far colors may differ.',
  gradient: 'Drag from → to to paint a gradient. Shape picks linear, radial, angle, reflected or diamond.',
  blur: 'Paint to soften details. Bigger brush = wider blur radius.',
  sharpen: 'Paint to crisp up details (unsharp mask under the brush).',
  smudge: 'Drag to push pixels along the stroke like a wet finger. Strength sets how far they travel.',
  dodge: 'Paint to lighten. Exposure and Range target specific tones.',
  burn: 'Paint to darken. Exposure and Range target specific tones.',
  sponge: 'Paint to saturate or desaturate color without changing brightness.',
  text: 'Type a caption, then click the canvas to place it as a new layer.',
  shape: 'Drag out a filled shape in the foreground color.',
  'shape-round': 'Drag out a rounded rectangle — Corner radius sets the roundness.',
  'shape-ellipse': 'Drag out an ellipse in the foreground color.',
  'shape-poly': 'Drag out a regular polygon inscribed in the box — Sides sets the count.',
  'shape-line': 'Drag from start to end — Weight sets the line thickness.',
  hand: 'Drag to pan. Hold Space with any tool for temporary panning.',
  zoom: 'Click to zoom in, Alt-click to zoom out, or use the Fit / 100% buttons.',
  eyedropper: 'Click the canvas to sample the composited color into the foreground swatch.',
};

const BRUSH_TOOLS: readonly ToolId[] = [
  'brush',
  'pencil',
  'brush-replace',
  'eraser',
  'eraser-bg',
  'clone',
  'healing',
  'healing-spot',
  'redeye',
  'blur',
  'sharpen',
  'smudge',
  'dodge',
  'burn',
  'sponge',
];

const SELECTION_TOOLS: readonly ToolId[] = [
  'marquee',
  'marquee-ellipse',
  'marquee-row',
  'marquee-col',
  'lasso',
  'lasso-poly',
  'lasso-magnetic',
  'wand',
  'quickselect',
  'objectselect',
  'patch',
];

/** Tools that expose the shared Tolerance slider. */
const TOLERANCE_TOOLS: readonly ToolId[] = [
  'wand',
  'bucket',
  'quickselect',
  'objectselect',
  'eraser-magic',
  'eraser-bg',
  'brush-replace',
];

/** Tools whose brush honors the Hardness slider (pencil is always hard). */
const HARDNESS_TOOLS: readonly ToolId[] = [
  'brush',
  'eraser',
  'brush-replace',
  'eraser-bg',
  'clone',
  'healing',
  'healing-spot',
  'redeye',
  'smudge',
  'sponge',
];

const STRENGTH_LABEL: Partial<Record<ToolId, string>> = {
  blur: 'Strength',
  sharpen: 'Strength',
  smudge: 'Strength',
  sponge: 'Strength',
  dodge: 'Exposure',
  burn: 'Exposure',
  healing: 'Flow',
  'healing-spot': 'Flow',
  redeye: 'Amount',
  'eraser-bg': 'Strength',
};

const ASPECTS: Array<{ value: CropAspect; label: string }> = [
  { value: 'free', label: 'Free' },
  { value: 'original', label: 'Original ratio' },
  { value: '1:1', label: '1 : 1' },
  { value: '4:3', label: '4 : 3' },
  { value: '3:2', label: '3 : 2' },
  { value: '16:9', label: '16 : 9' },
];

/** Local/system font stacks only — no network dependencies. */
const FONTS: Array<{ value: string; label: string }> = [
  { value: 'sans-serif', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Mono' },
  { value: 'cursive', label: 'Cursive' },
  { value: 'fantasy', label: 'Display' },
];

const MODE_BUTTONS: Array<{ mode: SelectionMode; label: string; Icon: typeof SquareDashed }> = [
  { mode: 'new', label: 'New selection', Icon: SquareDashed },
  { mode: 'add', label: 'Add to selection', Icon: SquarePlus },
  { mode: 'subtract', label: 'Subtract from selection', Icon: SquareMinus },
  { mode: 'intersect', label: 'Intersect with selection', Icon: Copy },
];

/** Compact label + range + number control sized for the options bar. */
function InlineSlider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className={styles.slider} title={label}>
      <span className={styles.sliderLabel}>{label}</span>
      <input
        className={`pf-range ${styles.sliderRange}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={`${label} slider`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        className={`pf-input ${styles.sliderNumber}`}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => {
          const v = Number.parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
      />
      {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
    </label>
  );
}

/** Photoshop-style selection mode buttons (new / add / subtract / intersect). */
function SelectionModeButtons() {
  const mode = useEditorStore((s) => s.selectionMode);
  return (
    <div className={styles.segGroup} role="group" aria-label="Selection mode">
      {MODE_BUTTONS.map((m) => (
        <button
          key={m.mode}
          type="button"
          className={styles.segBtn}
          data-active={mode === m.mode}
          onClick={() => setState({ selectionMode: m.mode })}
          title={m.label}
          aria-label={m.label}
          aria-pressed={mode === m.mode}
        >
          <m.Icon size={14} strokeWidth={1.8} />
        </button>
      ))}
    </div>
  );
}

/** Small on/off toggle chip used for boolean tool options. */
function ToggleChip({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={styles.toggleChip}
      data-active={value}
      onClick={() => onChange(!value)}
      aria-pressed={value}
      title={`${label}: ${value ? 'on' : 'off'}`}
    >
      {label}
    </button>
  );
}

/**
 * Photoshop-style tool options bar: a horizontal strip under the top bar that
 * always shows the controls for the active tool. Controls re-animate on tool
 * changes so the switch feels alive.
 */
export function OptionsBar() {
  const tool = useEditorStore((s) => s.tool);
  const doc = useEditorStore((s) => s.doc);
  const brushSize = useEditorStore((s) => s.brushSize);
  const brushOpacity = useEditorStore((s) => s.brushOpacity);
  const brushHardness = useEditorStore((s) => s.brushHardness);
  const brushFlow = useEditorStore((s) => s.brushFlow);
  const brushSmoothing = useEditorStore((s) => s.brushSmoothing);
  const wandTolerance = useEditorStore((s) => s.wandTolerance);
  const edgeThreshold = useEditorStore((s) => s.edgeThreshold);
  const contiguous = useEditorStore((s) => s.contiguous);
  const antialias = useEditorStore((s) => s.antialias);
  const sampleAll = useEditorStore((s) => s.sampleAll);
  const featherPx = useEditorStore((s) => s.featherPx);
  const marqueeStyle = useEditorStore((s) => s.marqueeStyle);
  const ratioW = useEditorStore((s) => s.ratioW);
  const ratioH = useEditorStore((s) => s.ratioH);
  const fixedW = useEditorStore((s) => s.fixedW);
  const fixedH = useEditorStore((s) => s.fixedH);
  const toneRange = useEditorStore((s) => s.toneRange);
  const gradientStyle = useEditorStore((s) => s.gradientStyle);
  const gradientReverse = useEditorStore((s) => s.gradientReverse);
  const fillOpacity = useEditorStore((s) => s.fillOpacity);
  const shapeKind = useEditorStore((s) => s.shapeKind);
  const shapeStroke = useEditorStore((s) => s.shapeStroke);
  const textValue = useEditorStore((s) => s.textValue);
  const textSize = useEditorStore((s) => s.textSize);
  const textAlign = useEditorStore((s) => s.textAlign);
  const fontFamily = useEditorStore((s) => s.fontFamily);
  const eyedropperSize = useEditorStore((s) => s.eyedropperSize);
  const cloneAligned = useEditorStore((s) => s.cloneAligned);
  const cropRect = useEditorStore((s) => s.cropRect);
  const transform = useEditorStore((s) => s.transform);
  const cropAspect = useEditorStore((s) => s.cropAspect);
  const cloneOffset = useEditorStore((s) => s.cloneOffset);
  const hasSelection = useEditorStore((s) => s.selection !== null);
  const magneticWidth = useEditorStore((s) => s.magneticWidth);
  const magneticContrast = useEditorStore((s) => s.magneticContrast);
  const magneticFrequency = useEditorStore((s) => s.magneticFrequency);
  const spongeMode = useEditorStore((s) => s.spongeMode);
  const bgSampleMode = useEditorStore((s) => s.bgSampleMode);
  const moveAutoSelect = useEditorStore((s) => s.moveAutoSelect);
  const moveShowControls = useEditorStore((s) => s.moveShowControls);
  const polygonSides = useEditorStore((s) => s.polygonSides);
  const shapeCornerRadius = useEditorStore((s) => s.shapeCornerRadius);
  const zoom = useEditorStore((s) => s.viewport.zoom);

  const def = TOOL_BY_ID[tool];
  const isBrush = BRUSH_TOOLS.includes(tool);
  const isSelection = SELECTION_TOOLS.includes(tool);
  const noDoc = !doc;

  // A live Free Transform takes over the options bar with commit controls.
  if (transform) {
    return (
      <div className={styles.bar} role="toolbar" aria-label="Tool options" data-testid="options-bar">
        <span className={styles.toolBadge} data-testid="transform-badge">
          <Move size={15} strokeWidth={1.7} />
          <span className={styles.toolName}>Free Transform</span>
        </span>
        <div className={styles.divider} />
        <span className={styles.transformHint}>
          Drag handles to scale · Shift keeps ratio · Alt scales from centre · drag outside to
          rotate · Enter commits, Esc cancels
        </span>
        <div className={styles.controls}>
          <button
            type="button"
            className="pf-btn primary"
            data-testid="transform-commit"
            onClick={commitFreeTransform}
          >
            Commit
          </button>
          <button
            type="button"
            className="pf-btn"
            data-testid="transform-cancel"
            onClick={cancelFreeTransform}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.bar} role="toolbar" aria-label="Tool options" data-testid="options-bar">
      <span className={styles.toolBadge}>
        <def.Icon size={15} strokeWidth={1.7} />
        <span className={styles.toolName}>{def.label}</span>
        <kbd className="pf-kbd">{def.shortcut}</kbd>
      </span>
      <div className={styles.divider} />

      <div className={styles.controls} data-testid="options-controls" key={tool}>
        {isSelection && <SelectionModeButtons />}

        {isSelection && tool !== 'marquee-row' && tool !== 'marquee-col' && (
          <InlineSlider
            label="Feather"
            value={featherPx}
            min={0}
            max={40}
            suffix="px"
            onChange={(v) => setState({ featherPx: v })}
          />
        )}

        {(tool === 'marquee' || tool === 'marquee-ellipse') && (
          <>
            <label className={styles.selectRow}>
              <span className={styles.sliderLabel}>Style</span>
              <select
                className="pf-select"
                value={marqueeStyle}
                onChange={(e) => setState({ marqueeStyle: e.target.value as 'normal' | 'ratio' | 'fixed' })}
                aria-label="Marquee style"
              >
                <option value="normal">Normal</option>
                <option value="ratio">Fixed ratio</option>
                <option value="fixed">Fixed size</option>
              </select>
            </label>
            {marqueeStyle === 'ratio' && (
              <span className={styles.inlineFields}>
                <input
                  className={`pf-input ${styles.smallNum}`}
                  type="number"
                  min={1}
                  value={ratioW}
                  aria-label="Ratio width"
                  onChange={(e) => setState({ ratioW: Math.max(1, Number(e.target.value) || 1) })}
                />
                <span className={styles.suffix}>:</span>
                <input
                  className={`pf-input ${styles.smallNum}`}
                  type="number"
                  min={1}
                  value={ratioH}
                  aria-label="Ratio height"
                  onChange={(e) => setState({ ratioH: Math.max(1, Number(e.target.value) || 1) })}
                />
              </span>
            )}
            {marqueeStyle === 'fixed' && (
              <span className={styles.inlineFields}>
                <input
                  className={`pf-input ${styles.smallNum}`}
                  type="number"
                  min={1}
                  value={fixedW}
                  aria-label="Fixed width"
                  onChange={(e) => setState({ fixedW: Math.max(1, Number(e.target.value) || 1) })}
                />
                <span className={styles.suffix}>×</span>
                <input
                  className={`pf-input ${styles.smallNum}`}
                  type="number"
                  min={1}
                  value={fixedH}
                  aria-label="Fixed height"
                  onChange={(e) => setState({ fixedH: Math.max(1, Number(e.target.value) || 1) })}
                />
                <span className={styles.suffix}>px</span>
              </span>
            )}
          </>
        )}

        {isSelection && (
          <>
            <button className="pf-btn" disabled={noDoc} onClick={selectAll} title="Select the whole canvas (Ctrl+A)">
              All
            </button>
            <button className="pf-btn" disabled={noDoc || !hasSelection} onClick={deselect} title="Deselect (Ctrl+D)">
              Deselect
            </button>
            <button
              className="pf-btn"
              disabled={noDoc || !hasSelection}
              onClick={invertSelection}
              title="Invert the selection"
            >
              Inverse
            </button>
            <button
              className="pf-btn"
              disabled={noDoc || !hasSelection}
              onClick={featherActiveSelection}
              title="Soften the existing selection edge by 5 px"
            >
              Feather 5px
            </button>
          </>
        )}

        {TOLERANCE_TOOLS.includes(tool) && (
          <InlineSlider
            label="Tolerance"
            value={wandTolerance}
            min={0}
            max={100}
            onChange={setWandTolerance}
          />
        )}

        {tool === 'objectselect' && (
          <InlineSlider
            label="Edge"
            value={edgeThreshold}
            min={0}
            max={100}
            onChange={setEdgeThreshold}
          />
        )}

        {(tool === 'wand' ||
          tool === 'bucket' ||
          tool === 'eraser-magic' ||
          tool === 'eraser-bg') && (
          <ToggleChip label="Contiguous" value={contiguous} onChange={(v) => setState({ contiguous: v })} />
        )}

        {(tool === 'wand' || tool === 'quickselect' || tool === 'objectselect') && (
          <>
            <ToggleChip label="Anti-alias" value={antialias} onChange={(v) => setState({ antialias: v })} />
            <label className={styles.selectRow}>
              <span className={styles.sliderLabel}>Sample</span>
              <select
                className="pf-select"
                value={sampleAll ? 'all' : 'layer'}
                onChange={(e) => setState({ sampleAll: e.target.value === 'all' })}
                aria-label="Wand sample source"
              >
                <option value="layer">Current layer</option>
                <option value="all">All layers</option>
              </select>
            </label>
          </>
        )}

        {(tool === 'bucket' || tool === 'eraser-magic') && (
          <InlineSlider
            label="Opacity"
            value={fillOpacity}
            min={1}
            max={100}
            suffix="%"
            onChange={(v) => setState({ fillOpacity: v })}
          />
        )}

        {tool === 'eraser-bg' && (
          <label className={styles.selectRow}>
            <span className={styles.sliderLabel}>Sample</span>
            <select
              className="pf-select"
              value={bgSampleMode}
              onChange={(e) => setState({ bgSampleMode: e.target.value as 'continuous' | 'once' })}
              aria-label="Background eraser sampling"
            >
              <option value="continuous">Continuous</option>
              <option value="once">Once</option>
            </select>
          </label>
        )}

        {tool === 'sponge' && (
          <label className={styles.selectRow}>
            <span className={styles.sliderLabel}>Mode</span>
            <select
              className="pf-select"
              value={spongeMode}
              onChange={(e) => setState({ spongeMode: e.target.value as 'saturate' | 'desaturate' })}
              aria-label="Sponge mode"
            >
              <option value="saturate">Saturate</option>
              <option value="desaturate">Desaturate</option>
            </select>
          </label>
        )}

        {tool === 'lasso-magnetic' && (
          <>
            <InlineSlider
              label="Width"
              value={magneticWidth}
              min={1}
              max={64}
              suffix="px"
              onChange={(v) => setState({ magneticWidth: v })}
            />
            <InlineSlider
              label="Contrast"
              value={magneticContrast}
              min={0}
              max={100}
              onChange={(v) => setState({ magneticContrast: v })}
            />
            <InlineSlider
              label="Frequency"
              value={magneticFrequency}
              min={0}
              max={100}
              onChange={(v) => setState({ magneticFrequency: v })}
            />
          </>
        )}

        {tool === 'move' && (
          <>
            <ToggleChip
              label="Auto-Select"
              value={moveAutoSelect}
              onChange={(v) => setState({ moveAutoSelect: v })}
            />
            <ToggleChip
              label="Transform controls"
              value={moveShowControls}
              onChange={(v) => setState({ moveShowControls: v })}
            />
            <span className={styles.sliderLabel} aria-hidden="true">
              Align
            </span>
            <button
              className="pf-btn"
              aria-label="Align left"
              title="Line the layer's left edge up with the selection (or the canvas)"
              onClick={() => alignActiveLayer('left')}
            >
              <AlignStartVertical size={15} />
            </button>
            <button
              className="pf-btn"
              aria-label="Align horizontal centers"
              title="Center the layer horizontally in the selection (or the canvas)"
              onClick={() => alignActiveLayer('hcenter')}
            >
              <AlignCenterVertical size={15} />
            </button>
            <button
              className="pf-btn"
              aria-label="Align right"
              title="Line the layer's right edge up with the selection (or the canvas)"
              onClick={() => alignActiveLayer('right')}
            >
              <AlignEndVertical size={15} />
            </button>
            <button
              className="pf-btn"
              aria-label="Align top"
              title="Line the layer's top edge up with the selection (or the canvas)"
              onClick={() => alignActiveLayer('top')}
            >
              <AlignStartHorizontal size={15} />
            </button>
            <button
              className="pf-btn"
              aria-label="Align vertical centers"
              title="Center the layer vertically in the selection (or the canvas)"
              onClick={() => alignActiveLayer('vcenter')}
            >
              <AlignCenterHorizontal size={15} />
            </button>
            <button
              className="pf-btn"
              aria-label="Align bottom"
              title="Line the layer's bottom edge up with the selection (or the canvas)"
              onClick={() => alignActiveLayer('bottom')}
            >
              <AlignEndHorizontal size={15} />
            </button>
          </>
        )}

        {tool === 'zoom' && (
          <>
            <span className={styles.readout} aria-label="Current zoom">
              {Math.round(zoom * 100)}%
            </span>
            <button className="pf-btn" onClick={fitToScreen} title="Fit the image in the window (0)">
              Fit
            </button>
            <button className="pf-btn" onClick={() => zoomToPercent(100)} title="Zoom to 100% (1)">
              100%
            </button>
            <button className="pf-btn" onClick={() => zoomToPercent(200)} title="Zoom to 200%">
              200%
            </button>
          </>
        )}

        {tool === 'crop' && (
          <>
            <label className={styles.selectRow}>
              <span className={styles.sliderLabel}>Aspect</span>
              <select
                className="pf-select"
                value={cropAspect}
                onChange={(e) => setState({ cropAspect: e.target.value as CropAspect })}
                aria-label="Crop aspect ratio"
              >
                {ASPECTS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <span className={styles.readout}>
              {cropRect
                ? `${Math.round(cropRect.width)} × ${Math.round(cropRect.height)} px`
                : '— drag a crop area on the canvas'}
            </span>
            <button
              className="pf-btn primary"
              disabled={!cropRect}
              onClick={() => cropRect && cropActiveDocument(cropRect)}
              title="Apply crop (Enter)"
            >
              <Check size={13} /> Apply
            </button>
            <button
              className="pf-btn"
              disabled={!cropRect}
              onClick={() => setCropRect(null)}
              title="Cancel crop (Esc)"
            >
              <X size={13} /> Cancel
            </button>
          </>
        )}

        {isBrush && (
          <>
            <InlineSlider
              label="Size"
              value={brushSize}
              min={1}
              max={400}
              suffix="px"
              onChange={setBrushSize}
            />
            <InlineSlider
              label={STRENGTH_LABEL[tool] ?? 'Opacity'}
              value={brushOpacity}
              min={1}
              max={100}
              suffix="%"
              onChange={setBrushOpacity}
            />
            {HARDNESS_TOOLS.includes(tool) && (
              <>
                <InlineSlider
                  label="Hardness"
                  value={brushHardness}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={(v) => setState({ brushHardness: v })}
                />
                {tool !== 'healing' && (
                  <InlineSlider
                    label="Flow"
                    value={brushFlow}
                    min={1}
                    max={100}
                    suffix="%"
                    onChange={(v) => setState({ brushFlow: v })}
                  />
                )}
              </>
            )}
            {(tool === 'brush' || tool === 'pencil' || tool === 'eraser') && (
              <InlineSlider
                label="Smoothing"
                value={brushSmoothing}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => setState({ brushSmoothing: v })}
              />
            )}
            {(tool === 'dodge' || tool === 'burn') && (
              <label className={styles.selectRow}>
                <span className={styles.sliderLabel}>Range</span>
                <select
                  className="pf-select"
                  value={toneRange}
                  onChange={(e) => setState({ toneRange: e.target.value as 'shadows' | 'midtones' | 'highlights' })}
                  aria-label="Tonal range"
                >
                  <option value="shadows">Shadows</option>
                  <option value="midtones">Midtones</option>
                  <option value="highlights">Highlights</option>
                </select>
              </label>
            )}
            {(tool === 'clone' || tool === 'healing') && (
              <>
                <ToggleChip
                  label="Aligned"
                  value={cloneAligned}
                  onChange={(v) => setState({ cloneAligned: v, cloneStrokeOffset: null })}
                />
                <ToggleChip
                  label="All layers"
                  value={sampleAll}
                  onChange={(v) => setState({ sampleAll: v })}
                />
                <span className={styles.readout} data-testid="clone-source">
                  {cloneOffset
                    ? `Source ${Math.round(cloneOffset.x)}, ${Math.round(cloneOffset.y)} — Alt-click to move`
                    : 'Alt-click to set the sample source'}
                </span>
              </>
            )}
          </>
        )}

        {tool === 'gradient' && (
          <>
            <label className={styles.selectRow}>
              <span className={styles.sliderLabel}>Shape</span>
              <select
                className="pf-select"
                value={gradientStyle}
                onChange={(e) =>
                  setState({
                    gradientStyle: e.target.value as 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond',
                  })
                }
                aria-label="Gradient shape"
              >
                <option value="linear">Linear</option>
                <option value="radial">Radial</option>
                <option value="angle">Angle</option>
                <option value="reflected">Reflected</option>
                <option value="diamond">Diamond</option>
              </select>
            </label>
            <ToggleChip
              label="Reverse"
              value={gradientReverse}
              onChange={(v) => setState({ gradientReverse: v })}
            />
          </>
        )}

        {tool === 'shape' && (
          <label className={styles.selectRow}>
            <span className={styles.sliderLabel}>Kind</span>
            <select
              className="pf-select"
              value={shapeKind}
              onChange={(e) => setShapeKind(e.target.value as 'rect' | 'ellipse')}
              aria-label="Shape kind"
            >
              <option value="rect">Rectangle</option>
              <option value="ellipse">Ellipse</option>
            </select>
          </label>
        )}

        {tool === 'shape-round' && (
          <InlineSlider
            label="Corner radius"
            value={shapeCornerRadius}
            min={0}
            max={100}
            suffix="px"
            onChange={(v) => setState({ shapeCornerRadius: v })}
          />
        )}

        {tool === 'shape-poly' && (
          <InlineSlider
            label="Sides"
            value={polygonSides}
            min={3}
            max={12}
            onChange={(v) => setState({ polygonSides: v })}
          />
        )}

        {(tool === 'shape' ||
          tool === 'shape-round' ||
          tool === 'shape-ellipse' ||
          tool === 'shape-poly') && (
          <InlineSlider
            label="Stroke"
            value={shapeStroke}
            min={0}
            max={40}
            suffix="px"
            onChange={(v) => setState({ shapeStroke: v })}
          />
        )}

        {tool === 'shape-line' && (
          <InlineSlider
            label="Weight"
            value={shapeStroke}
            min={0}
            max={40}
            suffix="px"
            onChange={(v) => setState({ shapeStroke: v })}
          />
        )}

        {tool === 'text' && (
          <>
            <input
              className={`pf-input ${styles.textInput}`}
              type="text"
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder="Type, then click the canvas…"
              aria-label="Text content"
            />
            <InlineSlider
              label="Size"
              value={textSize}
              min={6}
              max={400}
              suffix="px"
              onChange={setTextSize}
            />
            <label className={styles.selectRow}>
              <span className={styles.sliderLabel}>Font</span>
              <select
                className="pf-select"
                value={fontFamily}
                onChange={(e) => setState({ fontFamily: e.target.value })}
                aria-label="Font family"
              >
                {FONTS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.segGroup} role="group" aria-label="Text alignment">
              {(['left', 'center', 'right'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  className={styles.segBtn}
                  data-active={textAlign === a}
                  onClick={() => setState({ textAlign: a })}
                  title={`Align ${a}`}
                  aria-label={`Align ${a}`}
                  aria-pressed={textAlign === a}
                >
                  {a === 'left' ? '⟸' : a === 'center' ? '↔' : '⟹'}
                </button>
              ))}
            </div>
          </>
        )}

        {tool === 'eyedropper' && (
          <label className={styles.selectRow}>
            <span className={styles.sliderLabel}>Sample</span>
            <select
              className="pf-select"
              value={String(eyedropperSize)}
              onChange={(e) => setState({ eyedropperSize: Number(e.target.value) as 1 | 3 | 5 })}
              aria-label="Eyedropper sample size"
            >
              <option value="1">Point sample</option>
              <option value="3">3 × 3 average</option>
              <option value="5">5 × 5 average</option>
            </select>
          </label>
        )}
      </div>

      <span className={styles.hint} title={TOOL_HINTS[tool]}>
        {TOOL_HINTS[tool]}
      </span>
    </div>
  );
}
