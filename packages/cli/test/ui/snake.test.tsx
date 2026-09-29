import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppStateStore } from '@vinax/core';
import { BUILTIN_COMMANDS } from '../../src/ui/commands/builtins.js';
import type { CommandContext } from '../../src/ui/commands/types.js';
import { boardSize, SnakeGame } from '../../src/ui/components/SnakeGame.js';
import {
  advance,
  BONUS_EVERY,
  BONUS_TICKS,
  bonusPoints,
  DEFAULT_PREFS,
  foodPoints,
  inputForKey,
  key,
  levelBar,
  MAZES,
  mazeWalls,
  newApp,
  newGame,
  prefsFromState,
  press,
  snakeSession,
  startPosition,
  stateFromPrefs,
  tick,
  tickMs,
  topScore,
  turn,
  type Input,
  type SnakeApp,
  type SnakeSession,
  type SnakeState,
} from '../../src/ui/snake.js';
import { resolveTheme, ThemeContext } from '../../src/ui/theme.js';

const mono = resolveTheme('dark', { NO_COLOR: '1' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Always picks the first free cell, so food lands at a predictable spot. */
const first = () => 0;

let app: ReturnType<typeof render> | undefined;
const dirs: string[] = [];
afterEach(async () => {
  app?.unmount();
  app = undefined;
  snakeSession.current = undefined;
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function game(
  over: Partial<SnakeState> = {},
  opts: Parameters<typeof newGame>[0] = { width: 20, height: 10 },
) {
  return { ...newGame({ random: first, ...opts }), ...over };
}

function pressAll(start: SnakeApp, inputs: readonly Input[]): SnakeApp {
  return inputs.reduce((a, i) => press(a, i, first), start);
}

describe('snake II rules', () => {
  it('runs at the level speed, 250ms at level 1 to 60ms at level 9', () => {
    expect(tickMs(1)).toBe(250);
    expect(tickMs(9)).toBe(60);
    for (let l = 1; l < 9; l++) expect(tickMs(l + 1)).toBeLessThan(tickMs(l));
    expect(tickMs(42)).toBe(60);
    expect(levelBar(3)).toBe('▮▮▮▯▯▯▯▯▯');
  });

  it('wraps around the edges when there is no maze', () => {
    const s = tick(game({ snake: [{ x: 19, y: 5 }], dir: 'right' }), first);
    expect(s.status).toBe('running');
    expect(s.snake[0]).toEqual({ x: 0, y: 5 });
    const up = tick(game({ snake: [{ x: 4, y: 0 }], dir: 'up' }), first);
    expect(up.snake[0]).toEqual({ x: 4, y: 9 });
  });

  it('dies on maze walls', () => {
    const boxed = game(
      { snake: [{ x: 18, y: 5 }], dir: 'right' },
      { width: 20, height: 10, maze: 'box' },
    );
    expect(tick(boxed, first).status).toBe('over');
  });

  it('dies on its own body but may follow its tail', () => {
    const body = [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 6, y: 6 },
      { x: 5, y: 6 },
      { x: 4, y: 6 },
    ];
    expect(tick(game({ snake: body, dir: 'down' }), first).status).toBe('over');
    expect(tick(game({ snake: body.slice(0, 4), dir: 'down' }), first).status).toBe('running');
  });

  it('ignores turning back onto itself and buffers two quick turns', () => {
    const s = game();
    expect(turn(s, 'left')).toBe(s);
    expect(turn(turn(turn(s, 'up'), 'left'), 'down').queue).toEqual(['up', 'left']);
    const moved = tick(turn(s, 'down'), first);
    expect(moved.dir).toBe('down');
  });

  it('scores the level number per meal and grows by one', () => {
    let s = game({}, { width: 20, height: 10, level: 7 });
    const head = s.snake[0] ?? { x: 0, y: 0 };
    s = tick({ ...s, food: { x: head.x + 1, y: head.y } }, first);
    expect(s.score).toBe(7);
    expect(foodPoints(7)).toBe(7);
    expect(s.snake).toHaveLength(5);
  });

  it('sends a bonus critter every fifth meal, counting down and worth more when quick', () => {
    let s = game({}, { width: 30, height: 12, level: 3 });
    const head = s.snake[0] ?? { x: 0, y: 0 };
    s = tick({ ...s, eaten: BONUS_EVERY - 1, food: { x: head.x + 1, y: head.y } }, () => 0.99);
    expect(s.bonus?.ticksLeft).toBe(BONUS_TICKS);
    s = tick(s, first);
    expect(s.bonus?.ticksLeft).toBe(BONUS_TICKS - 1);
    // catch it right away
    const bonus = s.bonus ?? { x: 0, y: 0, ticksLeft: 0 };
    const before = s.score;
    const caught = tick({ ...s, snake: [{ x: bonus.x - 1, y: bonus.y }], dir: 'right' }, first);
    expect(caught.bonus).toBeUndefined();
    expect(caught.score - before).toBe(bonusPoints(3, bonus.ticksLeft));
    // or let it run away
    let missed = s;
    for (let i = 0; i < BONUS_TICKS; i++) missed = { ...tick(missed, first), status: 'running' };
    expect(missed.bonus).toBeUndefined();
  });

  it.each(MAZES)('maze %s leaves the snake a safe start on several board sizes', (maze) => {
    for (const [w, h] of [
      [10, 8],
      [20, 10],
      [28, 16],
    ] as const) {
      const walls = mazeWalls(maze, w, h);
      const snake = startPosition(w, h, walls);
      const head = snake[0] ?? { x: 0, y: 0 };
      for (const p of snake) expect(walls.has(key(p))).toBe(false);
      for (let i = 1; i <= 3; i++) expect(walls.has(key({ x: head.x + i, y: head.y }))).toBe(false);
      const s = newGame({ width: w, height: h, maze, random: first });
      expect(walls.has(key(s.food))).toBe(false);
    }
  });

  it('draws each maze differently', () => {
    const w = 20;
    const h = 10;
    const walls = Object.fromEntries(MAZES.map((m) => [m, mazeWalls(m, w, h)]));
    expect(walls.none?.size).toBe(0);
    // box: a closed border
    expect(walls.box?.has('0,0')).toBe(true);
    expect(walls.box?.has('19,5')).toBe(true);
    // tunnel: top and bottom walls but open sides, so it wraps left-right
    expect(walls.tunnel?.has('5,0')).toBe(true);
    expect(walls.tunnel?.has('0,5')).toBe(false);
    // rails: two bars, no border
    expect(walls.rails?.has('0,0')).toBe(false);
    expect([...(walls.rails ?? [])].some((k) => k.endsWith(',3'))).toBe(true);
    // apartment: a border with doorways inside
    expect(walls.apartment?.has('0,0')).toBe(true);
    expect(walls.apartment?.has('10,2')).toBe(false);
    expect(walls.apartment?.has('10,1')).toBe(true);
    const sizes = new Set(MAZES.map((m) => [...(walls[m] ?? [])].sort().join('|')));
    expect(sizes.size).toBe(MAZES.length);
  });
});

describe('snake II menus', () => {
  const start = () => newApp({ width: 20, height: 10 });

  it('moves through the menu and adjusts the level high and low', () => {
    let a = pressAll(start(), ['down', 'enter']);
    expect(a.screen).toEqual({ kind: 'level' });
    a = pressAll(a, ['up', 'up', 'right']);
    expect(a.prefs.level).toBe(8);
    a = pressAll(a, ['down', 'left']);
    expect(a.prefs.level).toBe(6);
    a = pressAll(a, ['up', 'up', 'up', 'up', 'up']);
    expect(a.prefs.level).toBe(9);
    a = pressAll(a, Array<Input>(12).fill('down'));
    expect(a.prefs.level).toBe(1);
    a = press(a, 'enter');
    expect(a.screen).toEqual({ kind: 'menu', index: 1 });
    expect(pressAll(start(), ['up']).screen).toEqual({ kind: 'menu', index: 5 });
  });

  it('picks a maze, starts a game with the chosen level and maze', () => {
    let a = pressAll(start(), ['down', 'down', 'enter', 'down', 'down', 'enter']);
    expect(a.prefs.maze).toBe('tunnel');
    expect(a.screen).toEqual({ kind: 'menu', index: 2 });
    a = pressAll(a, ['up', 'up', 'enter']);
    expect(a.screen.kind).toBe('game');
    expect(a.game?.maze).toBe('tunnel');
    expect(a.game?.level).toBe(DEFAULT_PREFS.level);
  });

  it('opens top score and instructions and returns with Esc', () => {
    const scores = pressAll(start(), ['down', 'down', 'down', 'enter']);
    expect(scores.screen.kind).toBe('scores');
    expect(press(scores, 'back').screen).toEqual({ kind: 'menu', index: 3 });
    const help = pressAll(start(), ['down', 'down', 'down', 'down', 'enter']);
    expect(help.screen.kind).toBe('help');
  });

  it('pauses with a Continue / New game / Menu choice', () => {
    let a = pressAll(start(), ['enter']);
    a = press(a, 'pause');
    expect(a.screen).toEqual({ kind: 'paused', index: 0 });
    expect(advance(a, first)).toBe(a);
    expect(press(a, 'enter').screen).toEqual({ kind: 'game' });
    const restarted = pressAll({ ...a, game: a.game && { ...a.game, score: 12 } }, [
      'down',
      'enter',
    ]);
    expect(restarted.screen.kind).toBe('game');
    expect(restarted.game?.score).toBe(0);
    expect(restarted.last?.score).toBe(12);
    const menu = pressAll(a, ['down', 'down', 'enter']);
    expect(menu.screen).toEqual({ kind: 'menu', index: 0 });
  });

  it('records a top score per level and maze when the game ends', () => {
    let a = pressAll(start(), ['enter']);
    const g = a.game;
    if (!g) throw new Error('no game');
    // aim the snake at itself so the next move ends the game
    a = {
      ...a,
      game: {
        ...g,
        score: 30,
        dir: 'down',
        snake: [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
          { x: 6, y: 6 },
          { x: 5, y: 6 },
          { x: 4, y: 6 },
        ],
      },
    };
    a = advance(a, first);
    expect(a.screen).toEqual({ kind: 'over', index: 0, newTop: true });
    expect(a.prefs.scores['5:none']).toBe(30);
    expect(a.last).toEqual({ score: 30, level: 5, maze: 'none', newTop: true });
    expect(topScore(a.prefs)).toBe(30);
    expect(press(a, 'enter').screen.kind).toBe('game');
    expect(pressAll(a, ['down', 'enter']).screen).toEqual({ kind: 'menu', index: 0 });
  });

  it('quits from the menu, toggles the palette, and maps keys', () => {
    expect(press(start(), 'back').quit).toBe(true);
    expect(pressAll(start(), ['up', 'enter']).quit).toBe(true);
    expect(press(start(), 'palette').prefs.palette).toBe('lcd');
    expect(inputForKey('w', {})).toBe('up');
    expect(inputForKey('', { leftArrow: true })).toBe('left');
    expect(inputForKey('', { return: true })).toBe('enter');
    expect(inputForKey('', { escape: true })).toBe('back');
    expect(inputForKey(' ', {})).toBe('pause');
    expect(inputForKey('c', {})).toBe('palette');
    expect(inputForKey('x', {})).toBeUndefined();
  });

  it('stores prefs in app state and reads them back safely', () => {
    const prefs = {
      level: 7,
      maze: 'mill' as const,
      palette: 'lcd' as const,
      scores: { '7:mill': 44 },
    };
    const saved = stateFromPrefs(prefs);
    expect(saved).toEqual({
      snakeLevel: 7,
      snakeMaze: 'mill',
      snakePalette: 'lcd',
      snakeScores: { '7:mill': 44 },
      snakeBest: 44,
    });
    expect(prefsFromState(saved)).toEqual(prefs);
    expect(prefsFromState({ snakeMaze: 'lava', snakeLevel: 99 })).toEqual({
      ...DEFAULT_PREFS,
      level: 9,
    });
  });
});

describe('SnakeGame', () => {
  const frame = () => app?.lastFrame() ?? '';
  const keys = async (...chunks: string[]) => {
    for (const c of chunks) {
      app?.stdin.write(c);
      await sleep(25);
    }
  };

  it('shows the phone menu, plays, pauses and hands back the last score', async () => {
    const onExit = vi.fn();
    app = render(
      <ThemeContext.Provider value={mono}>
        <SnakeGame columns={60} rows={24} best={42} onExit={onExit} random={first} />
      </ThemeContext.Provider>,
    );
    expect(frame()).toContain('SNAKE II');
    expect(frame()).toContain('▶  New game');
    expect(frame()).toMatch(/Level\s+5/);
    expect(frame()).toMatch(/Mazes\s+No maze/);
    expect(frame()).toContain('top 0042');
    await sleep(30);
    await keys('\r');
    expect(frame()).toContain('██████▓▓');
    expect(frame()).toContain('L5 ▮▮▮▮▮▯▯▯▯');
    await keys('\x1b');
    expect(frame()).toContain('Paused');
    expect(frame()).toContain('▶ Continue');
    await keys('\x1b[B', '\x1b[B', '\r');
    expect(frame()).toContain('▶  New game');
    await keys('\x1b');
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('previews mazes with walls and uses plain characters under NO_COLOR', async () => {
    app = render(
      <ThemeContext.Provider value={mono}>
        <SnakeGame columns={60} rows={24} best={0} onExit={vi.fn()} random={first} />
      </ThemeContext.Provider>,
    );
    await sleep(30);
    await keys('\x1b[B', '\x1b[B', '\r', '\x1b[B');
    expect(frame()).toContain('◀ Box ▶  2/6');
    expect(frame()).toContain('####');
    // no foreground colour escapes (ESC[3xm)
    expect(frame().includes('\u001b[3')).toBe(false);
  });

  it('saves level changes to its session', async () => {
    const save = vi.fn();
    const session: SnakeSession = { prefs: DEFAULT_PREFS, save, last: undefined };
    app = render(
      <ThemeContext.Provider value={mono}>
        <SnakeGame
          columns={60}
          rows={24}
          best={0}
          onExit={vi.fn()}
          random={first}
          session={session}
        />
      </ThemeContext.Provider>,
    );
    await sleep(30);
    await keys('\x1b[B', '\r', '\x1b[A');
    expect(frame()).toContain('▮▮▮▮▮▮▯▯▯');
    expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_PREFS, level: 6 });
  });

  it('fits narrow terminals', () => {
    expect(boardSize(90, 34)).toEqual({ width: 28, height: 16 });
    expect(boardSize(30, 20)).toEqual({ width: 12, height: 9 });
    app = render(
      <ThemeContext.Provider value={mono}>
        <SnakeGame columns={30} rows={20} best={0} onExit={vi.fn()} random={first} />
      </ThemeContext.Provider>,
    );
    for (const line of frame().split('\n')) expect(line.length).toBeLessThanOrEqual(30);
  });
});

describe('/snake command', () => {
  it('loads prefs, saves top scores and level, and reports the game', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-snake-'));
    dirs.push(home);
    const env = { VINAX_HOME: home };
    await new AppStateStore(env).update((s) => ({ ...s, snakeLevel: 4, snakeMaze: 'box' }));
    const notice = vi.fn();
    let seen: SnakeSession | undefined;
    const ctx = {
      runtime: { env },
      notice,
      playSnake: (best: number) => {
        seen = snakeSession.current;
        expect(best).toBe(0);
        if (!seen) throw new Error('no session');
        expect(seen.prefs.level).toBe(4);
        expect(seen.prefs.maze).toBe('box');
        seen.save({ ...seen.prefs, level: 7, scores: { '7:box': 55 } });
        seen.last = { score: 55, level: 7, maze: 'box', newTop: true };
        return Promise.resolve(55);
      },
    } as unknown as CommandContext;
    const cmd = BUILTIN_COMMANDS.find((c) => c.name === 'snake');
    await cmd?.run(ctx);
    expect(snakeSession.current).toBeUndefined();
    const state = await new AppStateStore(env).read();
    expect(state).toMatchObject({
      snakeLevel: 7,
      snakeMaze: 'box',
      snakeScores: { '7:box': 55 },
      snakeBest: 55,
    });
    expect(notice).toHaveBeenCalledWith(
      'info',
      'Snake: 55 points (level 7, Box) — new top score! · best 55.',
    );
  });
});
