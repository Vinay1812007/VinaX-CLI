import { useCallback, useRef, useState, type RefObject } from 'react';

/**
 * State mirrored in a ref. Key handlers read `ref.current`, so two keystrokes that arrive before
 * React re-renders both see the latest value instead of a stale closure.
 */
export function useRefState<T>(
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void, RefObject<T>] {
  const ref = useRef(initial);
  const [value, setValue] = useState(initial);
  const set = useCallback((next: T | ((prev: T) => T)) => {
    ref.current = typeof next === 'function' ? (next as (prev: T) => T)(ref.current) : next;
    setValue(ref.current);
  }, []);
  return [value, set, ref];
}
