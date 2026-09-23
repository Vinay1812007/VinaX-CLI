/** Process exit codes. Documented in the README; scripts may rely on them. */
export const EXIT = {
  ok: 0,
  /** Runtime failure: no keys, invalid settings, every model failed. */
  error: 1,
  /** Bad command-line usage. */
  usage: 2,
  /** Interrupted by Ctrl+C (128 + SIGINT). */
  interrupted: 130,
} as const;
