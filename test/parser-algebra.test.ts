/**
 * Unit tests for the language algebra (Empty, Epsilon, Token, Alt, Seq, Rep, Red).
 * Exercises these through the Grammar combinators + ZipperDriver so we test
 * the observable semantics rather than internals.
 */

import { assertEquals } from "@std/assert";
import { Grammar } from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ─── Helpers ────────────────────────────────────────────────────────── */

/** Thin grammar that just wraps a combinator for single-shot tests. */
class G extends Grammar<{ r: unknown }> {
  constructor(private readonly p: Parser<unknown>) {
    super();
  }
  start(): Parser<unknown> {
    return this.p;
  }
}

function parse(p: Parser<unknown>, input: string): unknown[] {
  return [...new G(p).parse(input)];
}
function accepts(p: Parser<unknown>, input: string): boolean {
  return new G(p).recognize(input);
}

/* ─── Combinator helpers accessible outside Grammar ─────────────────── */

/* We need an instance to access the protected helpers; use a throwaway. */
const _ = new class extends Grammar<{ r: unknown }> {
  override start(): Parser<unknown> {
    throw new Error("unused");
  }
  override char(c: string) {
    return super.char(c);
  }
  override pred(p: (c: string) => boolean, l?: string) {
    return super.pred(p, l);
  }
  override epsilon<T>(v: T) {
    return super.epsilon(v);
  }
  override empty() {
    return super.empty();
  }
  override or<T>(...ps: Parser<T>[]) {
    return super.or(...ps);
  }
  override seq<Ts extends readonly unknown[]>(
    ...ps: { [K in keyof Ts]: Parser<Ts[K]> }
  ) {
    return super.seq<Ts>(...ps);
  }
  override literal(s: string) {
    return super.literal(s);
  }
  override chain<T, U>(
    first: Parser<T>,
    fn: (t: T) => Parser<U>,
  ): Parser<[T, U]> {
    return super.chain(first, fn);
  }
}();

/* ─── Empty ──────────────────────────────────────────────────────────── */

Deno.test("Empty", async (t) => {
  const empty = _.empty();

  await t.step("rejects everything", () => {
    assertEquals(accepts(empty, ""), false);
    assertEquals(accepts(empty, "a"), false);
  });
  await t.step('produces no parse trees on ""', () => {
    assertEquals(parse(empty, ""), []);
  });
});

/* ─── Epsilon ────────────────────────────────────────────────────────── */

Deno.test("Epsilon", async (t) => {
  const eps = _.epsilon(42);

  await t.step("accepts ε", () => assertEquals(accepts(eps, ""), true));
  await t.step(
    "rejects non-empty input",
    () => assertEquals(accepts(eps, "a"), false),
  );
  await t.step("returns its value on ε", () => {
    assertEquals(parse(eps, ""), [42]);
  });
});

/* ─── Token / char ───────────────────────────────────────────────────── */

Deno.test("char / Token", async (t) => {
  const a = _.char("a");

  await t.step("rejects ε", () => assertEquals(accepts(a, ""), false));
  await t.step("accepts the matching character", () => {
    assertEquals(accepts(a, "a"), true);
    assertEquals(parse(a, "a"), ["a"]);
  });
  await t.step(
    "rejects other characters",
    () => assertEquals(accepts(a, "b"), false),
  );
});

/* ─── pred / PredTok ─────────────────────────────────────────────────── */

Deno.test("pred", async (t) => {
  const digit = _.pred((c) => c >= "0" && c <= "9", "<digit>");

  await t.step(
    "accepts a digit",
    () => assertEquals(accepts(digit, "5"), true),
  );
  await t.step(
    "rejects a non-digit",
    () => assertEquals(accepts(digit, "a"), false),
  );
  await t.step("returns the matched character", () => {
    assertEquals(parse(digit, "7"), ["7"]);
  });
});

/* ─── Alt (A ∪ B) ────────────────────────────────────────────────────── */

Deno.test("Alt (A ∪ B)", async (t) => {
  const aOrB = _.or(_.char("a"), _.char("b"));

  await t.step("accepts either branch", () => {
    assertEquals(accepts(aOrB, "a"), true);
    assertEquals(accepts(aOrB, "b"), true);
  });
  await t.step(
    "rejects non-matching input",
    () => assertEquals(accepts(aOrB, "c"), false),
  );
  await t.step(
    "parse-forest contains both branch results when both nullable",
    () => {
      const e1 = _.epsilon(1);
      const e2 = _.epsilon(2);
      assertEquals(parse(_.or(e1, e2), "").sort(), [1, 2]);
    },
  );
});

/* ─── Seq (A ○ B) ────────────────────────────────────────────────────── */

Deno.test("Seq (A ○ B)", async (t) => {
  const ab = _.seq(_.char("a"), _.char("b"));

  await t.step("accepts the exact concatenation", () => {
    assertEquals(accepts(ab, "ab"), true);
    assertEquals(parse(ab, "ab"), [["a", "b"]]);
  });
  await t.step(
    "rejects partial input",
    () => assertEquals(accepts(ab, "a"), false),
  );
  await t.step(
    "rejects reversed input",
    () => assertEquals(accepts(ab, "ba"), false),
  );
});

/* ─── Rep (A*) ───────────────────────────────────────────────────────── */

Deno.test("Rep (A*)", async (t) => {
  const aStar = _.char("a").many();

  await t.step("accepts ε (empty match = [])", () => {
    assertEquals(accepts(aStar, ""), true);
    assertEquals(parse(aStar, ""), [[]]);
  });
  await t.step("accepts one token", () => {
    assertEquals(parse(aStar, "a"), [["a"]]);
  });
  await t.step("accepts multiple tokens", () => {
    assertEquals(parse(aStar, "aa"), [["a", "a"]]);
  });
  await t.step(
    "rejects non-matching tokens",
    () => assertEquals(accepts(aStar, "b"), false),
  );
});

/* ─── map / Red ──────────────────────────────────────────────────────── */

Deno.test("map (semantic action)", async (t) => {
  const num = _.char("1").map((c) => parseInt(c, 10));

  await t.step("applies the function to parse trees", () => {
    assertEquals(parse(num, "1"), [1]);
  });
  await t.step(
    "rejects non-matching input",
    () => assertEquals(accepts(num, "2"), false),
  );
});

/* ─── literal ────────────────────────────────────────────────────────── */

Deno.test("literal", async (t) => {
  const hello = _.literal("hello");

  await t.step("accepts the exact string", () => {
    assertEquals(accepts(hello, "hello"), true);
    assertEquals(parse(hello, "hello"), ["hello"]);
  });
  await t.step(
    "rejects a prefix",
    () => assertEquals(accepts(hello, "hell"), false),
  );
  await t.step(
    "rejects a superset",
    () => assertEquals(accepts(hello, "helloo"), false),
  );
});

/* ─── opt ────────────────────────────────────────────────────────────── */

Deno.test("opt (A?)", async (t) => {
  const mA = _.char("a").opt();

  await t.step("accepts ε (value = undefined)", () => {
    assertEquals(accepts(mA, ""), true);
    assertEquals(parse(mA, ""), [undefined]);
  });
  await t.step("accepts the token", () => {
    assertEquals(parse(mA, "a"), ["a"]);
  });
});

/* ─── exception guards ───────────────────────────────────────────────── */

Deno.test("map — throwing semantic action drops the branch", () => {
  // A .map() callback that throws should not crash the parse driver;
  // the branch is silently dropped (empty parse forest).
  const p = _.char("a").map(() => {
    throw new Error("boom");
  });
  assertEquals(parse(p, "a"), []);
});

Deno.test("chain — throwing callback drops the branch", () => {
  // A chain callback that throws should not crash the parse driver;
  // the branch is silently dropped.
  const p = _.chain(_.char("a"), () => {
    throw new Error("boom");
  });
  assertEquals(parse(p, "a"), []);
});

Deno.test("map — non-throwing branch still succeeds alongside a throwing one", () => {
  // In an alternation, one branch's .map() throws but the other succeeds.
  const p = _.or(
    _.char("a").map(() => {
      throw new Error("boom");
    }),
    _.char("a").map(() => "ok"),
  );
  assertEquals(parse(p, "a"), ["ok"]);
});

/* ─── chain (monadic bind) ───────────────────────────────────────────── */

Deno.test("chain — basic [T, U] pairing", async (t) => {
  // Parse 'a', then use the result to parse 'b'. Result is ["a", "b"].
  const p = _.chain(_.char("a"), () => _.char("b"));

  await t.step("parses 'ab' as ['a', 'b']", () => {
    assertEquals(parse(p, "ab"), [["a", "b"]]);
  });
  await t.step("rejects 'ax'", () => {
    assertEquals(parse(p, "ax"), []);
  });
  await t.step("rejects 'a' (missing second)", () => {
    assertEquals(parse(p, "a"), []);
  });
});

Deno.test("chain — second parser depends on first result", async (t) => {
  // Parse a char, then use it to decide what to parse next.
  // If 'a' → expect '1'; if 'b' → expect '2'.
  const p = _.chain(
    _.char("a").or(_.char("b")),
    (x) => x === "a" ? _.char("1") : _.char("2"),
  );

  await t.step("'a1' → ['a', '1']", () => {
    assertEquals(parse(p, "a1"), [["a", "1"]]);
  });
  await t.step("'b2' → ['b', '2']", () => {
    assertEquals(parse(p, "b2"), [["b", "2"]]);
  });
  await t.step("'a2' rejected (wrong second)", () => {
    assertEquals(parse(p, "a2"), []);
  });
});

Deno.test("chain — ambiguity: multiple first results produce multiple pairs", async (t) => {
  // Ambiguous first parser: 'a' | 'a' produces two parse trees.
  // Each triggers the chain callback, producing two ['a', 'b'] pairs.
  const p = _.chain(_.char("a").or(_.char("a")), () => _.char("b"));

  await t.step("'ab' produces two ['a', 'b'] pairs", () => {
    const results = parse(p, "ab");
    assertEquals(results.length, 2);
    assertEquals(results[0], ["a", "b"]);
    assertEquals(results[1], ["a", "b"]);
  });
});

Deno.test("chain — first parser fails → empty forest", async (t) => {
  const p = _.chain(_.empty(), () => _.char("b"));

  await t.step("produces no parse trees", () => {
    assertEquals(parse(p, "b"), []);
  });
});

Deno.test("chain — second parser fails → empty forest", async (t) => {
  const p = _.chain(_.char("a"), () => _.empty());

  await t.step("produces no parse trees", () => {
    assertEquals(parse(p, "a"), []);
  });
});

Deno.test("chain — interaction with left recursion", async (t) => {
  // Left-recursive grammar using chain: S ::= S 'a' | 'a'
  // Each chain step appends 'a' to the accumulated string.
  const { rule } = await import("../src/index.ts");
  class LR extends Grammar<{ s: string }> {
    override start(): Parser<string> {
      return this.s;
    }
    @rule
    get s(): Parser<string> {
      return this.or(
        this.chain(this.s, (l: string) => this.char("a").map((r) => l + r))
          .map(([, result]) => result),
        this.char("a"),
      );
    }
  }

  await t.step("'a' → ['a']", () => {
    assertEquals([...new LR().parse("a")], ["a"]);
  });
  await t.step("'aa' → ['aa']", () => {
    assertEquals([...new LR().parse("aa")], ["aa"]);
  });
  await t.step("'aaa' → ['aaa']", () => {
    assertEquals([...new LR().parse("aaa")], ["aaa"]);
  });
});

Deno.test("chain — nested chain flattening", async (t) => {
  // chain(a, a => chain(b, b => c)) → [["a", ["b", "c"]]
  // With .map extraction: flatten to just "c"
  const p = _.chain(
    _.char("a"),
    () => _.chain(_.char("b"), () => _.char("c")).map(([, r]) => r),
  ).map(([, r]) => r);

  await t.step("'abc' → ['c'] (flattened)", () => {
    assertEquals(parse(p, "abc"), ["c"]);
  });
});

Deno.test("chain — epsilon as first or second", async (t) => {
  await t.step("epsilon first: [42, 'a']", () => {
    const p = _.chain(_.epsilon(42), () => _.char("a"));
    assertEquals(parse(p, "a"), [[42, "a"]]);
  });

  await t.step("epsilon second: ['a', 99]", () => {
    const p = _.chain(_.char("a"), () => _.epsilon(99));
    assertEquals(parse(p, "a"), [["a", 99]]);
  });
});
