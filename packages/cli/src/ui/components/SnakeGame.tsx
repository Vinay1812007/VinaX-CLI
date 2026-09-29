import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  advance,
  BONUS_TICKS,
  DEFAULT_PREFS,
  inputForKey,
  key,
  levelBar,
  MAZE_LABELS,
  MAZES,
  mazeWalls,
  MENU_ITEMS,
  newApp,
  OVER_ITEMS,
  PAUSE_ITEMS,
  press,
  scoreKey,
  snakeSession,
  tickMs,
  topScore,
  type Maze,
  type Palette,
  type SnakeApp,
  type SnakeSession,
} from '../snake.js';
import { useTheme } from '../theme.js';

/** Board size for a terminal: each cell is two characters wide so pixels look square. */
export function boardSize(columns: number, rows: number): { width: number; height: number } {
  return {
    // two border boxes and their padding take six columns
    width: Math.max(10, Math.min(28, Math.floor((columns - 6) / 2))),
    height: Math.max(8, Math.min(16, rows - 11)),
  };
}

interface Colors {
  board: string;
  head: string;
  body: readonly [string, string];
  food: string;
  bonus: string;
  wall: string;
  text: string;
  dim: string;
  frame: string;
}

export const PALETTE_COLORS: Record<Palette, Colors> = {
  colour: {
    board: '#0B2414',
    head: '#BEF264',
    body: ['#22C55E', '#16A34A'],
    food: '#F43F5E',
    bonus: '#E879F9',
    wall: '#F59E0B',
    text: '#D9F99D',
    dim: '#4D7C0F',
    frame: '#84CC16',
  },
  // the 3310's pale green screen with dark pixels
  lcd: {
    board: '#9BBC0F',
    head: '#0F380F',
    body: ['#0F380F', '#306230'],
    food: '#0F380F',
    bonus: '#306230',
    wall: '#306230',
    text: '#0F380F',
    dim: '#306230',
    frame: '#306230',
  },
};

type Cell = 'empty' | 'head' | 'body0' | 'body1' | 'food' | 'bonus' | 'wall';

function glyph(cell: Cell, color: boolean): string {
  if (color) return cell === 'food' || cell === 'bonus' ? '▐▌' : cell === 'empty' ? '  ' : '██';
  switch (cell) {
    case 'head':
      return '▓▓';
    case 'body0':
    case 'body1':
      return '██';
    case 'food':
      return '<>';
    case 'bonus':
      return '**';
    case 'wall':
      return '##';
    case 'empty':
      return '  ';
  }
}

function cellColor(cell: Cell, c: Colors): string | undefined {
  switch (cell) {
    case 'head':
      return c.head;
    case 'body0':
      return c.body[0];
    case 'body1':
      return c.body[1];
    case 'food':
      return c.food;
    case 'bonus':
      return c.bonus;
    case 'wall':
      return c.wall;
    case 'empty':
      return undefined;
  }
}

interface BoardView {
  width: number;
  height: number;
  walls: ReadonlySet<string>;
  snake: readonly { x: number; y: number }[];
  food?: { x: number; y: number } | undefined;
  bonus?: { x: number; y: number } | undefined;
}

function cellAt(view: BoardView, x: number, y: number, blink: boolean): Cell {
  const k = `${String(x)},${String(y)}`;
  if (view.walls.has(k)) return 'wall';
  const idx = view.snake.findIndex((p) => p.x === x && p.y === y);
  if (idx === 0) return 'head';
  if (idx > 0) return idx % 2 === 0 ? 'body0' : 'body1';
  if (view.food && key(view.food) === k) return 'food';
  if (view.bonus && blink && key(view.bonus) === k) return 'bonus';
  return 'empty';
}

/** A board row as a handful of runs, not one Text per cell. */
function BoardRow({
  view,
  y,
  blink,
  colors,
}: {
  view: BoardView;
  y: number;
  blink: boolean;
  colors: Colors | undefined;
}) {
  const runs: { cell: Cell; text: string }[] = [];
  for (let x = 0; x < view.width; x++) {
    const cell = cellAt(view, x, y, blink);
    const g = glyph(cell, colors !== undefined);
    const last = runs.at(-1);
    if (last?.cell === cell) last.text += g;
    else runs.push({ cell, text: g });
  }
  return (
    <Text>
      {runs.map((r, i) => (
        <Text
          key={i}
          color={colors ? cellColor(r.cell, colors) : undefined}
          backgroundColor={colors?.board}
        >
          {r.text}
        </Text>
      ))}
    </Text>
  );
}

/** One line of text on the phone's screen, padded to the board width. */
function ScreenLine({
  text,
  width,
  colors,
  selected = false,
  center = false,
  bold = false,
}: {
  text: string;
  width: number;
  colors: Colors | undefined;
  selected?: boolean;
  center?: boolean;
  bold?: boolean;
}) {
  const room = width;
  const body = colors ? text : `${selected ? '▶ ' : '  '}${text}`;
  const clipped = body.length > room ? body.slice(0, room) : body;
  const left = center ? Math.floor((room - clipped.length) / 2) : 0;
  const line = `${' '.repeat(left)}${clipped}`.padEnd(room);
  return (
    <Text
      bold={bold || selected}
      color={colors ? (selected ? colors.board : colors.text) : undefined}
      backgroundColor={colors ? (selected ? colors.text : colors.board) : undefined}
    >
      {line}
    </Text>
  );
}

const pad4 = (n: number) => String(n).padStart(4, '0');

function row(label: string, value: string, width: number): string {
  const gap = Math.max(1, width - label.length - value.length - 2);
  return ` ${label}${' '.repeat(gap)}${value} `;
}

const HELP = [
  'Eat to grow. Each meal is',
  'worth the level in points.',
  'Every 5th meal a bonus',
  'critter runs off: be quick!',
  'No maze: edges wrap round.',
  'Walls and your tail kill.',
  'Steer: arrows, WASD, hjkl',
  'P pause · C colours',
];

/** The phone's screen for menus, as lines. */
function menuLines(
  app: SnakeApp,
  width: number,
): { text: string; selected?: boolean; center?: boolean; bold?: boolean }[] {
  const { screen, prefs } = app;
  switch (screen.kind) {
    case 'menu':
      return [
        { text: 'Menu', center: true, bold: true },
        { text: '' },
        ...MENU_ITEMS.map((item, i) => ({
          text:
            item === 'Level'
              ? row(item, String(prefs.level), width)
              : item === 'Mazes'
                ? row(item, MAZE_LABELS[prefs.maze], width)
                : ` ${item}`,
          selected: i === screen.index,
        })),
      ];
    case 'level':
      return [
        { text: 'Level', center: true, bold: true },
        { text: '' },
        { text: levelBar(prefs.level), center: true },
        { text: '' },
        { text: String(prefs.level), center: true, bold: true },
        { text: '' },
        { text: '↑/→ higher · ↓/← lower', center: true },
        { text: 'Enter OK', center: true },
      ];
    case 'scores': {
      const lines = [
        { text: 'Top score', center: true, bold: true },
        { text: row('Overall', pad4(topScore(prefs)), width) },
        {
          text: row(
            `L${String(prefs.level)} ${MAZE_LABELS[prefs.maze]}`,
            pad4(topScore(prefs, prefs.level, prefs.maze)),
            width,
          ),
        },
      ];
      for (const m of MAZES)
        if (m !== prefs.maze)
          lines.push({
            text: row(
              `L${String(prefs.level)} ${MAZE_LABELS[m]}`,
              pad4(prefs.scores[scoreKey(prefs.level, m)] ?? 0),
              width,
            ),
          });
      return lines;
    }
    case 'help':
      return [
        { text: 'Instructions', center: true, bold: true },
        ...HELP.map((text) => ({ text: ` ${text}` })),
      ];
    default:
      return [];
  }
}

/** A stand-in session when /snake did not set one (tests, previews): prefs live in memory. */
function memorySession(best: number): SnakeSession {
  return {
    prefs: {
      ...DEFAULT_PREFS,
      scores: best > 0 ? { [scoreKey(DEFAULT_PREFS.level, 'none')]: best } : {},
    },
    save: () => undefined,
    last: undefined,
  };
}

/**
 * Snake II, Nokia-style: a menu (new game, level, mazes, top score, instructions), levels 1–9,
 * six mazes, a bonus critter, and top scores per level and maze. Prefs and scores come from and
 * go back to the /snake command through `session` (or `snakeSession.current`).
 */
export function SnakeGame({
  columns,
  rows,
  best,
  onExit,
  random = Math.random,
  session,
}: {
  columns: number;
  rows: number;
  /** Overall best score, shown when there is no session with per-level scores. */
  best: number;
  /** Called when the player quits, with the score of the last game played (0 if none). */
  onExit: (score: number) => void;
  random?: () => number;
  session?: SnakeSession;
}) {
  const theme = useTheme();
  const host = useMemo(() => session ?? snakeSession.current ?? memorySession(best), []);
  const size = boardSize(columns, rows);
  const [app, setApp] = useState<SnakeApp>(() => newApp({ ...size, prefs: host.prefs }));
  const [frame, setFrame] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    host.save(app.prefs);
  }, [app.prefs]);

  useEffect(() => {
    host.last = app.last;
  }, [app.last]);

  useEffect(() => {
    if (app.quit) onExit(app.last?.score ?? 0);
  }, [app.quit]);

  const running = app.screen.kind === 'game' && app.game?.status === 'running';
  const speed = tickMs(app.prefs.level);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setApp((a) => advance(a, random));
      setFrame((f) => f + 1);
    }, speed);
    return () => {
      clearInterval(t);
    };
  }, [running, speed]);

  useInput((input, k) => {
    const i = inputForKey(input, k);
    if (i !== undefined) setApp((a) => press(a, i, random));
  });

  const colors = theme.color ? PALETTE_COLORS[app.prefs.palette] : undefined;
  const { screen, game, prefs } = app;
  const w = size.width;
  const h = size.height;
  const charWidth = w * 2;

  let view: BoardView | undefined;
  if (screen.kind === 'game' || screen.kind === 'paused' || screen.kind === 'over') {
    if (game)
      view = {
        width: w,
        height: h,
        walls: game.walls,
        snake: game.snake,
        food: game.food,
        bonus: game.bonus,
      };
  } else if (screen.kind === 'mazes') {
    const maze: Maze = MAZES[screen.index] ?? 'none';
    view = { width: w, height: h, walls: mazeWalls(maze, w, h), snake: [] };
  }
  const blink = !game?.bonus || game.bonus.ticksLeft > 6 || frame % 2 === 0;

  const record = Math.max(best, topScore(prefs));
  // two columns stay free for the ▶ marker used without colour
  const lines = view ? [] : menuLines(app, charWidth - 2);
  while (lines.length < h) lines.push({ text: '' });

  let status: string;
  let options: { items: readonly string[]; index: number } | undefined;
  switch (screen.kind) {
    case 'menu':
      status = '↑↓ choose · Enter select · C colours · Esc quit';
      break;
    case 'level':
      status = `Level ${String(prefs.level)} · Enter to go back`;
      break;
    case 'mazes':
      status = `◀ ${MAZE_LABELS[MAZES[screen.index] ?? 'none']} ▶  ${String(screen.index + 1)}/${String(MAZES.length)} · Enter to pick`;
      break;
    case 'scores':
    case 'help':
      status = 'Enter or Esc to go back';
      break;
    case 'game':
      status = game?.bonus
        ? `Bonus! ${String(game.bonus.ticksLeft)} ${'▮'.repeat(Math.ceil((game.bonus.ticksLeft / BONUS_TICKS) * 5))}`
        : `${MAZE_LABELS[prefs.maze]} · P pause`;
      break;
    case 'paused':
      status = 'Paused';
      options = { items: PAUSE_ITEMS, index: screen.index };
      break;
    case 'over':
      status = `Game over · ${String(app.last?.score ?? 0)} points${screen.newTop && (app.last?.score ?? 0) > 0 ? ' · New top score!' : ''}`;
      options = { items: OVER_ITEMS, index: screen.index };
      break;
  }

  return (
    <Box flexDirection="column" marginTop={1} width={charWidth + 6}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={colors?.frame}
        paddingX={1}
        width={charWidth + 6}
      >
        <Box justifyContent="space-between" width={charWidth + 2}>
          <Text bold color={colors?.head}>
            SNAKE II
          </Text>
          {game && screen.kind !== 'menu' ? (
            <Text>
              <Text bold>{pad4(game.score)}</Text>
              <Text color={theme.muted}> L{game.level} </Text>
              <Text color={colors?.frame}>{levelBar(game.level)}</Text>
            </Text>
          ) : (
            <Text>
              <Text color={theme.muted}>top </Text>
              <Text bold>{pad4(record)}</Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column" borderStyle="single" borderColor={colors?.frame}>
          {view
            ? Array.from({ length: h }, (_, y) => (
                <BoardRow key={y} view={view} y={y} blink={blink} colors={colors} />
              ))
            : lines
                .slice(0, h)
                .map((l, i) => (
                  <ScreenLine
                    key={i}
                    text={l.text}
                    width={charWidth}
                    colors={colors}
                    selected={l.selected === true}
                    center={l.center === true}
                    bold={l.bold === true}
                  />
                ))}
        </Box>
        <Text
          color={screen.kind === 'over' ? theme.warning : theme.accent}
          bold={screen.kind === 'over' || screen.kind === 'paused'}
          wrap="truncate-end"
        >
          {status}
        </Text>
        {options ? (
          <Text wrap="truncate-end">
            {options.items.map((item, i) => (
              <Text key={item} inverse={i === options.index} bold={i === options.index}>
                {i === options.index ? `▶ ${item} ` : `  ${item} `}
              </Text>
            ))}
          </Text>
        ) : null}
      </Box>
      <Text color={theme.muted} wrap="truncate-end">
        {screen.kind === 'game'
          ? '←↑↓→ / WASD steer · P pause · Esc menu'
          : '↑↓ move · Enter/→ select · Esc/← back · C colours'}
      </Text>
    </Box>
  );
}
