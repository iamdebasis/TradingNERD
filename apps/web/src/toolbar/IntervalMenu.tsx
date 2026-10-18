import type { IntervalSection } from '@tradingnerd/core';
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './IntervalMenu.module.css';
import { CaretIcon, CloseIcon, PlusIcon, StarIcon } from './icons';
import type { MenuSection } from './intervalPrefs';

export interface IntervalMenuProps {
  /** The ⌄ button the menu hangs from. */
  anchor: RefObject<HTMLElement | null>;
  sections: MenuSection[];
  /** The chart's interval. */
  current: string;
  onSelect(interval: string): void;
  onToggleFavorite(interval: string): void;
  onToggleSection(section: IntervalSection): void;
  onRemove(interval: string): void;
  onAddCustom(): void;
  onClose(): void;
}

interface Placement {
  left: number;
  top: number;
  height: number;
}

/** Gap kept between the menu and the window's right edge. */
const EDGE = 4;

/**
 * TradingView's interval menu (docs/reference/03-interval-menu.png): "Add custom interval…",
 * then collapsible sections of intervals with a favorite star each. It opens under the
 * toolbar; when it is taller than the window it spans the window's height and scrolls, with a
 * thin overlay scrollbar like TradingView's.
 */
export function IntervalMenu(props: IntervalMenuProps) {
  const { anchor, sections, current, onClose } = props;
  const menu = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);

  const updateThumb = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const { scrollTop, scrollHeight, clientHeight } = element;
    if (scrollHeight <= clientHeight + 1) {
      setThumb(null);
      return;
    }
    const height = Math.max(24, (clientHeight * clientHeight) / scrollHeight);
    const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height);
    setThumb({ top, height });
  }, []);

  // Place under the toolbar, or as high as needed to fit, and never taller than the window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sections change the content height
  useLayoutEffect(() => {
    const place = () => {
      const button = anchor.current?.getBoundingClientRect();
      const content = scroller.current?.scrollHeight;
      const width = menu.current?.offsetWidth ?? 0;
      if (!button || content === undefined) return;
      const height = Math.min(content, window.innerHeight);
      const top = Math.max(0, Math.min(button.bottom + 2, window.innerHeight - height));
      const left = Math.max(0, Math.min(button.left, window.innerWidth - width - EDGE));
      setPlacement({ left, top, height });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, sections]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure once placed or resized
  useLayoutEffect(updateThumb, [placement, updateThumb]);

  // Close on a press outside (the ⌄ button toggles on its own) and on Escape.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchor, onClose]);

  // ↑/↓ move between the menu's main buttons.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : index + step;
    items[(next + items.length) % items.length]?.focus();
  };

  return createPortal(
    <section
      ref={menu}
      className={styles.menu}
      aria-label="Interval menu"
      style={
        placement
          ? { left: placement.left, top: placement.top, height: placement.height }
          : { visibility: 'hidden' }
      }
      onKeyDown={onKeyDown}
    >
      <div ref={scroller} className={styles.scroller} onScroll={updateThumb}>
        <button type="button" className={styles.add} data-nav onClick={props.onAddCustom}>
          <PlusIcon />
          <span>Add custom interval…</span>
        </button>
        {sections.map((section) => (
          <div key={section.section} className={styles.section}>
            <div className={styles.divider} />
            <button
              type="button"
              className={styles.header}
              data-nav
              aria-expanded={!section.collapsed}
              onClick={() => props.onToggleSection(section.section)}
            >
              <span>{section.title}</span>
              <CaretIcon open={!section.collapsed} />
            </button>
            {!section.collapsed &&
              section.items.map((item) => (
                <div
                  key={item.interval}
                  className={styles.row}
                  data-active={item.interval === current}
                  data-favorite={item.favorite}
                >
                  <button
                    type="button"
                    className={styles.choose}
                    data-nav
                    aria-current={item.interval === current ? 'true' : undefined}
                    onClick={() => props.onSelect(item.interval)}
                  >
                    {item.label}
                  </button>
                  {item.custom && (
                    <button
                      type="button"
                      className={styles.remove}
                      aria-label={`Remove ${item.label}`}
                      onClick={() => props.onRemove(item.interval)}
                    >
                      <CloseIcon />
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.star}
                    aria-pressed={item.favorite}
                    aria-label={`Favorite ${item.label}`}
                    onClick={() => props.onToggleFavorite(item.interval)}
                  >
                    <StarIcon filled={item.favorite} />
                  </button>
                </div>
              ))}
          </div>
        ))}
      </div>
      {thumb && <div className={styles.thumb} style={{ top: thumb.top, height: thumb.height }} />}
    </section>,
    document.body,
  );
}
