/**
 * Regression test for issue #30: exponential duplicate parse results (2ⁿ)
 * persist after the v4.0.1 fix for multi-argument variant construction with
 * a `@rule` `ws` getter.
 *
 * The v4.0.1 fix (#28) eliminated duplicates from the *body's* `goDown`
 * re-entry, but the *`DelayedExp`'s own* `goDown` re-entry (the "base case")
 * still re-flowed an already-completed value when a `@rule` getter (e.g.
 * `ws`) was re-entered at the same position from multiple call sites. For
 * multi-argument variant construction via `sepBy`, this constant factor of 2
 * compounded across nesting levels → 2ⁿ duplicate (structurally-identical)
 * parse results.
 *
 * Fix (v4.0.2): thread a *derivation path* (the sequence of `AltExp` branch
 * choices from the root) through the engine. Values re-flowed within ONE
 * derivation share a path and are collapsed at the top; values from
 * genuinely different `AltExp` branches (real ambiguity) keep distinct
 * paths and are preserved. The `goDown` re-flow that powers left-recursion
 * growth is untouched — only the top-level forest dedups by derivation
 * path.
 *
 * This test mirrors the issue's `Pair(Z(), Pair(Z(), ...))` reproduction
 * (depths 1–6, was 2ⁿ) and guards that genuine ambiguity is still preserved.
 */

import { assertEquals } from "@std/assert";
import {
  chain,
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

/* ── Grammar mirroring the lapis-lang variant-construction structure ── */
//
//   start()     = exprProd(null)
//   exprProd(c) = atomProd(c)
//   atomProd(c) = "(" ws exprProd(c) ws ")"
//               | variantName ws "(" ws sepBy(atomProd(c), ws "," ws) ws ")"
//               | ident
//   ws          = wsChar ws | ε                (recursive @rule getter)
//
// The `ws` @rule getter is called at four call sites around the delimiters
// of the variant branch plus inside the `sepBy` separator. When the variant
// has zero arguments, `ws` is re-entered at the same position from multiple
// call sites — the base case that previously produced 2ⁿ duplicates.

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
      // Variant: Ident(args)  ← the trigger
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

/* ── Tests ──────────────────────────────────────────────────────────── */

Deno.test("Variant grammar — multi-arg construction no longer duplicates 2ⁿ (#30)", async (t) => {
  const g = new VariantGrammar();

  // The issue's reproduction: `Pair(Z(), Pair(Z(), ...))` at depth n
  // previously produced 2ⁿ structurally-identical results. Each level must
  // now yield exactly one result.
  for (let depth = 1; depth <= 6; depth++) {
    let input = "Z()";
    for (let i = 1; i < depth; i++) input = `Pair(Z(), ${input})`;
    await t.step(`depth ${depth}: ${input} → 1 result`, () => {
      const result = g.parse(input);
      assertEquals(result.size, 1, `depth ${depth} should yield 1 result`);
    });
  }
});

Deno.test("Variant grammar — base case yields a single result (#30)", async (t) => {
  const g = new VariantGrammar();

  // Zero-argument variants re-enter `ws` at the same position from multiple
  // call sites — the base case. Previously 2 results; now 1.
  await t.step("E() → 1 result", () => {
    assertEquals([...g.parse("E()")], [{ variant: "E" }]);
  });
  await t.step("Empty() → 1 result", () => {
    assertEquals([...g.parse("Empty()")], [{ variant: "Empty" }]);
  });
});

Deno.test("Variant grammar — nested single-arg construction still unique (#30)", async (t) => {
  const g = new VariantGrammar();

  // The #28 nested-construction fix must remain intact under the #30 change.
  await t.step("2 levels: F(G(x))", () => {
    assertEquals([...g.parse("F(G(x))")], [{ variant: "F" }]);
  });
  await t.step("3 levels: F(G(H(x)))", () => {
    assertEquals([...g.parse("F(G(H(x)))")], [{ variant: "F" }]);
  });
  await t.step("5 levels: A(B(C(D(E(x)))))", () => {
    assertEquals([...g.parse("A(B(C(D(E(x)))))")], [{ variant: "A" }]);
  });
});

Deno.test("Variant grammar — multi-arg variants with whitespace parse uniquely (#30)", async (t) => {
  const g = new VariantGrammar();

  await t.step("F(x)", () => {
    assertEquals([...g.parse("F(x)")], [{ variant: "F" }]);
  });
  await t.step("F(x,y)", () => {
    assertEquals([...g.parse("F(x,y)")], [{ variant: "F" }]);
  });
  await t.step("F( x , y )", () => {
    assertEquals([...g.parse("F( x , y )")], [{ variant: "F" }]);
  });
  await t.step("Pair(Z(), Pair(Z(), Z()))", () => {
    assertEquals([...g.parse("Pair(Z(), Pair(Z(), Z()))")], [{
      variant: "Pair",
    }]);
  });
});

/* ── Genuine ambiguity is preserved (regression guard for the fix) ──── */

Deno.test("Ambiguity is preserved — distinct AltExp branches yield distinct results (#30 guard)", () => {
  // `chain(or(a, a), b)` is genuinely ambiguous: two `AltExp` branches each
  // produce `["a", "b"]`. The derivation-path dedup must NOT collapse these
  // (they have distinct derivation paths), so the parse forest keeps both.
  // (This mirrors `parser-algebra.test.ts`'s ambiguity contract.)
  class ChainGrammar extends Grammar<{ r: [string, string] }> {
    override start(): Parser<[string, string]> {
      return chain(char("a").or(char("a")), () => char("b"));
    }
  }
  const g = new ChainGrammar();
  const results = [...g.parse("ab")];
  assertEquals(results.length, 2);
  assertEquals(results[0], ["a", "b"]);
  assertEquals(results[1], ["a", "b"]);
});
