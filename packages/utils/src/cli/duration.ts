/** Parse a duration like `30s`, `5m`, `2h`, `100ms`, or a bare integer (milliseconds). */
export function parseDuration(input: string | undefined): number | undefined {
  if (input === undefined || input === '') return undefined;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(input);
  if (!m)
    throw new Error(`Invalid duration "${input}". Use e.g. "30s", "5m", "1h", or a number of ms.`);
  const n = Number(m[1]);
  switch (m[2]) {
    case undefined:
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
  }
  // Unreachable — regex guarantees one of the cases above matches.
  /* c8 ignore next */
  return undefined;
}
