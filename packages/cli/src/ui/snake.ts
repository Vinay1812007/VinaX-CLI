/**
 * Snake II, the way the Nokia 3310 played it: pick a speed level (1–9) and a maze, eat to grow,
 * and a bonus critter shows up every few meals for extra points. With no maze the snake wraps
 * around the screen edges; maze walls and your own tail end the game.
 *
 * Everything here is pure (randomness is injected), so the UI only draws and times it.
 */

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Point {
  x: number;
  y: number;
}

export const MAZES = ['none', 'box', 'tunnel', 'mill', 'rails', 'apartment'] as const;
export type Maze = (typeof MAZES)[number];

export const MAZE_LABELS: Record<Maze, string> = {
  none: 'No maze',
  box: 'Box',
  tunnel: 'Tunnel',
  mill: 'Mill',
  rails: 'Rails',
  apartment: 'Apartment',
};

export const PALETTES = ['colour', 'lcd'] as const;
export type Palette = (typeof PALETTES)[number];

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 9;
/** A bonus critter appears after this many meals… */
export const BONUS_EVERY = 5;
/** …and runs away after this many moves. */
export const BONUS_TICKS = 20;

export interface SnakeState {
  width: number;
  height: number;
  level: number;
  maze: Maze;
  /** Wall cells as `x,y` keys. */
  walls: ReadonlySet<string>;
  /** Head first. */
  snake: Point[];
  dir: Dir;
  /** Turns typed faster than the snake moves, applied one per move. */
  queue: Dir[];
  food: Point;
  /** A bonus critter and the moves it has left. */
  bonus: (Point & { ticksLeft: number }) | undefined;
  score: number;
  eaten: number;
  status: 'running' | 'over';
}

const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const STEP: Record<Dir, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const key = (p: Point): string => `${String(p.x)},${String(p.y)}`;
const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

export function clampLevel(level: number): number {
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level)));
}

/** Milliseconds per move: 250 at level 1 down to 60 at level 9. */
export function tickMs(level: number): number {
  return Math.round(250 - ((clampLevel(level) - 1) * 190) / 8);
}

/** Points for one meal: the level number, like the phone. */
export function foodPoints(level: number): number {
  return clampLevel(level);
}

/** A bonus critter is worth more the sooner you catch it. */
export function bonusPoints(level: number, ticksLeft: number): number {
  return clampLevel(level) * 2 + Math.max(0, ticksLeft);
}

/** The phone's level bar, e.g. ▮▮▮▯▯▯▯▯▯ for level 3. */
export function levelBar(level: number): string {
  const l = clampLevel(level);
  return '▮'.repeat(l) + '▯'.repeat(MAX_LEVEL - l);
}

function hLine(out: Set<string>, y: number, x0: number, x1: number): void {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.add(`${String(x)},${String(y)}`);
}

function vLine(out: Set<string>, x: number, y0: number, y1: number): void {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) out.add(`${String(x)},${String(y)}`);
}

/** Wall layout of a maze, scaled to the board. */
export function mazeWalls(maze: Maze, width: number, height: number): Set<string> {
  const w = width;
  const h = height;
  const walls = new Set<string>();
  const border = (): void => {
    hLine(walls, 0, 0, w - 1);
    hLine(walls, h - 1, 0, w - 1);
    vLine(walls, 0, 0, h - 1);
    vLine(walls, w - 1, 0, h - 1);
  };
  switch (maze) {
    case 'none':
      break;
    case 'box':
      border();
      break;
    case 'tunnel': {
      // top and bottom walls, open at the sides, with a short bar in each half to steer around
      hLine(walls, 0, 0, w - 1);
      hLine(walls, h - 1, 0, w - 1);
      const y1 = Math.floor(h / 4);
      const y2 = h - 1 - Math.floor(h / 4);
      hLine(walls, y1, Math.floor(w / 4), Math.floor(w / 2) - 2);
      hLine(walls, y2, Math.ceil(w / 2) + 1, w - 1 - Math.floor(w / 4));
      break;
    }
    case 'mill': {
      // four arms like the sails of a windmill, each from a different edge
      const armX = Math.floor(w / 3);
      const armY = Math.floor(h / 3);
      vLine(walls, Math.floor(w / 4), 0, armY);
      hLine(walls, Math.floor(h / 4), w - 1, w - 1 - armX);
      vLine(walls, w - 1 - Math.floor(w / 4), h - 1, h - 1 - armY);
      hLine(walls, h - 1 - Math.floor(h / 4), 0, armX);
      break;
    }
    case 'rails': {
      // two long horizontal rails with open ends; the board wraps around them
      const x0 = Math.floor(w / 6);
      const x1 = w - 1 - Math.floor(w / 6);
      hLine(walls, Math.floor(h / 3), x0, x1);
      hLine(walls, h - 1 - Math.floor(h / 3), x0, x1);
      break;
    }
    case 'apartment': {
      // a box split into rooms, with doorways between them
      border();
      const midX = Math.floor(w / 2);
      const midY = Math.floor(h / 2);
      vLine(walls, midX, 1, h - 2);
      hLine(walls, midY, 1, w - 2);
      const door = (p: Point): void => {
        walls.delete(key(p));
      };
      // one doorway in each wall segment: one cell in the vertical walls, two in the horizontal
      door({ x: midX, y: Math.floor(midY / 2) });
      door({ x: midX, y: midY + Math.ceil((h - 2 - midY) / 2) });
      for (const dx of [0, 1]) {
        door({ x: Math.floor(midX / 2) + dx, y: midY });
        door({ x: midX + Math.ceil((w - 2 - midX) / 2) + dx, y: midY });
      }
      break;
    }
  }
  return walls;
}

function freeCell(
  width: number,
  height: number,
  blocked: ReadonlySet<string>,
  random: () => number,
): Point {
  const free: Point[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (!blocked.has(`${String(x)},${String(y)}`)) free.push({ x, y });
  return free[Math.floor(random() * free.length)] ?? { x: 0, y: 0 };
}

/**
 * Where a new snake starts: the row nearest the middle with room for it and a few cells to spare
 * ahead, so no maze kills it on its first moves.
 */
export function startPosition(
  width: number,
  height: number,
  walls: ReadonlySet<string>,
  length = 4,
): Point[] {
  const need = length + 4;
  const mid = Math.floor(height / 2);
  for (let d = 0; d < height; d++) {
    for (const y of d === 0 ? [mid] : [mid - d, mid + d]) {
      if (y < 0 || y >= height) continue;
      let run = 0;
      for (let x = 0; x < width; x++) {
        run = walls.has(`${String(x)},${String(y)}`) ? 0 : run + 1;
        if (run >= need) {
          const head = x - 4;
          return Array.from({ length }, (_, i) => ({ x: head - i, y }));
        }
      }
    }
  }
  return Array.from({ length }, (_, i) => ({ x: length - i, y: mid }));
}

export function newGame(opts: {
  width: number;
  height: number;
  level?: number;
  maze?: Maze;
  random?: () => number;
}): SnakeState {
  const { width, height } = opts;
  const maze = opts.maze ?? 'none';
  const walls = mazeWalls(maze, width, height);
  const snake = startPosition(width, height, walls);
  const blocked = new Set([...walls, ...snake.map(key)]);
  return {
    width,
    height,
    level: clampLevel(opts.level ?? 5),
    maze,
    walls,
    snake,
    dir: 'right',
    queue: [],
    food: freeCell(width, height, blocked, opts.random ?? Math.random),
    bonus: undefined,
    score: 0,
    eaten: 0,
    status: 'running',
  };
}

/** Queues a turn; reversing onto yourself is ignored. */
export function turn(state: SnakeState, dir: Dir): SnakeState {
  if (state.status === 'over') return state;
  const last = state.queue.at(-1) ?? state.dir;
  if (dir === last || dir === OPPOSITE[last] || state.queue.length >= 2) return state;
  return { ...state, queue: [...state.queue, dir] };
}

/** One move. The board wraps at its edges; walls and the tail end the game. */
export function tick(state: SnakeState, random: () => number = Math.random): SnakeState {
  if (state.status !== 'running') return state;
  const [next, ...queue] = state.queue;
  const dir = next ?? state.dir;
  const head = state.snake[0] ?? { x: 0, y: 0 };
  const moved = {
    x: (head.x + STEP[dir].x + state.width) % state.width,
    y: (head.y + STEP[dir].y + state.height) % state.height,
  };
  const eats = same(moved, state.food);
  // the tail moves away this move unless the snake grows, so following it is safe
  const body = eats ? state.snake : state.snake.slice(0, -1);
  if (state.walls.has(key(moved)) || body.some((p) => same(p, moved)))
    return { ...state, dir, queue, status: 'over' };

  const snake = [moved, ...body];
  let { score, eaten, food, bonus } = state;
  const blocked = (): Set<string> =>
    new Set([...state.walls, ...snake.map(key), key(food), ...(bonus ? [key(bonus)] : [])]);
  // an existing critter is caught or counts down; a new one appears after every few meals
  if (bonus !== undefined) {
    if (same(moved, bonus)) {
      score += bonusPoints(state.level, bonus.ticksLeft);
      bonus = undefined;
    } else {
      bonus = bonus.ticksLeft <= 1 ? undefined : { ...bonus, ticksLeft: bonus.ticksLeft - 1 };
    }
  }
  if (eats) {
    eaten += 1;
    score += foodPoints(state.level);
    food = freeCell(state.width, state.height, blocked(), random);
    if (eaten % BONUS_EVERY === 0 && bonus === undefined)
      bonus = { ...freeCell(state.width, state.height, blocked(), random), ticksLeft: BONUS_TICKS };
  }
  return { ...state, snake, dir, queue, food, bonus, score, eaten };
}

// ---- the phone's menus -------------------------------------------------------------------

export const MENU_ITEMS = [
  'New game',
  'Level',
  'Mazes',
  'Top score',
  'Instructions',
  'Quit',
] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];

export const PAUSE_ITEMS = ['Continue', 'New game', 'Menu'] as const;
export const OVER_ITEMS = ['Play again', 'Menu'] as const;

export interface SnakePrefs {
  level: number;
  maze: Maze;
  palette: Palette;
  /** Top score per `${level}:${maze}`. */
  scores: Record<string, number>;
}

export const DEFAULT_PREFS: SnakePrefs = { level: 5, maze: 'none', palette: 'colour', scores: {} };

export function scoreKey(level: number, maze: Maze): string {
  return `${String(clampLevel(level))}:${maze}`;
}

export function topScore(prefs: Pick<SnakePrefs, 'scores'>, level?: number, maze?: Maze): number {
  if (level !== undefined && maze !== undefined) return prefs.scores[scoreKey(level, maze)] ?? 0;
  return Math.max(0, ...Object.values(prefs.scores));
}

export type Screen =
  | { kind: 'menu'; index: number }
  | { kind: 'level' }
  | { kind: 'mazes'; index: number }
  | { kind: 'scores' }
  | { kind: 'help' }
  | { kind: 'game' }
  | { kind: 'paused'; index: number }
  | { kind: 'over'; index: number; newTop: boolean };

export interface LastGame {
  score: number;
  level: number;
  maze: Maze;
  newTop: boolean;
}

export interface SnakeApp {
  screen: Screen;
  prefs: SnakePrefs;
  game: SnakeState | undefined;
  last: LastGame | undefined;
  quit: boolean;
  width: number;
  height: number;
}

export type Input = Dir | 'enter' | 'back' | 'pause' | 'palette' | 'quit';

export function newApp(opts: { width: number; height: number; prefs?: SnakePrefs }): SnakeApp {
  return {
    screen: { kind: 'menu', index: 0 },
    prefs: opts.prefs ?? DEFAULT_PREFS,
    game: undefined,
    last: undefined,
    quit: false,
    width: opts.width,
    height: opts.height,
  };
}

function startGame(app: SnakeApp, random: () => number): SnakeApp {
  return {
    ...app,
    screen: { kind: 'game' },
    game: newGame({
      width: app.width,
      height: app.height,
      level: app.prefs.level,
      maze: app.prefs.maze,
      random,
    }),
  };
}

const wrap = (i: number, n: number): number => (i + n) % n;

/** The menus and game as one state machine, driven by key presses. */
export function press(app: SnakeApp, input: Input, random: () => number = Math.random): SnakeApp {
  const { screen } = app;
  if (input === 'palette' && screen.kind !== 'game') {
    const palette: Palette = app.prefs.palette === 'colour' ? 'lcd' : 'colour';
    return { ...app, prefs: { ...app.prefs, palette } };
  }
  switch (screen.kind) {
    case 'menu': {
      if (input === 'up' || input === 'down') {
        const index = wrap(screen.index + (input === 'up' ? -1 : 1), MENU_ITEMS.length);
        return { ...app, screen: { kind: 'menu', index } };
      }
      if (input === 'back' || input === 'left' || input === 'quit') return { ...app, quit: true };
      if (input !== 'enter' && input !== 'right') return app;
      switch (MENU_ITEMS[screen.index]) {
        case 'New game':
          return startGame(app, random);
        case 'Level':
          return { ...app, screen: { kind: 'level' } };
        case 'Mazes':
          return {
            ...app,
            screen: { kind: 'mazes', index: Math.max(0, MAZES.indexOf(app.prefs.maze)) },
          };
        case 'Top score':
          return { ...app, screen: { kind: 'scores' } };
        case 'Instructions':
          return { ...app, screen: { kind: 'help' } };
        default:
          return { ...app, quit: true };
      }
    }
    case 'level': {
      const delta =
        input === 'up' || input === 'right' ? 1 : input === 'down' || input === 'left' ? -1 : 0;
      if (delta !== 0) {
        const level = clampLevel(app.prefs.level + delta);
        return { ...app, prefs: { ...app.prefs, level } };
      }
      if (input === 'enter' || input === 'back' || input === 'quit')
        return { ...app, screen: { kind: 'menu', index: MENU_ITEMS.indexOf('Level') } };
      return app;
    }
    case 'mazes': {
      if (input === 'up' || input === 'down') {
        const index = wrap(screen.index + (input === 'up' ? -1 : 1), MAZES.length);
        return { ...app, screen: { kind: 'mazes', index } };
      }
      const back = { kind: 'menu' as const, index: MENU_ITEMS.indexOf('Mazes') };
      if (input === 'enter' || input === 'right') {
        const maze = MAZES[screen.index] ?? 'none';
        return { ...app, prefs: { ...app.prefs, maze }, screen: back };
      }
      if (input === 'back' || input === 'left' || input === 'quit') return { ...app, screen: back };
      return app;
    }
    case 'scores':
    case 'help': {
      if (input === 'enter' || input === 'back' || input === 'left' || input === 'quit') {
        const item = screen.kind === 'scores' ? 'Top score' : 'Instructions';
        return { ...app, screen: { kind: 'menu', index: MENU_ITEMS.indexOf(item) } };
      }
      return app;
    }
    case 'game': {
      if (!app.game) return startGame(app, random);
      if (input === 'pause' || input === 'back' || input === 'quit')
        return { ...app, screen: { kind: 'paused', index: 0 } };
      if (input === 'up' || input === 'down' || input === 'left' || input === 'right')
        return { ...app, game: turn(app.game, input) };
      return app;
    }
    case 'paused': {
      if (input === 'up' || input === 'down') {
        const index = wrap(screen.index + (input === 'up' ? -1 : 1), PAUSE_ITEMS.length);
        return { ...app, screen: { kind: 'paused', index } };
      }
      if (input === 'pause') return { ...app, screen: { kind: 'game' } };
      if (input === 'back' || input === 'left') return { ...app, screen: { kind: 'game' } };
      if (input === 'quit') return endGame(app, { kind: 'menu', index: 0 });
      if (input !== 'enter' && input !== 'right') return app;
      switch (PAUSE_ITEMS[screen.index]) {
        case 'Continue':
          return { ...app, screen: { kind: 'game' } };
        case 'New game':
          return startGame(endGame(app, { kind: 'menu', index: 0 }), random);
        default:
          return endGame(app, { kind: 'menu', index: 0 });
      }
    }
    case 'over': {
      if (input === 'up' || input === 'down') {
        const index = wrap(screen.index + (input === 'up' ? -1 : 1), OVER_ITEMS.length);
        return { ...app, screen: { ...screen, index } };
      }
      if (input === 'back' || input === 'left' || input === 'quit')
        return { ...app, screen: { kind: 'menu', index: 0 } };
      if (input !== 'enter' && input !== 'right') return app;
      return OVER_ITEMS[screen.index] === 'Play again'
        ? startGame(app, random)
        : { ...app, screen: { kind: 'menu', index: 0 } };
    }
  }
}

/** Records a finished (or abandoned) game: top scores and the last result. */
function endGame(app: SnakeApp, screen: Screen): SnakeApp {
  const game = app.game;
  if (!game) return { ...app, screen };
  const k = scoreKey(game.level, game.maze);
  const previous = app.prefs.scores[k] ?? 0;
  const newTop = game.score > previous;
  const scores = newTop ? { ...app.prefs.scores, [k]: game.score } : app.prefs.scores;
  return {
    ...app,
    screen: screen.kind === 'over' ? { ...screen, newTop } : screen,
    prefs: { ...app.prefs, scores },
    game: undefined,
    last: { score: game.score, level: game.level, maze: game.maze, newTop },
  };
}

/** One move of the running game; a crash shows the game-over screen. */
export function advance(app: SnakeApp, random: () => number = Math.random): SnakeApp {
  if (app.screen.kind !== 'game' || !app.game) return app;
  const game = tick(app.game, random);
  if (game.status !== 'over') return { ...app, game };
  const ended = endGame({ ...app, game }, { kind: 'over', index: 0, newTop: false });
  // keep the final board on screen behind the game-over box
  return { ...ended, game };
}

/** Maps a key press to an input: arrows, WASD and vim's hjkl steer. */
export function inputForKey(
  input: string,
  k: {
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    return?: boolean;
    escape?: boolean;
  },
): Input | undefined {
  if (k.upArrow === true || input === 'w' || input === 'k') return 'up';
  if (k.downArrow === true || input === 's' || input === 'j') return 'down';
  if (k.leftArrow === true || input === 'a' || input === 'h') return 'left';
  if (k.rightArrow === true || input === 'd' || input === 'l') return 'right';
  if (k.return === true) return 'enter';
  if (k.escape === true) return 'back';
  if (input === 'p' || input === ' ') return 'pause';
  if (input === 'c') return 'palette';
  if (input === 'q') return 'quit';
  return undefined;
}

/** Prefs from the saved app state (unknown or missing values fall back to defaults). */
export function prefsFromState(s: {
  snakeLevel?: number | undefined;
  snakeMaze?: string | undefined;
  snakePalette?: string | undefined;
  snakeScores?: Record<string, number> | undefined;
}): SnakePrefs {
  return {
    level: clampLevel(s.snakeLevel ?? DEFAULT_PREFS.level),
    maze: (MAZES as readonly string[]).includes(s.snakeMaze ?? '')
      ? (s.snakeMaze as Maze)
      : DEFAULT_PREFS.maze,
    palette: s.snakePalette === 'lcd' ? 'lcd' : 'colour',
    scores: { ...(s.snakeScores ?? {}) },
  };
}

/** The app-state fields that store `prefs` (plus the overall best, for older versions). */
export function stateFromPrefs(prefs: SnakePrefs): {
  snakeLevel: number;
  snakeMaze: Maze;
  snakePalette: Palette;
  snakeScores: Record<string, number>;
  snakeBest: number;
} {
  return {
    snakeLevel: prefs.level,
    snakeMaze: prefs.maze,
    snakePalette: prefs.palette,
    snakeScores: prefs.scores,
    snakeBest: topScore(prefs),
  };
}

/**
 * Hand-off between the /snake command and the game component (which ChatScreen renders): the
 * command loads the saved prefs, the game saves changes and reports the last game here.
 */
export interface SnakeSession {
  prefs: SnakePrefs;
  save: (prefs: SnakePrefs) => void;
  last: LastGame | undefined;
}

export const snakeSession: { current: SnakeSession | undefined } = { current: undefined };
