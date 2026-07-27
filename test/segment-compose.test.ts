/**
 * Tests — segment composition.
 *
 * Covers `Grammar.composeSegmentsS` (S-attributed, independent) and
 * `Grammar.composeSegmentsL` (L-attributed, context-threaded). Verifies that
 * composed-segment parses equal the one-shot parse for both attribution kinds.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { ArithVarEval, Env } from "../examples/arith-var.ts";
import { STLCTypeCheck, TVar, TypeEnv, typeEq } from "../examples/stlc.ts";
import type { Checkpoint } from "../src/index.ts";

/* ── composeSegmentsS: S-attributed (independent) ────────────────────── */

Deno.test("composeSegmentsS — union of independent segment forests", () => {
  const g = new ArithVarEval();
  // Two independent pure-arithmetic inputs — no inherited context needed.
  const f0 = g.parseSegment("1+2", 0, g.expr(Env.empty()));
  const f1 = g.parseSegment("3*4", 0, g.expr(Env.empty()));
  const composed = g.composeSegmentsS<number>([f0, f1]);
  // Union of {3} and {12} — order is unspecified, so compare as sets.
  assertEquals(new Set(composed), new Set([3, 12]));
});

Deno.test("composeSegmentsS — single segment is identity", () => {
  const g = new ArithVarEval();
  const f0 = g.parseSegment("42", 0, g.expr(Env.empty()));
  const composed = g.composeSegmentsS<number>([f0]);
  assertEquals([...composed], [42]);
});

Deno.test("composeSegmentsS — empty segments yield empty forest", () => {
  const g = new ArithVarEval();
  const composed = g.composeSegmentsS<number>([]);
  assertEquals([...composed], []);
});

Deno.test("composeSegmentsS — overlapping values deduplicated", () => {
  const g = new ArithVarEval();
  // Both segments parse to 42 — union deduplicates.
  const f0 = g.parseSegment("42", 0, g.expr(Env.empty()));
  const f1 = g.parseSegment("42", 0, g.expr(Env.empty()));
  const composed = g.composeSegmentsS<number>([f0, f1]);
  assertEquals([...composed], [42]);
});

/* ── composeSegmentsL: L-attributed (context-threaded) ───────────────── */

/**
 * A minimal STLC type-checker grammar that overrides `checkpointAt` and
 * exposes a `checkpointAtEnv` for building checkpoints from an explicit env
 * (the L-attributed composition callback uses it to thread the prefix's
 * synthesized context).
 */
class STLCSegmentTypeCheck extends STLCTypeCheck {
  /**
   * Build a checkpoint at `offset` with `env` baked into the start parser.
   * In a real grammar the env would be recovered from the prefix; here it is
   * supplied explicitly so tests can verify the L-attributed threading.
   */
  checkpointAtEnv(offset: number, env: TypeEnv): Checkpoint<unknown> {
    return {
      offset,
      start: this.exprProd(env),
      kind: "L",
    };
  }
}

Deno.test("composeSegmentsL — single segment equals one-shot parse", () => {
  const g = new STLCSegmentTypeCheck();
  const input = "true";
  const cp = g.checkpointAtEnv(0, TypeEnv.empty());
  const composed = g.composeSegmentsL<unknown>(input, cp, [], () => {
    throw new Error("nextCheckpoint should not be called for 1 segment");
  });
  const [v] = [...composed];
  assert(typeEq(v as TVar, new TVar("Bool")));
});

Deno.test("composeSegmentsL — let boundary threads TypeEnv to body", () => {
  const g = new STLCSegmentTypeCheck();
  // `let x:Bool = true in x` — split at the body `x`.
  // Segment 0: `let x:Bool = true in ` — parses the let-binding; the body
  //   needs Γ = {x:Bool}.
  // Segment 1: `x` — type-checks under Γ = {x:Bool}, yielding Bool.
  const input = "let x:Bool = true in x";
  const bodyStart = input.lastIndexOf(" ") + 1; // offset of final "x"
  const bodyEnv = TypeEnv.empty().extend("x", new TVar("Bool"));

  // One-shot parse: the whole expression has type Bool.
  const [full] = [...g.parse(input)];
  assert(typeEq(full as TVar, new TVar("Bool")));

  // Composed parse: segment 0 under empty env, segment 1 under bodyEnv.
  const initial = g.checkpointAtEnv(0, TypeEnv.empty());
  const composed = g.composeSegmentsL<unknown>(
    input,
    initial,
    [bodyStart], // segment 0 ends at bodyStart; segment 1 runs to end
    (_prevResults, prevEnd, _i) => {
      // After segment 0, build the checkpoint for the body under bodyEnv.
      return g.checkpointAtEnv(prevEnd, bodyEnv);
    },
  );
  const [seg] = [...composed];
  assert(typeEq(seg as TVar, new TVar("Bool")));
});

/* ── Checkpoint.kind enforcement ─────────────────────────────────────── */

Deno.test("composeSegmentsL — rejects S-attributed initial checkpoint", () => {
  const g = new STLCSegmentTypeCheck();
  const input = "true";
  // An S-attributed checkpoint (kind: "S") passed to composeSegmentsL.
  const sCheckpoint: Checkpoint<unknown> = {
    offset: 0,
    start: g.exprProd(TypeEnv.empty()),
    kind: "S",
  };
  assertThrows(
    () =>
      g.composeSegmentsL<unknown>(input, sCheckpoint, [], () => {
        throw new Error("should not reach nextCheckpoint");
      }),
    TypeError,
    '"L"',
  );
});

Deno.test("composeSegmentsL — rejects S-attributed nextCheckpoint result", () => {
  const g = new STLCSegmentTypeCheck();
  const input = "true false";
  const mid = 5;
  const initial = g.checkpointAtEnv(0, TypeEnv.empty()); // kind: "L"
  assertThrows(
    () =>
      g.composeSegmentsL<unknown>(
        input,
        initial,
        [mid],
        (_r, prevEnd, _i) => ({
          offset: prevEnd,
          start: g.exprProd(TypeEnv.empty()),
          kind: "S", // wrong kind
        }),
      ),
    TypeError,
    '"L"',
  );
});

Deno.test("composeSegmentsL — rejects misaligned nextCheckpoint offset", () => {
  const g = new STLCSegmentTypeCheck();
  const input = "true false";
  const mid = 5; // boundary between "true" and " false"
  const initial = g.checkpointAtEnv(0, TypeEnv.empty());
  assertThrows(
    () =>
      g.composeSegmentsL<unknown>(
        input,
        initial,
        [mid],
        (_r, _prevEnd, _i) => g.checkpointAtEnv(0, TypeEnv.empty()), // wrong offset
      ),
    RangeError,
    "expected 5",
  );
});

Deno.test("composeSegmentsL — multi-boundary threads env through two segments", () => {
  const g = new STLCSegmentTypeCheck();
  // `let x:Bool = true in let y:Int = 0 in x`
  // Split at both `in` keywords: three segments.
  //   seg 0: `let x:Bool = true in `  → body needs Γ={x:Bool}
  //   seg 1: `let y:Int = 0 in `      → body needs Γ={x:Bool, y:Int}
  //   seg 2: `x`                       → type Bool under Γ={x:Bool, y:Int}
  const input = "let x:Bool = true in let y:Int = 0 in x";
  // Find the two `in` boundaries (the body starts after each `in `).
  const firstIn = input.indexOf(" in ") + 4; // offset of "let y:Int..."
  const secondIn = input.lastIndexOf(" in ") + 4; // offset of final "x"
  const env1 = TypeEnv.empty().extend("x", new TVar("Bool"));
  const env2 = env1.extend("y", new TVar("Int"));

  // One-shot parse: the whole expression has type Bool.
  const [full] = [...g.parse(input)];
  assert(typeEq(full as TVar, new TVar("Bool")));

  // Composed parse with two boundaries.
  const initial = g.checkpointAtEnv(0, TypeEnv.empty());
  const composed = g.composeSegmentsL<unknown>(
    input,
    initial,
    [firstIn, secondIn],
    (_prevResults, prevEnd, i) => {
      // After segment 0 → env1; after segment 1 → env2.
      const env = i === 0 ? env1 : env2;
      return g.checkpointAtEnv(prevEnd, env);
    },
  );
  const [seg] = [...composed];
  assert(typeEq(seg as TVar, new TVar("Bool")));
});
