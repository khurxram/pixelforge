import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, Plus, Copy, Trash } from 'lucide-react';
import { Section } from './Section';
import { Slider } from '../ui/Slider';
import styles from './LayersPanel.module.css';
import {
  addBlankLayer,
  deleteActiveLayer,
  duplicateActiveLayer,
  moveLayer,
  renameLayer,
  setActiveLayer,
  setLayerBlendMode,
  setLayerOpacity,
  setLayerVisibility,
} from '../../app/actions';
import { BLEND_MODES, type BlendMode, type PixelBuffer } from '../../core/document/types';
import { useEditorStore } from '../../app/editorStore';

/** Small layer thumbnail with checkerboard. */
function LayerThumb({ pixels, size = 34 }: { pixels: PixelBuffer; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    // checkerboard
    const s = 5;
    for (let y = 0; y < size; y += s) {
      for (let x = 0; x < size; x += s) {
        ctx.fillStyle = ((x / s + y / s) | 0) % 2 === 0 ? '#ffffff' : '#e6dfd8';
        ctx.fillRect(x, y, s, s);
      }
    }
    if (pixels.width < 1 || pixels.height < 1) return;
    const src = document.createElement('canvas');
    src.width = pixels.width;
    src.height = pixels.height;
    const sctx = src.getContext('2d');
    if (!sctx) return;
    sctx.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
    const scale = Math.min(size / pixels.width, size / pixels.height);
    const w = pixels.width * scale;
    const h = pixels.height * scale;
    ctx.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
  }, [pixels, size]);
  return <canvas ref={ref} width={size} height={size} className={styles.thumb} aria-hidden="true" />;
}

export function LayersPanel() {
  const doc = useEditorStore((s) => s.doc);
  const activeLayerId = useEditorStore((s) => s.doc?.activeLayerId ?? null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const activeLayer = doc?.layers.find((l) => l.id === activeLayerId) ?? null;

  if (!doc) {
    return (
      <Section title="Layers">
        <p className={styles.emptyHint}>No document open.</p>
      </Section>
    );
  }

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
  };

  const commitRename = () => {
    if (editingId) renameLayer(editingId, editName);
    setEditingId(null);
  };

  // Display top-first, matching professional editors.
  const rows = [...doc.layers].reverse();

  return (
    <Section
      title="Layers"
      actions={
        <>
          <button
            type="button"
            className={styles.miniBtn}
            onClick={addBlankLayer}
            title="New transparent layer"
            aria-label="New layer"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            className={styles.miniBtn}
            onClick={duplicateActiveLayer}
            disabled={!activeLayerId}
            title="Duplicate active layer"
            aria-label="Duplicate layer"
          >
            <Copy size={12} />
          </button>
          <button
            type="button"
            className={styles.miniBtn}
            onClick={deleteActiveLayer}
            disabled={!activeLayerId || doc.layers.length <= 1}
            title="Delete active layer"
            aria-label="Delete layer"
          >
            <Trash size={12} />
          </button>
        </>
      }
    >
      <ul className={styles.list} role="listbox" aria-label="Layer stack">
        {rows.map((layer) => {
          const isActive = layer.id === activeLayerId;
          const orderIndex = doc.layers.findIndex((l) => l.id === layer.id);
          return (
            <li
              key={layer.id}
              className={`${styles.row} ${isActive ? styles.active : ''}`}
              role="option"
              aria-selected={isActive}
              onClick={() => setActiveLayer(layer.id)}
              onDoubleClick={() => startRename(layer.id, layer.name)}
            >
              <button
                type="button"
                className={styles.eye}
                onClick={(e) => {
                  e.stopPropagation();
                  setLayerVisibility(layer.id, !layer.visible);
                }}
                title={layer.visible ? 'Hide layer' : 'Show layer'}
                aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
              >
                {layer.visible ? <Eye size={13} /> : <EyeOff size={13} className={styles.muted} />}
              </button>

              <LayerThumb pixels={layer.pixels} />

              <div className={styles.meta}>
                {editingId === layer.id ? (
                  <input
                    className={`pf-input ${styles.nameInput}`}
                    value={editName}
                    autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setEditingId(null);
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Layer name"
                  />
                ) : (
                  <span className={styles.name} title={`${layer.name} — double-click to rename`}>
                    {layer.name}
                  </span>
                )}
                <span className={styles.subMeta}>
                  {Math.round(layer.opacity * 100)}% · {layer.blendMode}
                </span>
              </div>

              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.miniBtn}
                  disabled={orderIndex === doc.layers.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveLayer(layer.id, 'up');
                  }}
                  title="Move layer up"
                  aria-label="Move layer up"
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  type="button"
                  className={styles.miniBtn}
                  disabled={orderIndex === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveLayer(layer.id, 'down');
                  }}
                  title="Move layer down"
                  aria-label="Move layer down"
                >
                  <ChevronDown size={12} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className={styles.controls}>
        <Slider
          label="Opacity"
          value={Math.round((activeLayer?.opacity ?? 1) * 100)}
          min={0}
          max={100}
          defaultValue={100}
          suffix="%"
          disabled={!activeLayer}
          onChange={(v) => activeLayer && setLayerOpacity(activeLayer.id, v / 100)}
        />
        <label className={styles.blendRow}>
          <span className="pf-label">Blend</span>
          <select
            className="pf-select"
            value={activeLayer?.blendMode ?? 'normal'}
            disabled={!activeLayer}
            onChange={(e) =>
              activeLayer && setLayerBlendMode(activeLayer.id, e.target.value as BlendMode)
            }
            aria-label="Layer blend mode"
          >
            {BLEND_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Section>
  );
}
