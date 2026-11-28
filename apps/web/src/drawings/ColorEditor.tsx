import { type DrawingLineStyle, LINE_STYLES, LINE_WIDTHS } from '@tradingnerd/core';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { joinColor, PALETTE, splitColor } from './color';
import styles from './Drawings.module.css';

const STYLE_NAMES: Record<DrawingLineStyle, string> = {
  solid: 'Solid',
  dashed: 'Dashed',
  dotted: 'Dotted',
};

export interface LineChoice {
  width: number;
  lineStyle: DrawingLineStyle;
  onWidth(width: number): void;
  onStyle(style: DrawingLineStyle): void;
}

/**
 * A drawing's color editor: the palette, a color of one's own, its opacity, and for a line its
 * thickness and style. TradingView's own picker isn't measured yet (provisional, §11). Escape
 * and a press outside it close it.
 */
export function ColorEditor({
  label,
  color,
  onChange,
  line,
  onClose,
  style,
}: {
  label: string;
  color: string;
  onChange(color: string): void;
  line?: LineChoice | undefined;
  onClose(): void;
  style?: CSSProperties;
}) {
  const box = useRef<HTMLFieldSetElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const { hex, opacity } = splitColor(color);
  const percent = Math.round(opacity * 100);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      // The button that opened it toggles it itself.
      if (box.current?.contains(target) || target.closest?.('[data-color-opener]')) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The editor closes; a dialog under it stays.
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  return (
    <fieldset ref={box} className={styles.editor} aria-label={label} style={style}>
      <div className={styles.palette}>
        {PALETTE.flat().map((choice) => (
          <button
            key={choice}
            type="button"
            className={styles.paletteColor}
            style={{ background: choice }}
            aria-label={choice}
            aria-pressed={choice === hex}
            onClick={() => onChange(joinColor(choice, opacity))}
          />
        ))}
      </div>
      <label className={styles.editorRow}>
        <span>Color</span>
        <input
          type="color"
          className={styles.colorInput}
          value={hex.toLowerCase()}
          onChange={(event) => onChange(joinColor(event.target.value, opacity))}
        />
      </label>
      <label className={styles.editorRow}>
        <span>Opacity</span>
        <input
          type="range"
          className={styles.range}
          min={0}
          max={100}
          value={percent}
          aria-label="Opacity"
          onChange={(event) => onChange(joinColor(hex, Number(event.target.value) / 100))}
        />
        <output className={styles.percent}>{percent}%</output>
      </label>
      {line && (
        <>
          <div className={styles.editorRow}>
            <span>Thickness</span>
            <LineWidths width={line.width} onWidth={line.onWidth} />
          </div>
          <div className={styles.editorRow}>
            <span>Style</span>
            <LineStyles lineStyle={line.lineStyle} onStyle={line.onStyle} />
          </div>
        </>
      )}
    </fieldset>
  );
}

export function LineWidths({ width, onWidth }: { width: number; onWidth(width: number): void }) {
  return (
    <fieldset className={styles.choices} aria-label="Thickness">
      {LINE_WIDTHS.map((choice) => (
        <button
          key={choice}
          type="button"
          className={styles.choice}
          aria-label={`${choice}px`}
          aria-pressed={width === choice}
          onClick={() => onWidth(choice)}
        >
          {choice}px
        </button>
      ))}
    </fieldset>
  );
}

export function LineStyles({
  lineStyle,
  onStyle,
}: {
  lineStyle: DrawingLineStyle;
  onStyle(style: DrawingLineStyle): void;
}) {
  return (
    <fieldset className={styles.choices} aria-label="Line style">
      {LINE_STYLES.map((choice) => (
        <button
          key={choice}
          type="button"
          className={styles.choice}
          aria-label={STYLE_NAMES[choice]}
          title={STYLE_NAMES[choice]}
          aria-pressed={lineStyle === choice}
          onClick={() => onStyle(choice)}
        >
          <svg width="22" height="4" viewBox="0 0 22 4" aria-hidden>
            <path
              d="M1 2h20"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={
                choice === 'dashed' ? '5 3' : choice === 'dotted' ? '2 2' : undefined
              }
            />
          </svg>
        </button>
      ))}
    </fieldset>
  );
}

/** A color swatch in a dialog's row, opening the editor under it. */
export function ColorField({
  label,
  color,
  onChange,
  line,
  mixed = false,
}: {
  label: string;
  color: string;
  onChange(color: string): void;
  line?: LineChoice | undefined;
  /**
   * Several drawings' colors that differ: a rainbow, as TradingView's swatch for them (its Help
   * Center GIFs, 43000660419, November 2024; D3c2). The editor starts from the first's.
   */
  mixed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { opacity } = splitColor(color);
  return (
    <div className={styles.swatchBox}>
      <button
        type="button"
        className={styles.swatch}
        data-color-opener
        data-mixed={mixed || undefined}
        aria-label={
          mixed
            ? `${label}: mixed`
            : `${label}: ${splitColor(color).hex}, ${Math.round(opacity * 100)}% opacity`
        }
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span
          className={mixed ? styles.swatchMixed : styles.swatchColor}
          style={mixed ? undefined : { background: color }}
        />
      </button>
      {open && (
        <ColorEditor
          label={label}
          color={color}
          onChange={onChange}
          line={line}
          onClose={() => setOpen(false)}
          style={{ top: 40, right: 0 }}
        />
      )}
    </div>
  );
}
