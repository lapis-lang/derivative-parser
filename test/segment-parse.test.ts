/**
 * Tests — positional/compositional parsing primitives.
 *
 * Covers `Grammar.parseSegment`, `Grammar.parseSegmentFrom`, and the default
 * `Grammar.checkpointAt`. Verifies:
 *  - A segment parse equals the corresponding slice of a full parse.
 *  - Spans in semantic actions are reported in absolute coordinates (no
 *    caller offset compensation).
 *  - Recognition-only segment parsing is self-contained.
 *  - The default `checkpointAt` throws (grammars without inherited context).
 *  - An L-attributed grammar (STLC type checker) can build a checkpoint from
 *    a `TypeEnv` and parse a suffix under it.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { ArithVarEval, Env } from "../examples/arith-var.ts";
import { STLCTypeCheck, TVar, TypeEnv, typeEq } from "../examples/stlc.ts";
import type { Checkpoint } from "../src/index.ts";

/* ── parseSegment: S-attributed (pure arithmetic, no env dependency) ── */

Deno.test("parseSegment — pure arithmetic substring matches full parse", () => {
  const g = new ArithVarEval();
  const input = "1+2*3";
  // Full parse of the whole input.
  const [full] = [...g.parse(input)];
  assertEquals(full, 7);

  // Segment parse of the whole input via parseSegment.
  const [seg] = [...g.parseSegment(input, 0, g.expr(Env.empty()))];
  assertEquals(seg, 7);

  // Segment parse of a suffix "2*3" starting at offset 2.
  // The suffix is a valid `term`/`expr` on its own (no inherited context
  // needed for pure arithmetic), so parseSegment under expr(Env.empty())
  // yields the same value as parsing "2*3" directly.
  const [suffix] = [...g.parseSegment(input, 2, g.expr(Env.empty()))];
  const [direct] = [...g.parse("2*3")];
  assertEquals(suffix, direct);
  assertEquals(suffix, 6);
});

Deno.test("parseSegment — default endOffset is input.length", () => {
  const g = new ArithVarEval();
  const input = "42";
  const [seg] = [...g.parseSegment(input, 0, g.expr(Env.empty()))];
  assertEquals(seg, 42);
});

Deno.test("parseSegment — rejects out-of-range offsets", () => {
  const g = new ArithVarEval();
  const input = "1+2";
  assertThrows(
    () => g.parseSegment(input, -1, g.expr(Env.empty())),
    RangeError,
  );
  assertThrows(
    () => g.parseSegment(input, 0, g.expr(Env.empty()), input.length + 1),
    RangeError,
  );
  assertThrows(
    () => g.parseSegment(input, 3, g.expr(Env.empty()), 2),
    RangeError,
  );
});

Deno.test("parseSegment — empty segment yields empty forest", () => {
  const g = new ArithVarEval();
  const input = "1+2";
  // A zero-length segment: no tokens, expr can't match.
  const results = [...g.parseSegment(input, 1, g.expr(Env.empty()), 1)];
  assertEquals(results.length, 0);
});

/* ── parseSegment: spans are absolute ───────────────────────────────── */

Deno.test("parseSegment — spans are absolute (no offset compensation)", () => {
  // A grammar that captures the span of a parsed token. We reuse ArithVarEval
  // but need a span-observing parser; build one inline via .map on `digits`.
  // The `digits` lexeme's span should be absolute when parsed as a segment.
  const g = new ArithVarEval();
  const input = "xxx42yyy";
  // Parse "42" as a segment at offset 3..5; the captured span must be [3,5).
  let captured: { start: number; end: number } | null = null;
  const spanParser = g.expr(Env.empty()).map((v, span) => {
    captured = { start: span.start, end: span.end };
    return v;
  });
  const [v] = [...g.parseSegment(input, 3, spanParser, 5)];
  assertEquals(v, 42);
  assertEquals(captured, { start: 3, end: 5 });
});

/* ── parseSegment: recognition is self-contained ───────────────────── */

Deno.test("parseSegment — recognition is self-contained at any position", () => {
  // Recognition (is [k,n) a valid suffix?) is the strongest case for
  // composability: the derivative is fully self-contained. Verify a segment
  // parse recognises a valid suffix without needing the prefix.
  const g = new ArithVarEval();
  const input = "garbage1+2*3";
  // The suffix "1+2*3" at offset 7 is a valid expr; the prefix "garbage" is
  // irrelevant to recognising the suffix.
  const results = [...g.parseSegment(input, 7, g.expr(Env.empty()))];
  assertEquals(results, [7]);
});

/* ── checkpointAt: default throws ───────────────────────────────────── */

Deno.test("checkpointAt — default throws 'not supported'", () => {
  const g = new ArithVarEval();
  assertThrows(
    () => g.checkpointAt("1+2", 0),
    Error,
    "not supported",
  );
});

/* ── checkpointAt + parseSegmentFrom: L-attributed (STLC type checker) ─ */

/** A minimal STLC type-checker grammar that overrides `checkpointAt`. */
class STLCSegmentTypeCheck extends STLCTypeCheck {
  /**
   * The `TypeEnv` to bake into checkpoints. In a real grammar this would be
   * recovered by a lightweight recognition pass over the prefix `[0, offset)`;
   * here it is injected for testing so we can verify the L-attributed
   * checkpoint pattern (the start parser has the env baked in).
   */
  private _checkpointEnv: TypeEnv = TypeEnv.empty();

  /** Set the env used by subsequent `checkpointAt` calls. */
  withCheckpointEnv(env: TypeEnv): this {
    this._checkpointEnv = env;
    return this;
  }

  override checkpointAt(_input: string, offset: number): Checkpoint<unknown> {
    return {
      offset,
      start: this.exprProd(this._checkpointEnv),
      kind: "L",
    };
  }
}

Deno.test("parseSegmentFrom — L-attributed suffix under a TypeEnv checkpoint", () => {
  const g = new STLCSegmentTypeCheck();
  // Full input: `let x:Bool = true in x` — the body `x` has type Bool under
  // Γ = {x:Bool}. Split at the body: the suffix `x` at the boundary needs
  // Γ = {x:Bool} to type-check.
  const input = "let x:Bool = true in x";
  // The body `x` starts after "let x:Bool = true in " — find that offset.
  const bodyStart = input.lastIndexOf(" ") + 1; // offset of the final "x"
  const bodyEnv = TypeEnv.empty().extend("x", new TVar("Bool"));

  // Full parse: the whole expression has type Bool.
  const [full] = [...g.parse(input)];
  assert(typeEq(full as TVar, new TVar("Bool")));

  // Segment parse of the body `x` under the checkpoint's env.
  const checkpoint = g.withCheckpointEnv(bodyEnv).checkpointAt(
    input,
    bodyStart,
  );
  const [seg] = [...g.parseSegmentFrom(input, checkpoint)];
  assert(typeEq(seg as TVar, new TVar("Bool")));

  // Without the checkpoint env (empty TypeEnv), the body `x` is unbound.
  // `varRef`'s @requires fails gracefully (returns `undefined`), so the
  // segment parse produces `undefined` rather than `Bool` — proving the
  // checkpoint's context matters: the result differs from the bound case.
  const emptyCheckpoint = g.withCheckpointEnv(TypeEnv.empty())
    .checkpointAt(input, bodyStart);
  const unbound = [...g.parseSegmentFrom(input, emptyCheckpoint)];
  assertEquals(unbound.length, 1);
  assertEquals(unbound[0], undefined);
});

Deno.test("parseSegmentFrom — default endOffset is input.length", () => {
  const g = new STLCSegmentTypeCheck();
  g.withCheckpointEnv(TypeEnv.empty());
  const input = "true";
  const checkpoint = g.checkpointAt(input, 0);
  const [v] = [...g.parseSegmentFrom(input, checkpoint)];
  assert(typeEq(v as TVar, new TVar("Bool")));
});

/* ── Checkpoint kind tag ────────────────────────────────────────────── */

Deno.test("Checkpoint — carries an attribution kind tag", () => {
  const g = new STLCSegmentTypeCheck();
  g.withCheckpointEnv(TypeEnv.empty());
  const cp = g.checkpointAt("x", 0);
  assertEquals(cp.kind, "L");
  assertEquals(cp.offset, 0);
});
