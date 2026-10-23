import { useState } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { Section } from './Section';
import { Slider } from '../ui/Slider';
import { ColorWheel } from './grading/ColorWheel';
import { CurveEditor } from './grading/CurveEditor';
import { GradeScope } from './grading/GradeScope';
import { Histogram } from './grading/Histogram';
import { GRADE_PRESETS } from './grading/gradePresets';
import styles from './AdjustmentsPanel.module.css';
import {
  applyAuto,
  applyGradePreset,
  applyPendingAdjustments,
  cancelPendingAdjustments,
  resetAdjustments,
  setAdjustment,
} from '../../app/actions';
import { GRADIENT_MAPS, isIdentityAdjustment } from '../../imaging/adjustments';
import { getLayer } from '../../core/document/ops';
import { useEditorStore } from '../../app/editorStore';

type GradeStyle = 'davinci' | 'photoshop';

const STYLE_KEY = 'pf-grade-style';

function loadGradeStyle(): GradeStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === 'photoshop' ? 'photoshop' : 'davinci';
  } catch {
    return 'davinci';
  }
}

/**
 * Photoshop-style slider grader: the classic tone/color/effect groups.
 * Shared by both grader styles for the pending-adjustment footer actions.
 */
function SliderGrader({ disabled, effects = true }: { disabled: boolean; effects?: boolean }) {
  const adj = useEditorStore((s) => s.adjustments);
  return (
    <fieldset className={styles.fieldset} disabled={disabled}>
      <legend className="pf-label">Tone</legend>
      <Slider label="Exposure" value={adj.exposure} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('exposure', v)} />
      <Slider label="Brightness" value={adj.brightness} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('brightness', v)} />
      <Slider label="Contrast" value={adj.contrast} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('contrast', v)} />
      <Slider label="Highlights" value={adj.highlights} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('highlights', v)} />
      <Slider label="Shadows" value={adj.shadows} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('shadows', v)} />

      <legend className={`pf-label ${styles.legendGap}`}>Color</legend>
      <Slider label="Temperature" value={adj.temperature} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('temperature', v)} />
      <Slider label="Tint" value={adj.tint} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('tint', v)} />
      <Slider label="Hue" value={adj.hue} min={-180} max={180} defaultValue={0} suffix="°" onChange={(v) => setAdjustment('hue', v)} />
      <Slider label="Saturation" value={adj.saturation} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('saturation', v)} />

      {effects ? (
        <>
          <legend className={`pf-label ${styles.legendGap}`}>Effects</legend>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={adj.grayscale}
              onChange={(e) => setAdjustment('grayscale', e.target.checked)}
            />
            Black &amp; White (grayscale)
          </label>
          <Slider label="Sepia" value={adj.sepia} min={0} max={100} defaultValue={0} onChange={(v) => setAdjustment('sepia', v)} />
          <Slider label="Blur" value={adj.blurRadius} min={0} max={50} step={0.5} precision={1} defaultValue={0} suffix="px" onChange={(v) => setAdjustment('blurRadius', v)} />
          <Slider label="Sharpen" value={adj.sharpenAmount} min={0} max={200} defaultValue={0} onChange={(v) => setAdjustment('sharpenAmount', v)} />
          <StylizeControls />
        </>
      ) : null}
    </fieldset>
  );
}

/** Shared stylization controls (both grader styles): gradient map, photo
 *  filter, threshold and posterize — LUT-based effects in the live pipeline. */
function StylizeControls() {
  const adj = useEditorStore((s) => s.adjustments);
  return (
    <>
      <label className={styles.selectRow}>
        <span>Gradient Map</span>
        <select
          className="pf-select"
          value={adj.gradientMap}
          onChange={(e) => setAdjustment('gradientMap', e.target.value)}
          aria-label="Gradient map"
        >
          <option value="">Off</option>
          {Object.entries(GRADIENT_MAPS).map(([id, def]) => (
            <option key={id} value={id}>
              {def.name}
            </option>
          ))}
        </select>
      </label>
      {adj.gradientMap ? (
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={adj.gradientMapReverse}
            onChange={(e) => setAdjustment('gradientMapReverse', e.target.checked)}
          />
          Reverse ramp
        </label>
      ) : null}
      <label className={styles.selectRow}>
        <span>Photo Filter</span>
        <select
          className="pf-select"
          value={adj.photoFilter}
          onChange={(e) => setAdjustment('photoFilter', e.target.value)}
          aria-label="Photo filter"
        >
          <option value="">Off</option>
          <option value="warming">Warming</option>
          <option value="cooling">Cooling</option>
        </select>
      </label>
      {adj.photoFilter ? (
        <Slider
          label="Filter Density"
          value={adj.photoFilterDensity}
          min={1}
          max={100}
          defaultValue={50}
          onChange={(v) => setAdjustment('photoFilterDensity', v)}
        />
      ) : null}
      <Slider label="Threshold" value={adj.threshold} min={0} max={255} defaultValue={0} onChange={(v) => setAdjustment('threshold', v)} />
      <Slider label="Posterize" value={adj.posterize} min={0} max={64} defaultValue={0} onChange={(v) => setAdjustment('posterize', v)} />
    </>
  );
}

/** One-click histogram-based corrections (Auto Tone / Contrast / Color). */
function AutoRow({ disabled }: { disabled: boolean }) {
  return (
    <div className={styles.autoRow} role="group" aria-label="Auto corrections">
      <button
        type="button"
        className="pf-btn"
        disabled={disabled}
        title="Per-channel black/white point stretch — evens exposure and removes casts"
        data-testid="auto-tone"
        onClick={() => applyAuto('tone')}
      >
        Auto Tone
      </button>
      <button
        type="button"
        className="pf-btn"
        disabled={disabled}
        title="One luma-derived stretch across all channels — contrast without a cast shift"
        data-testid="auto-contrast"
        onClick={() => applyAuto('contrast')}
      >
        Auto Contrast
      </button>
      <button
        type="button"
        className="pf-btn"
        disabled={disabled}
        title="Per-channel stretch with a mid-tone neutralize"
        data-testid="auto-color"
        onClick={() => applyAuto('color')}
      >
        Auto Color
      </button>
    </div>
  );
}

/**
 * DaVinci-style grader: live RGB parade scope, three lift/gamma/gain
 * trackball wheels with neutral masters, primaries trim sliders and a
 * one-click look gallery.
 */
function DavinciGrader({ disabled }: { disabled: boolean }) {
  const adj = useEditorStore((s) => s.adjustments);
  return (
    <fieldset className={styles.fieldset} disabled={disabled}>
      <GradeScope />
      <Histogram />
      <AutoRow disabled={disabled} />

      <div className={styles.wheels}>
        <ColorWheel
          label="Lift"
          x={adj.liftX}
          y={adj.liftY}
          onChange={(x, y) => {
            setAdjustment('liftX', x);
            setAdjustment('liftY', y);
          }}
          onReset={() => {
            setAdjustment('liftX', 0);
            setAdjustment('liftY', 0);
          }}
        />
        <ColorWheel
          label="Gamma"
          x={adj.gammaX}
          y={adj.gammaY}
          onChange={(x, y) => {
            setAdjustment('gammaX', x);
            setAdjustment('gammaY', y);
          }}
          onReset={() => {
            setAdjustment('gammaX', 0);
            setAdjustment('gammaY', 0);
          }}
        />
        <ColorWheel
          label="Gain"
          x={adj.gainX}
          y={adj.gainY}
          onChange={(x, y) => {
            setAdjustment('gainX', x);
            setAdjustment('gainY', y);
          }}
          onReset={() => {
            setAdjustment('gainX', 0);
            setAdjustment('gainY', 0);
          }}
        />
      </div>

      <legend className={`pf-label ${styles.legendGap}`}>Master</legend>
      <Slider label="Lift" value={adj.liftM} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('liftM', v)} />
      <Slider label="Gamma" value={adj.gammaM} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('gammaM', v)} />
      <Slider label="Gain" value={adj.gainM} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('gainM', v)} />

      <legend className={`pf-label ${styles.legendGap}`}>Curves</legend>
      <CurveEditor disabled={disabled} />

      <legend className={`pf-label ${styles.legendGap}`}>Primaries</legend>
      <Slider label="Exposure" value={adj.exposure} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('exposure', v)} />
      <Slider label="Contrast" value={adj.contrast} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('contrast', v)} />
      <Slider label="Highlights" value={adj.highlights} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('highlights', v)} />
      <Slider label="Shadows" value={adj.shadows} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('shadows', v)} />
      <Slider label="Temperature" value={adj.temperature} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('temperature', v)} />
      <Slider label="Tint" value={adj.tint} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('tint', v)} />
      <Slider label="Saturation" value={adj.saturation} min={-100} max={100} defaultValue={0} onChange={(v) => setAdjustment('saturation', v)} />

      <legend className={`pf-label ${styles.legendGap}`}>Stylize</legend>
      <StylizeControls />

      <legend className={`pf-label ${styles.legendGap}`}>Looks</legend>
      <div className={styles.presets}>
        {GRADE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={styles.preset}
            title={preset.blurb}
            onClick={() => applyGradePreset(preset.grade, preset.name)}
          >
            {preset.name}
          </button>
        ))}
      </div>
      <p className={styles.note}>Effects (B&amp;W, Sepia, Blur, Sharpen) live in the Beginner style.</p>
    </fieldset>
  );
}

export function AdjustmentsPanel() {
  const doc = useEditorStore((s) => s.doc);
  const adj = useEditorStore((s) => s.adjustments);
  const adjustmentsLayerId = useEditorStore((s) => s.adjustmentsLayerId);
  const [style, setStyle] = useState<GradeStyle>(loadGradeStyle);
  const targetId = adjustmentsLayerId ?? doc?.activeLayerId ?? null;
  const targetLayer = doc && targetId ? getLayer(doc, targetId) : null;
  const targetName = targetLayer?.name ?? '—';
  const modified = !isIdentityAdjustment(adj);
  const disabled = !doc;

  const pickStyle = (s: GradeStyle) => {
    setStyle(s);
    try {
      localStorage.setItem(STYLE_KEY, s);
    } catch {
      /* storage may be unavailable — the choice simply won't persist */
    }
  };

  return (
    <Section
      title="Color Grading"
      actions={
        <span className={styles.badge} title={`Adjustments target layer "${targetName}"`}>
          {targetName}
        </span>
      }
    >
      <div className={styles.styleSwitch} role="group" aria-label="Color grader style">
        <button
          type="button"
          className={style === 'photoshop' ? styles.styleActive : styles.styleBtn}
          aria-pressed={style === 'photoshop'}
          title="Beginner: simple sliders"
          onClick={() => pickStyle('photoshop')}
        >
          Beginner
        </button>
        <button
          type="button"
          className={style === 'davinci' ? styles.styleActive : styles.styleBtn}
          aria-pressed={style === 'davinci'}
          title="Pro: wheels, scope and cinematic looks"
          onClick={() => pickStyle('davinci')}
        >
          Pro
        </button>
      </div>

      {style === 'davinci' ? (
        <DavinciGrader disabled={disabled} />
      ) : (
        <SliderGrader disabled={disabled} effects />
      )}

      <div className={styles.actions}>
        <button
          className="pf-btn primary"
          disabled={!doc || !modified}
          onClick={() => void applyPendingAdjustments()}
          title="Compute at full resolution and add to history"
        >
          <Check size={13} /> Apply
        </button>
        <button
          className="pf-btn"
          disabled={!doc || !modified}
          onClick={cancelPendingAdjustments}
          title="Discard the preview (Esc)"
        >
          <X size={13} /> Cancel
        </button>
        <button
          className="pf-btn ghost"
          disabled={!doc || !modified}
          onClick={resetAdjustments}
          title="Reset all sliders and wheels to zero"
        >
          <RotateCcw size={13} /> Reset
        </button>
      </div>
      <p className={styles.note}>
        The preview renders at reduced resolution; <strong>Apply</strong> reprocesses the layer at
        full resolution ({doc ? `${doc.width}×${doc.height}` : '—'}).
      </p>
    </Section>
  );
}
