/** Symbol used to identify Matcher instances. */
export const MATCHER = Symbol.for("xplane.devtools.matcher");

/** Result of a match operation. */
export interface MatchResult {
  /** Whether the match succeeded. */
  pass: boolean;
  /** Human-readable failure messages (empty if pass is true). */
  failures: string[];
}

/** Interface for custom matchers. */
export interface Matcher {
  readonly [MATCHER]: true;
  test(actual: unknown): MatchResult;
}

/** Check whether a value is a Matcher instance. */
export function isMatcher(value: unknown): value is Matcher {
  return (
    typeof value === "object" &&
    value !== null &&
    MATCHER in value &&
    (value as Matcher)[MATCHER] === true
  );
}

function pass(): MatchResult {
  return { pass: true, failures: [] };
}

function fail(message: string): MatchResult {
  return { pass: false, failures: [message] };
}

function merge(results: MatchResult[]): MatchResult {
  const failures = results.flatMap((r) => r.failures);
  return { pass: failures.length === 0, failures };
}

/**
 * Deep-match `actual` against `expected`.
 * - If `expected` is a Matcher, delegates to its `.test()`.
 * - Literal objects are matched recursively (deep-partial by default via objectLike semantics at the top level is handled by the caller).
 * - This function performs EXACT matching — partial matching is handled by ObjectLikeMatcher.
 */
export function deepMatch(actual: unknown, expected: unknown, path = ""): MatchResult {
  if (isMatcher(expected)) {
    const result = expected.test(actual);
    if (!result.pass) {
      return { pass: false, failures: result.failures.map((f) => (path ? `${path}: ${f}` : f)) };
    }
    return pass();
  }

  // Null / undefined / primitives
  if (expected === null || expected === undefined || typeof expected !== "object") {
    if (actual === expected) return pass();
    return fail(
      path
        ? `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }

  // Arrays
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return fail(`${path || "value"}: expected an array, got ${typeof actual}`);
    }
    if (actual.length !== expected.length) {
      return fail(
        `${path || "value"}: expected array of length ${expected.length}, got length ${actual.length}`,
      );
    }
    const results: MatchResult[] = [];
    for (let i = 0; i < expected.length; i++) {
      results.push(deepMatch(actual[i], expected[i], `${path}[${i}]`));
    }
    return merge(results);
  }

  // Objects (exact match — all keys in expected must match, no extra keys allowed)
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return fail(`${path || "value"}: expected an object, got ${JSON.stringify(actual)}`);
  }
  const expectedObj = expected as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;
  const results: MatchResult[] = [];

  // Check expected keys exist and match
  for (const key of Object.keys(expectedObj)) {
    results.push(deepMatch(actualObj[key], expectedObj[key], path ? `${path}.${key}` : key));
  }
  // Check no extra keys in actual
  for (const key of Object.keys(actualObj)) {
    if (!(key in expectedObj)) {
      results.push(fail(`${path ? `${path}.${key}` : key}: unexpected key`));
    }
  }
  return merge(results);
}

/**
 * Deep-partial match: all keys in `expected` must match in `actual`, but
 * `actual` may have additional keys at any level.
 */
export function deepPartialMatch(actual: unknown, expected: unknown, path = ""): MatchResult {
  if (isMatcher(expected)) {
    const result = expected.test(actual);
    if (!result.pass) {
      return { pass: false, failures: result.failures.map((f) => (path ? `${path}: ${f}` : f)) };
    }
    return pass();
  }

  if (expected === null || expected === undefined || typeof expected !== "object") {
    if (actual === expected) return pass();
    return fail(
      path
        ? `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return fail(`${path || "value"}: expected an array, got ${typeof actual}`);
    }
    if (actual.length !== expected.length) {
      return fail(
        `${path || "value"}: expected array of length ${expected.length}, got length ${actual.length}`,
      );
    }
    const results: MatchResult[] = [];
    for (let i = 0; i < expected.length; i++) {
      results.push(deepPartialMatch(actual[i], expected[i], `${path}[${i}]`));
    }
    return merge(results);
  }

  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return fail(`${path || "value"}: expected an object, got ${JSON.stringify(actual)}`);
  }

  const expectedObj = expected as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;
  const results: MatchResult[] = [];

  // Only check keys present in expected — actual may have extras
  for (const key of Object.keys(expectedObj)) {
    if (!(key in actualObj)) {
      results.push(fail(`${path ? `${path}.${key}` : key}: key not found in actual`));
    } else {
      results.push(
        deepPartialMatch(actualObj[key], expectedObj[key], path ? `${path}.${key}` : key),
      );
    }
  }
  return merge(results);
}

// ─── Matcher Implementations ────────────────────────────────────────────

class ObjectLikeMatcher implements Matcher {
  readonly [MATCHER] = true as const;
  constructor(private readonly pattern: object) {}
  test(actual: unknown): MatchResult {
    return deepPartialMatch(actual, this.pattern);
  }
}

class ObjectEqualsMatcher implements Matcher {
  readonly [MATCHER] = true as const;
  constructor(private readonly pattern: object) {}
  test(actual: unknown): MatchResult {
    return deepMatch(actual, this.pattern);
  }
}

class ArrayWithMatcher implements Matcher {
  readonly [MATCHER] = true as const;
  constructor(private readonly items: unknown[]) {}
  test(actual: unknown): MatchResult {
    if (!Array.isArray(actual)) {
      return fail(`expected an array, got ${typeof actual}`);
    }
    // Each item in `this.items` must appear in `actual` in order (not necessarily contiguous)
    let searchStart = 0;
    for (let i = 0; i < this.items.length; i++) {
      let found = false;
      for (let j = searchStart; j < actual.length; j++) {
        const r = deepPartialMatch(actual[j], this.items[i]);
        if (r.pass) {
          searchStart = j + 1;
          found = true;
          break;
        }
      }
      if (!found) {
        return fail(
          `arrayWith: could not find match for item at index ${i}: ${JSON.stringify(this.items[i])}`,
        );
      }
    }
    return pass();
  }
}

class ArrayEqualsMatcher implements Matcher {
  readonly [MATCHER] = true as const;
  constructor(private readonly items: unknown[]) {}
  test(actual: unknown): MatchResult {
    return deepMatch(actual, this.items);
  }
}

class StringLikeRegexpMatcher implements Matcher {
  readonly [MATCHER] = true as const;
  private readonly regex: RegExp;
  constructor(pattern: string | RegExp) {
    this.regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  }
  test(actual: unknown): MatchResult {
    if (typeof actual !== "string") {
      return fail(`expected a string, got ${typeof actual}`);
    }
    if (!this.regex.test(actual)) {
      return fail(`expected string matching ${this.regex}, got "${actual}"`);
    }
    return pass();
  }
}

class AbsentMatcher implements Matcher {
  readonly [MATCHER] = true as const;
  test(actual: unknown): MatchResult {
    if (actual !== undefined) {
      return fail(`expected absent (undefined), got ${JSON.stringify(actual)}`);
    }
    return pass();
  }
}

class AnyValueMatcher implements Matcher {
  readonly [MATCHER] = true as const;
  test(actual: unknown): MatchResult {
    if (actual === null || actual === undefined) {
      return fail(`expected any value, got ${actual}`);
    }
    return pass();
  }
}

class NotMatcher implements Matcher {
  readonly [MATCHER] = true as const;
  constructor(private readonly pattern: unknown) {}
  test(actual: unknown): MatchResult {
    const inner = isMatcher(this.pattern)
      ? this.pattern.test(actual)
      : deepPartialMatch(actual, this.pattern);
    if (inner.pass) {
      return fail(`expected NOT to match, but matched: ${JSON.stringify(actual)}`);
    }
    return pass();
  }
}

/**
 * Factory for composable matchers used in assertions.
 *
 * @example
 * ```ts
 * template.hasResourceSpec('v1', 'ConfigMap', {
 *   data: Match.objectLike({ key: 'value' }),
 * });
 * ```
 */
export class Match {
  private constructor() {}

  /** Deep-partial object match — actual may be a superset of pattern. */
  static objectLike(pattern: object): Matcher {
    return new ObjectLikeMatcher(pattern);
  }

  /** Exact object match — actual must equal pattern exactly (same keys, same values). */
  static objectEquals(pattern: object): Matcher {
    return new ObjectEqualsMatcher(pattern);
  }

  /** Array subset match — items must appear in actual in order. */
  static arrayWith(items: unknown[]): Matcher {
    return new ArrayWithMatcher(items);
  }

  /** Exact array match — actual must equal items exactly. */
  static arrayEquals(items: unknown[]): Matcher {
    return new ArrayEqualsMatcher(items);
  }

  /** String regex match. */
  static stringLikeRegexp(pattern: string | RegExp): Matcher {
    return new StringLikeRegexpMatcher(pattern);
  }

  /** Asserts the value is absent (undefined). */
  static absent(): Matcher {
    return new AbsentMatcher();
  }

  /** Asserts any non-null/non-undefined value is present. */
  static anyValue(): Matcher {
    return new AnyValueMatcher();
  }

  /** Inverts a match — asserts the value does NOT match the given pattern. */
  static not(pattern: unknown): Matcher {
    return new NotMatcher(pattern);
  }
}
