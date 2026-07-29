/**
 * Regression test for issue #28: parameterised `@rule` memoisation re-entry
 * produces duplicate results.
 *
 * When a `@rule` getter (e.g. `ws`) is called at the same position from
 * different call sites within a sequence, the shared `DelayedExp`'s forced
 * body accumulates parents across call sites. `completeAt` then broadcasts
 * each value to ALL parents, so the same value reaches `topValues` multiple
 * times — producing duplicate parse results (2ⁿ for n levels of nesting).
 *
 * The duplicate is only visible when the semantic value is an object (`Set`
 * deduplicates primitives by structural equality but not objects by
 * reference).
 *
 * Root cause: `DelayedExp.descend` delegated to `this.force().goDown(…)`,
 * so the forced body's `Mem` was shared across all `DelayedExp` instances.
 * When two call sites descended the same body at the same position, the
 * body's `goDown` re-entry re-flowed values to both — producing duplicates.
 *
 * Fix (v4.0.1): `DelayedExp.descend` now calls `this.force().descend(driver, m)`
 * directly, bypassing the body's `goDown` memo. Each `DelayedExp` descent
 * is independent. Left-recursion growth is preserved because it operates on
 * the `DelayedExp`'s own `goDown` re-entry, not the body's.
 *
 * Base case (v4.0.2, issue #30): the v4.0.1 fix left a residual duplicate
 * when a `@rule` getter was re-entered at the *same* position from two call
 * sites (e.g. `ws` before and after `(`). The `DelayedExp`'s own `goDown`
 * re-entry re-flowed the already-completed value to the new parent, and that
 * re-flow is required for left-recursion growth so it cannot be removed.
 * For multi-argument variant construction via `sepBy` this constant factor
 * compounded to 2ⁿ across nesting levels. The v4.0.2 fix threads a
 * *derivation path* (the sequence of `AltExp` branch choices from the root)
 * through the engine: values re-flowed within ONE derivation share a path
 * and are collapsed at the top, while values from genuinely different
 * `AltExp` branches (real ambiguity) keep distinct paths and are preserved.
 * The base case now yields a single result.
 */

import { assertEquals } from "@std/assert";
import {
  char,
  epsilon,
  Grammar,
  or,
  type Parser,
  pred,
  rule,
  sepBy,
  seq,
} from "../src/index.ts";

/* ── Grammar mirroring the lapis-lang structure ─────────────────────── */
//
//   start()     = exprProd(null)
//   exprProd(c) = atomProd(c)
//   atomProd(c) = "(" ws exprProd(c) ws ")"
//               | variantName ws "(" ws sepBy(atomProd(c), ws "," ws) ws ")"
//               | ident
//   ws          = wsChar ws | ε                (recursive @rule getter)
//   variantName = pascalFirst identRest
//   ident       = identFirst identRest
//   identRest   = identChar identRest | ε     (recursive @rule getter)
//
// The `ws` @rule getter is called at multiple positions within `atomProd`'s
// sequences. When `atomProd(null)` is re-entered at a different position
// (via `exprProd(null)` in the parenthesised branch or `sepBy` in the
// variant branch), the shared forced body's `goDown` re-entry would re-flow
// values to the new `DelayedExp`'s `Mem` — producing duplicates.

class VariantGrammar
  extends Grammar<{ r: { variant: string } | { var: string } }> {
  override start(): Parser<{ variant: string } | { var: string }> {
    return this.exprProd(null);
  }

  @rule
  exprProd(ctx: unknown): Parser<{ variant: string } | { var: string }> {
    return this.atomProd(ctx);
  }

  @rule
  protected atomProd(
    ctx: unknown,
  ): Parser<{ variant: string } | { var: string }> {
    return or(
      // ( expr )
      seq(char("("), this.ws, this.exprProd(ctx), this.ws, char(")"))
        .map(([, , e]) => e),
      // Variant: Ident(args)
      seq(
        this.variantName,
        this.ws,
        char("("),
        this.ws,
        sepBy(this.atomProd(ctx), seq(this.ws, char(","), this.ws)),
        this.ws,
        char(")"),
      ).map(([name]) => ({ variant: name as string })),
      // Variable
      this.ident.map((name) => ({ var: name })),
    );
  }

  // ── Lexemes (recursive @rule getters) ──────────────────────────────

  @rule
  protected get variantName(): Parser<string> {
    return seq(this.pascalFirst, this.identRest).map(([h, t]) => h + t);
  }

  protected get pascalFirst(): Parser<string> {
    return pred((c) => c >= "A" && c <= "Z", "<Pascal>");
  }

  @rule
  protected get ident(): Parser<string> {
    return seq(this.identFirst, this.identRest).map(([h, t]) => h + t);
  }

  protected get identFirst(): Parser<string> {
    return pred((c) => (c >= "a" && c <= "z") || c === "_", "<ident-head>");
  }

  @rule
  protected get identRest(): Parser<string> {
    return or(
      seq(this.identChar, this.identRest).map(([c, cs]) => c + cs),
      epsilon(""),
    );
  }

  protected get identChar(): Parser<string> {
    return pred(
      (c) =>
        (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") ||
        (c >= "0" && c <= "9") || c === "_",
      "<ident-char>",
    );
  }

  @rule
  protected override get ws(): Parser<string> {
    return or(seq(this.wsChar, this.ws).map(([c, cs]) => c + cs), epsilon(""));
  }

  protected get wsChar(): Parser<string> {
    return pred(
      (c) => c === " " || c === "\t" || c === "\n" || c === "\r",
      "<ws>",
    );
  }
}

/* ── Left-recursive grammar (regression guard) ─────────────────────── */
//
// The fix changes `DelayedExp.descend` to bypass the body's `goDown` memo.
// This must NOT break left-recursion growth, which relies on the
// `DelayedExp`'s own `goDown` re-entry (not the body's).

class LeftRecGrammar extends Grammar<{ r: unknown }> {
  override start(): Parser<unknown> {
    return this.appProd(null);
  }

  // appProd(c) = appProd(c) " " atomProd(c) | atomProd(c)   (left-recursive)
  @rule
  protected appProd(ctx: unknown): Parser<unknown> {
    return or(
      seq(this.appProd(ctx), char(" "), this.atomProd(ctx))
        .map(([fn, , arg]) => ({ app: fn, arg })),
      this.atomProd(ctx),
    );
  }

  @rule
  protected atomProd(_ctx: unknown): Parser<unknown> {
    return pred((c) => c >= "a" && c <= "z", "<lower>").map((c) => ({
      var: c,
    }));
  }
}

/* ── Tests ──────────────────────────────────────────────────────────── */

Deno.test("Variant grammar — nested construction does not duplicate (#28)", async (t) => {
  const g = new VariantGrammar();

  await t.step("2 levels: F(G(x))", () => {
    assertEquals([...g.parse("F(G(x))")], [{ variant: "F" }]);
  });
  await t.step("3 levels: F(G(H(x)))", () => {
    assertEquals([...g.parse("F(G(H(x)))")], [{ variant: "F" }]);
  });
  await t.step("5 levels: A(B(C(D(E(x)))))", () => {
    assertEquals([...g.parse("A(B(C(D(E(x)))))")], [{ variant: "A" }]);
  });
  await t.step("nested multi-char: Empty(Empty(x))", () => {
    assertEquals([...g.parse("Empty(Empty(x))")], [{ variant: "Empty" }]);
  });
});

Deno.test("Variant grammar — basic parses are correct (#28)", async (t) => {
  const g = new VariantGrammar();

  await t.step("variable: x", () => {
    assertEquals([...g.parse("x")], [{ var: "x" }]);
  });
  await t.step("parenthesised: (x)", () => {
    assertEquals([...g.parse("(x)")], [{ var: "x" }]);
  });
  await t.step("variant with one arg: F(x)", () => {
    assertEquals([...g.parse("F(x)")], [{ variant: "F" }]);
  });
  await t.step("variant with multiple args: F(x,y)", () => {
    assertEquals([...g.parse("F(x,y)")], [{ variant: "F" }]);
  });
  await t.step("variant with whitespace: F( x , y )", () => {
    assertEquals([...g.parse("F( x , y )")], [{ variant: "F" }]);
  });
});

Deno.test("Variant grammar — base case resolved (#30)", async (t) => {
  const g = new VariantGrammar();

  // The base case (a `@rule` getter re-entered at the SAME position from two
  // call sites, e.g. `ws` before and after `(`) previously produced a
  // cosmetic duplicate (size 2). The v4.0.2 derivation-path dedup (issue #30)
  // collapses it: both results share a derivation path (the re-flow is within
  // one derivation) so the top-level forest keeps a single result. Genuine
  // ambiguity (distinct `AltExp` branches) is unaffected — see the ambiguity
  // tests in `parser-algebra.test.ts`.
  await t.step("single-level: E() → 1 result", () => {
    const result = g.parse("E()");
    assertEquals(result.size, 1);
    assertEquals([...result], [{ variant: "E" }]);
  });
  await t.step("multi-char: Empty() → 1 result", () => {
    const result = g.parse("Empty()");
    assertEquals(result.size, 1);
    assertEquals([...result], [{ variant: "Empty" }]);
  });
});

Deno.test("Left-recursion still works after fix (#28)", async (t) => {
  const g = new LeftRecGrammar();

  await t.step("single atom: x", () => {
    assertEquals([...g.parse("x")], [{ var: "x" }]);
  });
  await t.step("application: f x", () => {
    assertEquals([...g.parse("f x")], [{
      app: { var: "f" },
      arg: { var: "x" },
    }]);
  });
  await t.step("curried: f x y", () => {
    assertEquals([...g.parse("f x y")], [{
      app: { app: { var: "f" }, arg: { var: "x" } },
      arg: { var: "y" },
    }]);
  });
});
