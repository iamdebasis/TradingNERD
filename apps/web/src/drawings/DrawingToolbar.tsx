import type { CursorMode } from '@tradingnerd/chart';
import {
  CHANNEL_TOOLS,
  type DrawingTool,
  LINE_TOOLS,
  PITCHFORK_TOOLS,
  TOOL_NAMES,
  TREND_LINE_TOOLS,
} from '@tradingnerd/core';
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { altShortcut, commandShortcut, isMac } from '../lib/platform';
import { StarIcon } from '../toolbar/icons';
import styles from './DrawingToolbar.module.css';
import { drawingStore, useDrawings } from './drawingStore';
import {
  CURSOR_ICONS,
  GroupArrowIcon,
  HideDrawingsIcon,
  KeepDrawingIcon,
  MagnetIcon,
  PadlockIcon,
  TOOL_ICONS,
  TrashIcon,
} from './icons';

/** The cursors' names (TradingView's Help Center: Cross, Dot, Arrow, Eraser). */
export const CURSOR_NAMES: Record<CursorMode, string> = {
  cross: 'Cross',
  dot: 'Dot',
  arrow: 'Arrow',
  eraser: 'Eraser',
};

const CURSOR_ORDER: readonly CursorMode[] = ['cross', 'dot', 'arrow', 'eraser'];

/** The Lines tools' shortcuts, as the user's screenshot of TradingView's menu lists them. */
export const TOOL_KEYS: Partial<Record<DrawingTool, string>> = {
  'trend-line': 'T',
  'horizontal-line': 'H',
  'horizontal-ray': 'J',
  'vertical-line': 'V',
  'cross-line': 'C',
};

/** A tool's name with its shortcut, for its tooltip. */
export function toolTitle(tool: DrawingTool): string {
  const key = TOOL_KEYS[tool];
  return key ? `${TOOL_NAMES[tool]} (${altShortcut(key)})` : TOOL_NAMES[tool];
}

/** TradingView's Hide all drawings shortcut: Ctrl+Alt+H (⌘⌥H on a Mac). */
export function hideShortcut(mac = isMac()): string {
  return mac ? '⌘⌥H' : 'Ctrl+Alt+H';
}

type MenuName = 'cursors' | 'lines' | 'magnet' | 'remove';

/** The trend line tools' menu: Lines, Channels and Pitchforks (the user's screenshot). */
const TREND_SECTIONS: readonly { name: string; tools: readonly DrawingTool[] }[] = [
  { name: 'Lines', tools: LINE_TOOLS },
  { name: 'Channels', tools: CHANNEL_TOOLS },
  { name: 'Pitchforks', tools: PITCHFORK_TOOLS },
];

/**
 * TradingView's left drawing toolbar (docs/SPEC.md §5.27): the cursors and the trend line tools
 * (Lines, D1; Channels and Pitchforks, D2), each group's button holding its last choice and a
 * tab opening its menu; then the magnet (weak or strong), Keep drawing, Lock all drawings, Hide
 * all drawings and Remove objects. Later milestones add their groups (shapes, text, measuring).
 * Each drawing tool's row has a star that makes it a favorite, on the favorites toolbar (D3b).
 */
export function DrawingToolbar() {
  const { tool, prefs, drawings } = useDrawings();
  const [menu, setMenu] = useState<MenuName | null>(null);
  const toolbar = useRef<HTMLElement>(null);
  const anchors = {
    cursors: useRef<HTMLDivElement>(null),
    lines: useRef<HTMLDivElement>(null),
    magnet: useRef<HTMLDivElement>(null),
    remove: useRef<HTMLDivElement>(null),
  };
  const toggle = (name: MenuName) => setMenu((open) => (open === name ? null : name));
  const lineTool = prefs.lineTool;
  const drawingLine = tool !== null && (TREND_LINE_TOOLS as readonly string[]).includes(tool);
  const CursorIcon = CURSOR_ICONS[prefs.cursor];
  const LineIcon = TOOL_ICONS[lineTool];
  const close = () => setMenu(null);

  // Hidden: a tab at the chart's left edge brings it back; it takes no room, as TradingView's
  // chart with the toolbar off has none (the user's October screenshots).
  if (!prefs.toolbarShown) {
    return (
      <button
        type="button"
        className={styles.showTab}
        aria-label="Show drawings toolbar"
        title="Show drawings toolbar"
        onClick={() => drawingStore.setPrefs({ toolbarShown: true })}
      >
        <GroupArrowIcon open={false} />
      </button>
    );
  }

  return (
    <nav ref={toolbar} className={styles.toolbar} aria-label="Drawing tools">
      <Group
        anchor={anchors.cursors}
        label={CURSOR_NAMES[prefs.cursor]}
        menuLabel="Cursors"
        pressed={tool === null}
        menuOpen={menu === 'cursors'}
        onClick={() => drawingStore.setTool(null)}
        onMenu={() => toggle('cursors')}
      >
        <CursorIcon />
      </Group>
      <Group
        anchor={anchors.lines}
        label={toolTitle(lineTool)}
        menuLabel="Trend line tools"
        pressed={drawingLine}
        menuOpen={menu === 'lines'}
        onClick={() => drawingStore.setTool(drawingLine ? null : lineTool)}
        onMenu={() => toggle('lines')}
      >
        <LineIcon />
      </Group>
      <span className={styles.separator} />
      <Group
        anchor={anchors.magnet}
        label={prefs.magnet === 'strong' ? 'Strong magnet' : 'Weak magnet'}
        menuLabel="Magnet"
        pressed={prefs.magnetOn}
        menuOpen={menu === 'magnet'}
        onClick={() => drawingStore.setPrefs({ magnetOn: !prefs.magnetOn })}
        onMenu={() => toggle('magnet')}
      >
        <MagnetIcon strong={prefs.magnet === 'strong'} />
      </Group>
      <ToggleButton
        label="Keep drawing"
        pressed={prefs.keepDrawing}
        onClick={() => drawingStore.setPrefs({ keepDrawing: !prefs.keepDrawing })}
      >
        <KeepDrawingIcon on={prefs.keepDrawing} />
      </ToggleButton>
      <ToggleButton
        label={prefs.lockAll ? 'Unlock all drawings' : 'Lock all drawings'}
        pressed={prefs.lockAll}
        onClick={() => drawingStore.setPrefs({ lockAll: !prefs.lockAll })}
      >
        <PadlockIcon locked={prefs.lockAll} />
      </ToggleButton>
      <ToggleButton
        label={`${prefs.hideAll ? 'Show' : 'Hide'} all drawings (${hideShortcut()})`}
        pressed={prefs.hideAll}
        onClick={() => drawingStore.setPrefs({ hideAll: !prefs.hideAll })}
      >
        <HideDrawingsIcon hidden={prefs.hideAll} />
      </ToggleButton>
      <span className={styles.separator} />
      <div ref={anchors.remove} className={styles.group}>
        <button
          type="button"
          className={styles.button}
          aria-label="Remove objects"
          title="Remove objects"
          aria-haspopup="menu"
          aria-expanded={menu === 'remove'}
          onClick={() => toggle('remove')}
        >
          <TrashIcon />
        </button>
      </div>
      <button
        type="button"
        className={styles.hide}
        aria-label="Hide drawings toolbar"
        title="Hide drawings toolbar"
        onClick={() => {
          close();
          drawingStore.setPrefs({ toolbarShown: false });
        }}
      >
        <GroupArrowIcon open />
      </button>
      {menu === 'cursors' && (
        <ToolMenu anchor={anchors.cursors} toolbar={toolbar} label="Cursors" onClose={close}>
          {CURSOR_ORDER.map((cursor) => {
            const Icon = CURSOR_ICONS[cursor];
            return (
              <MenuItem
                key={cursor}
                icon={<Icon />}
                name={CURSOR_NAMES[cursor]}
                checked={prefs.cursor === cursor}
                onSelect={() => {
                  close();
                  drawingStore.setPrefs({ cursor });
                }}
              />
            );
          })}
        </ToolMenu>
      )}
      {menu === 'lines' && (
        <ToolMenu anchor={anchors.lines} toolbar={toolbar} label="Trend line tools" onClose={close}>
          {TREND_SECTIONS.map(({ name, tools }, i) => (
            <Fragment key={name}>
              {i > 0 && <hr className={styles.divider} />}
              <h3 className={styles.section}>{name}</h3>
              {tools.map((item) => {
                const Icon = TOOL_ICONS[item];
                const key = TOOL_KEYS[item];
                return (
                  <MenuItem
                    key={item}
                    icon={<Icon />}
                    name={TOOL_NAMES[item]}
                    shortcut={key ? altShortcut(key) : undefined}
                    checked={tool === item}
                    favorite={prefs.favorites.includes(item)}
                    onFavorite={() => drawingStore.toggleFavorite(item)}
                    onSelect={() => {
                      close();
                      drawingStore.setTool(item);
                    }}
                  />
                );
              })}
            </Fragment>
          ))}
        </ToolMenu>
      )}
      {menu === 'magnet' && (
        <ToolMenu anchor={anchors.magnet} toolbar={toolbar} label="Magnet" onClose={close}>
          {(['weak', 'strong'] as const).map((magnet) => (
            <MenuItem
              key={magnet}
              icon={<MagnetIcon strong={magnet === 'strong'} />}
              name={magnet === 'strong' ? 'Strong magnet' : 'Weak magnet'}
              checked={prefs.magnetOn && prefs.magnet === magnet}
              onSelect={() => {
                close();
                drawingStore.setPrefs({ magnet, magnetOn: true });
              }}
            />
          ))}
        </ToolMenu>
      )}
      {menu === 'remove' && (
        <ToolMenu anchor={anchors.remove} toolbar={toolbar} label="Remove objects" onClose={close}>
          <MenuItem
            icon={<TrashIcon />}
            name={drawings.length === 1 ? 'Remove 1 drawing' : `Remove ${drawings.length} drawings`}
            disabled={drawings.length === 0}
            onSelect={() => {
              close();
              drawingStore.removeAll();
            }}
          />
        </ToolMenu>
      )}
    </nav>
  );
}

/** A group's button, with the tab that opens its menu. */
function Group({
  anchor,
  label,
  menuLabel,
  pressed,
  menuOpen,
  onClick,
  onMenu,
  children,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  label: string;
  menuLabel: string;
  pressed: boolean;
  menuOpen: boolean;
  onClick(): void;
  onMenu(): void;
  children: ReactNode;
}) {
  return (
    <div ref={anchor} className={styles.group}>
      <button
        type="button"
        className={styles.button}
        aria-label={label}
        title={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {children}
      </button>
      <button
        type="button"
        className={styles.tab}
        aria-label={menuLabel}
        title={menuLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onMenu}
      >
        <GroupArrowIcon open={menuOpen} />
      </button>
    </div>
  );
}

function ToggleButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <div className={styles.group}>
      <button
        type="button"
        className={styles.button}
        aria-label={label}
        title={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {children}
      </button>
    </div>
  );
}

/**
 * A toolbar menu beside the column, its top 8 px above its button's (the screenshot's), kept on
 * screen; a press outside it or Escape closes it.
 */
function ToolMenu({
  anchor,
  toolbar,
  label,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  toolbar: RefObject<HTMLElement | null>;
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const button = anchor.current?.getBoundingClientRect();
    const column = toolbar.current?.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 0;
    if (!button || !column) return;
    const top = Math.max(4, Math.min(button.top - 8, window.innerHeight - height - 4));
    setPosition({ left: column.right + 1.5, top });
  }, [anchor, toolbar]);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"], button')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || anchor.current?.contains(target)) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
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
  }, [anchor]);

  return createPortal(
    <div
      ref={menu}
      className={styles.menu}
      role="menu"
      aria-label={label}
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}

function MenuItem({
  icon,
  name,
  shortcut,
  checked,
  disabled = false,
  favorite = false,
  onFavorite,
  onSelect,
}: {
  icon: ReactNode;
  name: string;
  shortcut?: string | undefined;
  checked?: boolean;
  disabled?: boolean;
  /** A drawing tool's: starred, on the favorites toolbar (D3b). */
  favorite?: boolean;
  /** Its star: on or off (a drawing tool's row has one). */
  onFavorite?: () => void;
  onSelect(): void;
}) {
  const item = (
    <button
      type="button"
      className={styles.item}
      {...(checked === undefined
        ? { role: 'menuitem' }
        : { role: 'menuitemradio', 'aria-checked': checked })}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className={styles.itemIcon}>{icon}</span>
      <span className={styles.itemName}>{name}</span>
      {shortcut && <span className={styles.itemKey}>{shortcut}</span>}
    </button>
  );
  if (!onFavorite) return item;
  const title = favorite ? 'Remove from favorites' : 'Add to favorites';
  return (
    <div className={styles.row} data-favorite={favorite}>
      {item}
      <button
        type="button"
        className={styles.star}
        aria-pressed={favorite}
        aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        title={title}
        onClick={onFavorite}
      >
        <StarIcon filled={favorite} />
      </button>
    </div>
  );
}

/** The undo and redo buttons' tooltips. */
export const undoTitle = () => `Undo (${commandShortcut('Z')})`;
export const redoTitle = () => `Redo (${isMac() ? commandShortcut('Z', true) : 'Ctrl+Y'})`;
