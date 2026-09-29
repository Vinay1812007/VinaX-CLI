import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import {
  dirForKey,
  level,
  newGame,
  tick,
  tickMs,
  togglePause,
  turn,
  type SnakeState,
} from '../snake.js';
import { useTheme, type Theme } from '../theme.js';

/** Board size for a terminal: each cell is two characters wide so pixels look square. */
export function boardSize(columns: number, rows: number): { width: number; height: number } {
  return {
    width: Math.max(12, Math.min(28, Math.floor((columns - 6) / 2))),
    height: Math.max(8, Math.min(16, rows - 10)),
  };
}

const PALETTE = {
  board: '#0B2414',
  head: '#BEF264',
  body: ['#22C55E', '#16A34A'],
  food: '#F43F5E',
  bonus: '#E879F9',
  frame: '#84CC16',
} as const;

type Cell = 'empty' | 'head' | 'body0' | 'body1' | 'food' | 'bonus';

function cellAt(state: SnakeState, x: number, y: number, blink: boolean): Cell {
  const idx = state.snake.findIndex((p) => p.x === x && p.y === y);
  if (idx === 0) return 'head';
  if (idx > 0) return idx % 2 === 0 ? 'body0' : 'body1';
  if (state.food.x === x && state.food.y === y) return 'food';
  if (state.bonus && state.bonus.x === x && state.bonus.y === y && blink) return 'bonus';
  return 'empty';
}

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
    case 'empty':
      return '  ';
  }
}

function colorOf(cell: Cell): string | undefined {
  switch (cell) {
    case 'head':
      return PALETTE.head;
    case 'body0':
      return PALETTE.body[0];
    case 'body1':
      return PALETTE.body[1];
    case 'food':
      return PALETTE.food;
    case 'bonus':
      return PALETTE.bonus;
    case 'empty':
      return undefined;
  }
}

function BoardRow({
  state,
  y,
  blink,
  theme,
}: {
  state: SnakeState;
  y: number;
  blink: boolean;
  theme: Theme;
}) {
  // merge runs of the same cell so a row is a handful of Text nodes, not one per cell
  const runs: { cell: Cell; text: string }[] = [];
  for (let x = 0; x < state.width; x++) {
    const cell = cellAt(state, x, y, blink);
    const g = glyph(cell, theme.color);
    const last = runs.at(-1);
    if (last?.cell === cell) last.text += g;
    else runs.push({ cell, text: g });
  }
  return (
    <Text>
      {runs.map((r, i) => (
        <Text
          key={i}
          color={theme.color ? colorOf(r.cell) : undefined}
          backgroundColor={theme.color ? PALETTE.board : undefined}
        >
          {r.text}
        </Text>
      ))}
    </Text>
  );
}

const pad = (n: number) => String(n).padStart(4, '0');

/** Snake in the terminal. Arrows/WASD/hjkl steer, P pauses, R restarts, Esc or Q leaves. */
export function SnakeGame({
  columns,
  rows,
  best,
  onExit,
  random = Math.random,
}: {
  columns: number;
  rows: number;
  best: number;
  onExit: (score: number) => void;
  random?: () => number;
}) {
  const theme = useTheme();
  const size = boardSize(columns, rows);
  const [state, setState] = useState<SnakeState>(() => newGame(size.width, size.height, random));
  const [frame, setFrame] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const speed = tickMs(state);
  useEffect(() => {
    if (state.status !== 'running') return;
    const t = setInterval(() => {
      setState((s) => tick(s, random));
      setFrame((f) => f + 1);
    }, speed);
    return () => {
      clearInterval(t);
    };
  }, [state.status, speed]);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onExit(stateRef.current.score);
      return;
    }
    const dir = dirForKey(input, key);
    if (dir !== undefined) {
      setState((s) => turn(s, dir));
      return;
    }
    if (input === 'p' || input === ' ') setState((s) => togglePause(s));
    else if (input === 'r' && stateRef.current.status === 'over')
      setState(newGame(size.width, size.height, random));
  });

  const record = Math.max(best, state.score);
  const blink = state.bonus === undefined || state.bonus.ticksLeft > 10 || frame % 2 === 0;
  const message =
    state.status === 'ready'
      ? 'Press an arrow key (or WASD) to start'
      : state.status === 'paused'
        ? 'Paused · P to resume'
        : state.status === 'over'
          ? `Game over · ${String(state.score)} points${state.score > best && state.score > 0 ? ' · new best!' : ''} · R to play again`
          : state.bonus !== undefined
            ? `Bonus! catch it in ${String(state.bonus.ticksLeft)}`
            : ' ';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.color ? PALETTE.frame : undefined}
        paddingX={1}
        alignSelf="flex-start"
      >
        <Box justifyContent="space-between" width={state.width * 2}>
          <Text bold color={theme.color ? PALETTE.head : undefined}>
            SNAKE
          </Text>
          <Text>
            <Text color={theme.muted}>score </Text>
            <Text bold>{pad(state.score)}</Text>
            <Text color={theme.muted}> best </Text>
            <Text bold>{pad(record)}</Text>
            <Text color={theme.muted}> lv </Text>
            <Text bold>{level(state)}</Text>
          </Text>
        </Box>
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.color ? PALETTE.frame : undefined}
          marginTop={1}
        >
          {Array.from({ length: state.height }, (_, y) => (
            <BoardRow key={y} state={state} y={y} blink={blink} theme={theme} />
          ))}
        </Box>
        <Text color={state.status === 'over' ? theme.warning : theme.accent} wrap="truncate-end">
          {message}
        </Text>
      </Box>
      <Text color={theme.muted}>←↑↓→ / WASD move · P pause · R restart · Esc quit</Text>
    </Box>
  );
}
