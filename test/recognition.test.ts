/**
 * Recognition tests on canonical (left-)recursive grammars.
 * Demonstrates that derivative parsing terminates on cyclic grammars via the
 * lazy `@rule` reference + LFP nullable.
 */

import { assert, assertEquals } from "@std/assert";
import { char, epsilon, Grammar, or, rule, seq } from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ─── Balanced parens (right-recursive form) ─────────────────────────── */
//   S = '(' S ')' S | ε
class BalancedParens extends Grammar<{ s: string }> {
  start(): Parser<string> {
    return this.s;
  }

  @rule
  get s(): Parser<string> {
    return or(
      seq(char("("), this.s, char(")"), this.s).map(() => "ok"),
      epsilon("ok"),
    );
  }
}

Deno.test("Balanced parens (right-recursive)", async (t) => {
  const g = new BalancedParens();

  await t.step("accepts ε", () => assertEquals(g.recognize(""), true));
  await t.step("accepts ()", () => assertEquals(g.recognize("()"), true));
  await t.step("accepts (())", () => assertEquals(g.recognize("(())"), true));
  await t.step("accepts ()()", () => assertEquals(g.recognize("()()"), true));
  await t.step(
    "accepts deeply nested",
    () => assertEquals(g.recognize("((()))"), true),
  );
  await t.step("rejects (", () => assertEquals(g.recognize("("), false));
  await t.step("rejects )(", () => assertEquals(g.recognize(")("), false));
  await t.step("rejects (()", () => assertEquals(g.recognize("(()"), false));
});

/* ─── Left-recursive arithmetic — Russ Cox's "ambiguous" challenge ─────── */
//   S = S '+' S | '1'
class AmbiguousAdd extends Grammar<{ s: number }> {
  start(): Parser<number> {
    return this.s;
  }

  @rule
  get s(): Parser<number> {
    return or(
      seq(this.s, char("+"), this.s)
        .map(([l, , r]) => l + r),
      char("1").map(() => 1),
    );
  }
}

Deno.test("Left-recursive ambiguous add (S = S+S | 1)", async (t) => {
  const g = new AmbiguousAdd();

  await t.step("accepts 1", () => assertEquals(g.recognize("1"), true));
  await t.step("accepts 1+1", () => assertEquals(g.recognize("1+1"), true));
  await t.step("accepts 1+1+1", () => assertEquals(g.recognize("1+1+1"), true));
  await t.step("rejects 1+", () => assertEquals(g.recognize("1+"), false));
  await t.step("rejects ++", () => assertEquals(g.recognize("++"), false));
  await t.step("terminates on a moderate chained input", () => {
    const input = Array(20).fill("1").join("+");
    const t0 = Date.now();
    assertEquals(g.recognize(input), true);
    assert(
      Date.now() - t0 < 5000,
      `should finish in < 5s (took ${Date.now() - t0}ms)`,
    );
  });
  await t.step("rejects a moderate chained invalid input", () => {
    const input = Array(20).fill("1").join("+") + "++";
    const t0 = Date.now();
    assertEquals(g.recognize(input), false);
    assert(
      Date.now() - t0 < 5000,
      `should finish in < 5s (took ${Date.now() - t0}ms)`,
    );
  });
});
