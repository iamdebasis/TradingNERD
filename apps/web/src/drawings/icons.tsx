import type { CursorMode } from '@tradingnerd/chart';
import type { DrawingTool } from '@tradingnerd/core';
import type { JSX, ReactNode } from 'react';

/**
 * The drawing tools' icons: ours, traced to the size and 1 px stroke of TradingView's in the
 * user's screenshot of 25 November (its own icons are its art). 28 px squares on whole and half
 * pixels, in currentColor; provisional until compared side by side (docs/SPEC.md §11).
 */

const line = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Icon({ children, size = 28 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" {...line} aria-hidden>
      {children}
    </svg>
  );
}

/** A line tool's point: a 2 px ring. */
const Point = ({ x, y }: { x: number; y: number }) => <circle cx={x} cy={y} r="2" />;

export function CrossIcon() {
  return (
    <Icon>
      <path d="M14.5 3v7.5M14.5 18.5V26M3 14.5h7.5M18.5 14.5H26" strokeLinecap="butt" />
    </Icon>
  );
}

export function DotIcon() {
  return (
    <Icon>
      <circle cx="14.5" cy="14.5" r="2.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function ArrowCursorIcon() {
  return (
    <Icon>
      <path d="M9.5 5.5v15.5l4.2-4.1 3.1 6.6 2.6-1.2-3.1-6.6h5.7z" />
    </Icon>
  );
}

export function EraserIcon() {
  return (
    <Icon>
      <path d="M5.5 18.5 15 9l7 7-7.5 7.5H10.5z" />
      <path d="M10 14l7 7M14.5 23.5h9" />
    </Icon>
  );
}

export const CURSOR_ICONS: Record<CursorMode, () => JSX.Element> = {
  cross: CrossIcon,
  dot: DotIcon,
  arrow: ArrowCursorIcon,
  eraser: EraserIcon,
};

export function TrendLineIcon() {
  return (
    <Icon>
      <path d="M6.9 21.1 21.1 6.9" />
      <Point x={5.5} y={22.5} />
      <Point x={22.5} y={5.5} />
    </Icon>
  );
}

export function RayIcon() {
  return (
    <Icon>
      <path d="M7.9 20.1l5.2-5.2M15.9 12.1l8.6-8.6" />
      <Point x={6.5} y={21.5} />
      <Point x={14.5} y={13.5} />
    </Icon>
  );
}

export function InfoLineIcon() {
  return (
    <Icon>
      <path d="M6.9 21.1 21.1 6.9" />
      <Point x={5.5} y={22.5} />
      <Point x={22.5} y={5.5} />
      <rect x="16.5" y="17.5" width="9" height="7" rx="2.5" />
    </Icon>
  );
}

export function ExtendedLineIcon() {
  return (
    <Icon>
      <path d="M4 25l5.6-5.6M12.4 16.6l5.2-5.2M20.4 8.6 25 4" />
      <Point x={11} y={18} />
      <Point x={19} y={10} />
    </Icon>
  );
}

export function TrendAngleIcon() {
  return (
    <Icon>
      <path d="M6.9 21.1 21.1 6.9M7.5 22.5h17" />
      <path d="M15.5 22.5a10 10 0 0 0-2.9-7.1" />
      <Point x={5.5} y={22.5} />
      <Point x={22.5} y={5.5} />
    </Icon>
  );
}

export function HorizontalLineIcon() {
  return (
    <Icon>
      <path d="M4 14.5h8.5M16.5 14.5H25" strokeLinecap="butt" />
      <Point x={14.5} y={14.5} />
    </Icon>
  );
}

export function HorizontalRayIcon() {
  return (
    <Icon>
      <path d="M9 14.5h16.5" strokeLinecap="butt" />
      <Point x={7} y={14.5} />
    </Icon>
  );
}

export function VerticalLineIcon() {
  return (
    <Icon>
      <path d="M14.5 4v8.5M14.5 16.5V25" strokeLinecap="butt" />
      <Point x={14.5} y={14.5} />
    </Icon>
  );
}

export function CrossLineIcon() {
  return (
    <Icon>
      <path d="M14.5 3.5v9M14.5 16.5v9M3.5 14.5h9M16.5 14.5h9" strokeLinecap="butt" />
      <Point x={14.5} y={14.5} />
    </Icon>
  );
}

export const TOOL_ICONS: Record<DrawingTool, () => JSX.Element> = {
  'trend-line': TrendLineIcon,
  ray: RayIcon,
  'info-line': InfoLineIcon,
  'extended-line': ExtendedLineIcon,
  'trend-angle': TrendAngleIcon,
  'horizontal-line': HorizontalLineIcon,
  'horizontal-ray': HorizontalRayIcon,
  'vertical-line': VerticalLineIcon,
  'cross-line': CrossLineIcon,
};

/** The magnet: a horseshoe, its poles banded; the strong one's poles filled. */
export function MagnetIcon({ strong = false }: { strong?: boolean }) {
  return (
    <Icon>
      <path d="M6.5 23.5V13a7.5 7.5 0 0 1 15 0v10.5h-4V13a3.5 3.5 0 0 0-7 0v10.5z" />
      <path d="M6.5 19.5h4M17.5 19.5h4" />
      {strong && <path d="M6.5 19.5h4v4h-4zM17.5 19.5h4v4h-4z" fill="currentColor" stroke="none" />}
    </Icon>
  );
}

/** Keep drawing: a pencil and a small padlock, shut while it's on. */
export function KeepDrawingIcon({ on = false }: { on?: boolean }) {
  return (
    <Icon>
      <path d="M5.5 20.5 17 9l3 3L8.5 23.5h-3zM14.5 11.5l3 3" />
      <rect x="17.5" y="19.5" width="7" height="5.5" rx="1" />
      <path d={on ? 'M19 19.5v-1.5a2 2 0 0 1 4 0v1.5' : 'M19 19.5v-1.5a2 2 0 0 1 4 0'} />
    </Icon>
  );
}

/** A padlock: open, or shut while everything is locked. */
export function PadlockIcon({ locked = false }: { locked?: boolean }) {
  return (
    <Icon>
      <rect x="6.5" y="13.5" width="15" height="11" rx="2.5" />
      <path d={locked ? 'M10 13.5v-3a4 4 0 0 1 8 0v3' : 'M10 13.5v-4a4 4 0 0 1 8 0'} />
      <path d="M14 18v2.5" />
    </Icon>
  );
}

/** Hide drawings: an eye with a small brush stroke; crossed out while they're hidden. */
export function HideDrawingsIcon({ hidden = false }: { hidden?: boolean }) {
  return (
    <Icon>
      <path d="M5 13s3.5-5.5 9-5.5 9 5.5 9 5.5-3.5 5.5-9 5.5S5 13 5 13z" />
      <circle cx="14" cy="13" r="2.75" />
      <path d="M17.5 24.5c.8-1.4 2-2.1 3.3-2.3M21.5 21.7l1.6-1.6" />
      {hidden && <path d="M6 22 22 5" />}
    </Icon>
  );
}

export function TrashIcon() {
  return (
    <Icon>
      <path d="M5 7.5h18M11.5 7.5V5.5h5v2M7.5 7.5l1.5 16.5h10L20.5 7.5" />
    </Icon>
  );
}

/** A tool group's tab: open its menu (›), or close it (‹). */
export function GroupArrowIcon({ open }: { open: boolean }) {
  return (
    <svg width="6" height="10" viewBox="0 0 6 10" {...line} aria-hidden>
      <path d={open ? 'M4.5 1.5 1.5 5l3 3.5' : 'M1.5 1.5 4.5 5l-3 3.5'} />
    </svg>
  );
}

export function UndoIcon() {
  return (
    <Icon>
      <path d="M8 11.5h9.5a5.5 5.5 0 0 1 0 11H12M11.5 8 8 11.5l3.5 3.5" />
    </Icon>
  );
}

export function RedoIcon() {
  return (
    <Icon>
      <path d="M20 11.5h-9.5a5.5 5.5 0 0 0 0 11H16M16.5 8l3.5 3.5-3.5 3.5" />
    </Icon>
  );
}

/** The floating toolbar's grip: two columns of dots. */
export function GripIcon() {
  return (
    <svg width="6" height="18" viewBox="0 0 6 18" aria-hidden fill="currentColor">
      {[3, 9, 15].flatMap((y) => [
        <circle key={`l${y}`} cx="1" cy={y} r="1" />,
        <circle key={`r${y}`} cx="5" cy={y} r="1" />,
      ])}
    </svg>
  );
}

/** The line's color: a pencil over a bar of the color. */
export function LineColorIcon({ color }: { color: string }) {
  return (
    <Icon>
      <path d="M8.5 17.5 18 8l2.5 2.5L11 20H8.5zM16 10l2.5 2.5" />
      <rect x="5" y="22" width="18" height="3" rx="1" fill={color} stroke="none" />
    </Icon>
  );
}

/** A line style's sample: solid, dashed or dotted. */
export function LineStyleIcon({ style }: { style: 'solid' | 'dashed' | 'dotted' }) {
  const dash = style === 'dashed' ? '4 3' : style === 'dotted' ? '1 2.5' : undefined;
  return (
    <Icon>
      <path d="M5 14.5h18" strokeLinecap="butt" strokeWidth="2" strokeDasharray={dash} />
    </Icon>
  );
}

export function GearIcon() {
  return (
    <Icon>
      <path d="M12.6 4.5h2.8l.6 2.6 1.8.8 2.3-1.4 2 2-1.4 2.3.8 1.8 2.6.6v2.8l-2.6.6-.8 1.8 1.4 2.3-2 2-2.3-1.4-1.8.8-.6 2.6h-2.8l-.6-2.6-1.8-.8-2.3 1.4-2-2 1.4-2.3-.8-1.8-2.6-.6v-2.8l2.6-.6.8-1.8-1.4-2.3 2-2 2.3 1.4 1.8-.8z" />
      <circle cx="14" cy="14" r="3.5" />
    </Icon>
  );
}
