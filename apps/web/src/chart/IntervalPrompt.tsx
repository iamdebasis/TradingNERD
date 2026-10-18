import { formatResolution, menuLabel, parseIntervalInput } from '@tradingnerd/core';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import styles from './IntervalPrompt.module.css';

export interface IntervalPromptProps {
  /** What was typed to open the prompt, e.g. "1". */
  initial: string;
  onSubmit(interval: string): void;
  onClose(): void;
}

/**
 * TradingView's "Change interval" prompt: typing a number on the chart opens it, more digits
 * and a unit letter refine it ("15", "4h", "1D"), Enter applies and Escape cancels. The line
 * underneath says what Enter will switch to.
 */
export function IntervalPrompt({ initial, onSubmit, onClose }: IntervalPromptProps) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const parsed = parseIntervalInput(text);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (parsed) onSubmit(formatResolution(parsed));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className={styles.prompt} role="dialog" aria-label="Change interval">
      <div className={styles.title}>Change interval</div>
      <input
        ref={input}
        className={styles.input}
        value={text}
        maxLength={6}
        spellCheck={false}
        autoComplete="off"
        aria-label="Interval"
        aria-invalid={text.trim() !== '' && !parsed}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onClose}
      />
      <div className={styles.hint} data-valid={parsed !== null}>
        {text.trim() === '' ? ' ' : parsed ? menuLabel(parsed) : 'Not applicable'}
      </div>
    </div>
  );
}

/** Keys that open the prompt from the chart: a digit, or "," for an empty prompt. */
export function promptKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (/^[0-9]$/.test(event.key)) return event.key;
  return event.key === ',' ? '' : null;
}
