import { describe, expect, it } from "vitest";
import { deepMatch, deepPartialMatch, Match } from "../match.js";

describe("deepMatch (exact)", () => {
  it("matches primitives", () => {
    expect(deepMatch(42, 42).pass).toBe(true);
    expect(deepMatch("hello", "hello").pass).toBe(true);
    expect(deepMatch(null, null).pass).toBe(true);
    expect(deepMatch(42, 43).pass).toBe(false);
  });

  it("matches arrays exactly", () => {
    expect(deepMatch([1, 2, 3], [1, 2, 3]).pass).toBe(true);
    expect(deepMatch([1, 2], [1, 2, 3]).pass).toBe(false);
    expect(deepMatch([1, 2, 3], [1, 2]).pass).toBe(false);
  });

  it("matches objects exactly", () => {
    expect(deepMatch({ a: 1, b: 2 }, { a: 1, b: 2 }).pass).toBe(true);
    expect(deepMatch({ a: 1, b: 2, c: 3 }, { a: 1, b: 2 }).pass).toBe(false); // extra key in actual
    expect(deepMatch({ a: 1 }, { a: 1, b: 2 }).pass).toBe(false); // missing key in actual
  });

  it("matches nested objects", () => {
    const actual = { a: { b: { c: 1 } } };
    expect(deepMatch(actual, { a: { b: { c: 1 } } }).pass).toBe(true);
    expect(deepMatch(actual, { a: { b: { c: 2 } } }).pass).toBe(false);
  });
});

describe("deepPartialMatch", () => {
  it("allows extra keys in actual", () => {
    const actual = { a: 1, b: 2, c: 3 };
    expect(deepPartialMatch(actual, { a: 1 }).pass).toBe(true);
    expect(deepPartialMatch(actual, { a: 1, b: 2 }).pass).toBe(true);
  });

  it("fails if expected key is missing", () => {
    expect(deepPartialMatch({ a: 1 }, { b: 2 }).pass).toBe(false);
  });

  it("recurses into nested objects partially", () => {
    const actual = { a: { b: 1, c: 2 }, d: 3 };
    expect(deepPartialMatch(actual, { a: { b: 1 } }).pass).toBe(true);
  });

  it("matches arrays by length and element", () => {
    expect(deepPartialMatch([1, 2, 3], [1, 2, 3]).pass).toBe(true);
    expect(deepPartialMatch([1, 2, 3], [1, 2]).pass).toBe(false); // length mismatch
  });
});

describe("Match.objectLike", () => {
  it("performs deep partial match", () => {
    const matcher = Match.objectLike({ a: 1 });
    expect(matcher.test({ a: 1, b: 2 }).pass).toBe(true);
    expect(matcher.test({ a: 2 }).pass).toBe(false);
    expect(matcher.test("string").pass).toBe(false);
  });
});

describe("Match.objectEquals", () => {
  it("performs exact match", () => {
    const matcher = Match.objectEquals({ a: 1 });
    expect(matcher.test({ a: 1 }).pass).toBe(true);
    expect(matcher.test({ a: 1, b: 2 }).pass).toBe(false);
  });
});

describe("Match.arrayWith", () => {
  it("finds subset in order", () => {
    const matcher = Match.arrayWith(["b", "d"]);
    expect(matcher.test(["a", "b", "c", "d", "e"]).pass).toBe(true);
  });

  it("fails if item not found", () => {
    const matcher = Match.arrayWith(["x"]);
    expect(matcher.test(["a", "b", "c"]).pass).toBe(false);
  });

  it("fails if out of order", () => {
    const matcher = Match.arrayWith(["c", "a"]);
    expect(matcher.test(["a", "b", "c"]).pass).toBe(false);
  });

  it("fails on non-array", () => {
    const matcher = Match.arrayWith(["a"]);
    expect(matcher.test("abc").pass).toBe(false);
  });
});

describe("Match.arrayEquals", () => {
  it("matches exact array", () => {
    const matcher = Match.arrayEquals([1, 2, 3]);
    expect(matcher.test([1, 2, 3]).pass).toBe(true);
    expect(matcher.test([1, 2]).pass).toBe(false);
    expect(matcher.test([1, 2, 3, 4]).pass).toBe(false);
  });
});

describe("Match.stringLikeRegexp", () => {
  it("matches regex string", () => {
    const matcher = Match.stringLikeRegexp("foo.*bar");
    expect(matcher.test("fooXbar").pass).toBe(true);
    expect(matcher.test("baz").pass).toBe(false);
  });

  it("matches RegExp instance", () => {
    const matcher = Match.stringLikeRegexp(/^hello/i);
    expect(matcher.test("Hello World").pass).toBe(true);
    expect(matcher.test("world hello").pass).toBe(false);
  });

  it("fails on non-string", () => {
    const matcher = Match.stringLikeRegexp(".*");
    expect(matcher.test(42).pass).toBe(false);
  });
});

describe("Match.absent", () => {
  it("passes on undefined", () => {
    expect(Match.absent().test(undefined).pass).toBe(true);
  });

  it("fails on present value", () => {
    expect(Match.absent().test(null).pass).toBe(false);
    expect(Match.absent().test("").pass).toBe(false);
    expect(Match.absent().test(0).pass).toBe(false);
  });
});

describe("Match.anyValue", () => {
  it("passes on any non-null/undefined value", () => {
    expect(Match.anyValue().test("hello").pass).toBe(true);
    expect(Match.anyValue().test(0).pass).toBe(true);
    expect(Match.anyValue().test({}).pass).toBe(true);
  });

  it("fails on null/undefined", () => {
    expect(Match.anyValue().test(null).pass).toBe(false);
    expect(Match.anyValue().test(undefined).pass).toBe(false);
  });
});

describe("Match.not", () => {
  it("inverts a literal match", () => {
    const matcher = Match.not({ a: 1 });
    expect(matcher.test({ a: 2 }).pass).toBe(true);
    expect(matcher.test({ a: 1 }).pass).toBe(false);
    expect(matcher.test({ a: 1, b: 2 }).pass).toBe(false); // partial match still matches
  });

  it("inverts a matcher", () => {
    const matcher = Match.not(Match.stringLikeRegexp("foo"));
    expect(matcher.test("bar").pass).toBe(true);
    expect(matcher.test("foobar").pass).toBe(false);
  });
});

describe("matchers compose inside objects", () => {
  it("works with deepPartialMatch", () => {
    const result = deepPartialMatch(
      { name: "test-vpc", region: "us-east-1", tags: ["a", "b"] },
      { name: Match.stringLikeRegexp("test-.*"), tags: Match.arrayWith(["b"]) },
    );
    expect(result.pass).toBe(true);
  });

  it("reports nested failures", () => {
    const result = deepPartialMatch(
      { spec: { forProvider: { region: "us-west-2" } } },
      { spec: { forProvider: { region: "us-east-1" } } },
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain("spec.forProvider.region");
  });
});
