/**
 * Snake, the way the Nokia phones played it: walls and your own tail end the game, every meal
 * makes you longer and faster, and a bonus critter shows up now and then for extra points.
 * Pure state transitions, so the UI only draws and times them.
 */

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Point {
  x: number;
  y: number;
}

export interface SnakeState {
  width: number;
  height: number;
  /** Head first. */
  snake: Point[];
  dir: Dir;
  /** Turns typed faster than the snake moves, applied one per tick. */
  queue: Dir[];
  food: Point;
  /** A bonus critter and the ticks it has left. */
  bonus: (Point & { ticksLeft: number }) | undefined;
  score: number;
  eaten: number;
  status: 'ready' | 'running' | 'paused' | 'over';
}

export const BONUS_EVERY = 5;
export const BONUS_TICKS = 40;
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const STEP: Record<Dir, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** Speed level 1–9: one level up every five meals, like the phone's speed setting. */
export function level(state: Pick<SnakeState, 'eaten'>): number {
  return Math.min(9, 1 + Math.floor(state.eaten / 5));
}

/** Milliseconds per move at the current level. */
export function tickMs(state: Pick<SnakeState, 'eaten'>): number {
  return Math.max(55, 170 - (level(state) - 1) * 14);
}

const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

function freeCell(
  width: number,
  height: number,
  taken: readonly Point[],
  random: () => number,
): Point {
  const free: Point[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (!taken.some((p) => p.x === x && p.y === y)) free.push({ x, y });
  return free[Math.floor(random() * free.length)] ?? { x: 0, y: 0 };
}

export function newGame(
  width: number,
  height: number,
  random: () => number = Math.random,
): SnakeState {
  const y = Math.floor(height / 2);
  const x = Math.max(4, Math.floor(width / 3));
  const snake = [0, 1, 2, 3].map((i) => ({ x: x - i, y }));
  return {
    width,
    height,
    snake,
    dir: 'right',
    queue: [],
    food: freeCell(width, height, snake, random),
    bonus: undefined,
    score: 0,
    eaten: 0,
    status: 'ready',
  };
}

/** Queues a turn (reversing onto yourself is ignored); the first turn also starts the game. */
export function turn(state: SnakeState, dir: Dir): SnakeState {
  if (state.status === 'over' || state.status === 'paused') return state;
  const last = state.queue.at(-1) ?? state.dir;
  const status = state.status === 'ready' ? 'running' : state.status;
  if (dir === last || dir === OPPOSITE[last] || state.queue.length >= 2)
    return status === state.status ? state : { ...state, status };
  return { ...state, status, queue: [...state.queue, dir] };
}

export function togglePause(state: SnakeState): SnakeState {
  if (state.status === 'running') return { ...state, status: 'paused' };
  if (state.status === 'paused') return { ...state, status: 'running' };
  return state;
}

/** One move. Eating grows the snake; walls and the tail end the game. */
export function tick(state: SnakeState, random: () => number = Math.random): SnakeState {
  if (state.status !== 'running') return state;
  const [next, ...queue] = state.queue;
  const dir = next ?? state.dir;
  const head = state.snake[0] ?? { x: 0, y: 0 };
  const moved = { x: head.x + STEP[dir].x, y: head.y + STEP[dir].y };
  const eats = same(moved, state.food);
  // the tail moves away this tick unless the snake grows
  const body = eats ? state.snake : state.snake.slice(0, -1);
  if (
    moved.x < 0 ||
    moved.y < 0 ||
    moved.x >= state.width ||
    moved.y >= state.height ||
    body.some((p) => same(p, moved))
  )
    return { ...state, dir, queue, status: 'over' };

  const snake = [moved, ...body];
  let { score, eaten, food, bonus } = state;
  if (eats) {
    eaten += 1;
    score += level({ eaten }) * 7;
    food = freeCell(state.width, state.height, [...snake, ...(bonus ? [bonus] : [])], random);
    if (eaten % BONUS_EVERY === 0 && bonus === undefined) {
      bonus = {
        ...freeCell(state.width, state.height, [...snake, food], random),
        ticksLeft: BONUS_TICKS,
      };
    }
  }
  if (bonus !== undefined) {
    if (same(moved, bonus)) {
      // the quicker you catch it, the more it is worth
      score += 20 + bonus.ticksLeft * 2;
      bonus = undefined;
    } else {
      bonus = bonus.ticksLeft <= 1 ? undefined : { ...bonus, ticksLeft: bonus.ticksLeft - 1 };
    }
  }
  return { ...state, snake, dir, queue, food, bonus, score, eaten };
}

/** Maps a key to a direction: arrows, WASD and vim's hjkl. */
export function dirForKey(
  input: string,
  key: { upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean },
): Dir | undefined {
  if (key.upArrow === true || input === 'w' || input === 'k') return 'up';
  if (key.downArrow === true || input === 's' || input === 'j') return 'down';
  if (key.leftArrow === true || input === 'a' || input === 'h') return 'left';
  if (key.rightArrow === true || input === 'd' || input === 'l') return 'right';
  return undefined;
}
