import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon } from '../toolbar/icons';
import styles from './Dropdown.module.css';

export interface DropdownOption {
  value: string;
  label: string;
}

/**
 * A settings field's drop-down, as in TradingView's Chart settings: the chosen option in a
 * bordered box with a chevron, and under it a list of options in the menus' style. Arrow
 * keys, Enter and Escape work in the list; a press outside it closes it.
 */
export function Dropdown({
  label,
  value,
  options,
  onChange,
}: {
  /** The field's name, for screen readers. */
  label: string;
  value: string;
  options: readonly DropdownOption[];
  onChange(value: string): void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 0 });
  const chosen = options.find((option) => option.value === value);

  useLayoutEffect(() => {
    if (!open) return;
    const box = button.current?.getBoundingClientRect();
    if (!box) return;
    const below = window.innerHeight - box.bottom - 8;
    const above = box.top - 8;
    const maxHeight = Math.min(320, Math.max(below, above));
    const top =
      below >= Math.min(320, options.length * 32 + 12) || below >= above
        ? box.bottom + 4
        : box.top - 4 - Math.min(maxHeight, options.length * 32 + 12);
    setPosition({
      left: Math.round(box.left),
      top: Math.round(top),
      width: Math.round(box.width),
      maxHeight,
    });
  }, [open, options.length]);

  // The chosen option is in view and active when the list opens.
  useLayoutEffect(() => {
    if (!open) return;
    const index = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    setActive(index);
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: 'center' });
    list.current?.focus();
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const choose = (index: number) => {
    const option = options[index];
    setOpen(false);
    button.current?.focus();
    if (option && option.value !== value) onChange(option.value);
  };

  const onListKey = (event: KeyboardEvent) => {
    const move = (to: number) => {
      event.preventDefault();
      const next = Math.max(0, Math.min(options.length - 1, to));
      setActive(next);
      list.current
        ?.querySelector<HTMLElement>(`[data-index="${next}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    };
    switch (event.key) {
      case 'ArrowDown':
        move(active + 1);
        return;
      case 'ArrowUp':
        move(active - 1);
        return;
      case 'Home':
        move(0);
        return;
      case 'End':
        move(options.length - 1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        return;
      case 'Escape':
        // The list closes; the dialog under it stays.
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
        return;
      case 'Tab':
        setOpen(false);
        return;
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.field}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        data-open={open || undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={styles.value}>{chosen?.label ?? value}</span>
        <span className={styles.chevron}>
          <ChevronDownIcon />
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={`${id}-list`}
            className={styles.list}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            aria-activedescendant={`${id}-option-${active}`}
            style={position}
            onKeyDown={onListKey}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-option-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={option.value === value}
                data-index={index}
                data-active={index === active || undefined}
                className={styles.option}
                onPointerEnter={() => setActive(index)}
                onClick={() => choose(index)}
                onKeyDown={onListKey}
              >
                {option.label}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
