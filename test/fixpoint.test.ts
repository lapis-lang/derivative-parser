/**
 * Tests — fixpoint composition for circular attribute flow.
 *
 * Covers `Grammar.parseToFixpoint`: iterative re-parsing of handler bodies
 * under a converging context σ, with a monotonicity check and optional
 * max-iterations safety net.
 *
 * The test scenario: two mutually recursive handlers `f` and `g` whose types
 * depend on each other. The fixpoint iteration starts from a placeholder σ₀
 * (both unknown), parses each body, joins the results, and repeats until the
 * type map stabilises.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  FixpointDivergenceError,
  Grammar,
  MonotonicityViolationError,
  parserOf,
} from "../src/index.ts";
import { EmptyExp } from "../src/zipper.ts";

/**
 * A trivial `Grammar` subclass for testing `parseToFixpoint` — the fixpoint
 * primitive is engine-generic, so `start()` is unused; it returns an empty
 * parser to satisfy the abstract method signature.
 */
class FixpointTestGrammar extends Grammar {
  override start() {
    return parserOf<unknown>(new EmptyExp());
  }
}

/* ── A minimal type lattice for the fixpoint test ───────────────────── */

/**
 * A simple type: either `Unknown` (bottom — the placeholder), `Base(name)`,
 * or `Arrow(dom, cod)`. Types form a lattice with `Unknown` as bottom and
 * `join` as least-upper-bound (here: `Unknown ⊑ everything`; two equal
 * types join to themselves; unequal non-bottom types join to `Top` which
 * we represent as `Base("Top")` for simplicity).
 */
type Ty = { kind: "unknown" } | { kind: "base"; name: string } | {
  kind: "arrow";
  dom: Ty;
  cod: Ty;
};

const Unknown: Ty = { kind: "unknown" };
const tInt: Ty = { kind: "base", name: "Int" };
const tTop: Ty = { kind: "base", name: "Top" };

/** Lattice join: least upper bound of two types. */
function joinTy(a: Ty, b: Ty): Ty {
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;
  if (tyEq(a, b)) return a;
  // Arrows join pointwise.
  if (a.kind === "arrow" && b.kind === "arrow") {
    return {
      kind: "arrow",
      dom: joinTy(a.dom, b.dom),
      cod: joinTy(a.cod, b.cod),
    };
  }
  // Unequal non-bottom, non-arrow-compatible types join to Top.
  return tTop;
}

/** Structural equality of types. */
function tyEq(a: Ty, b: Ty): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "unknown") return true;
  if (a.kind === "base") {
    return a.name === (b as { kind: "base"; name: string }).name;
  }
  if (a.kind === "arrow") {
    const bb = b as { kind: "arrow"; dom: Ty; cod: Ty };
    return tyEq(a.dom, bb.dom) && tyEq(a.cod, bb.cod);
  }
  return false;
}

/* ── A type map: σ = { handlerName → Ty } ───────────────────────────── */

type Sigma = ReadonlyMap<string, Ty>;

function joinSigma(a: Sigma, b: Sigma): Sigma {
  const out = new Map<string, Ty>(a);
  for (const [k, v] of b) {
    out.set(k, out.has(k) ? joinTy(out.get(k)!, v) : v);
  }
  return out;
}

function sigmaEq(a: Sigma, b: Sigma): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv === undefined || !tyEq(v, bv)) return false;
  }
  return true;
}

/* ── Test: fixpoint converges on mutually recursive handlers ────────── */

/**
 * Scenario: two handlers `f` and `g` where:
 *   f = λx. g x        — f's type is `α → β` where `g : α → β`
 *   g = λy. y          — g's type is `Int → Int` (body is just `y`, which
 *   has whatever type the caller supplies; for this simplified test we
 *   hardcode g's body type as `Int → Int`).
 *
 * The fixpoint:
 *   σ₀ = {f: Unknown, g: Unknown}
 *   iter 1: parse f's body under σ₀ → g is Unknown, so f : Unknown → Unknown
 *           parse g's body → g : Int → Int
 *           σ₁ = {f: Unknown → Unknown, g: Int → Int}
 *   iter 2: parse f's body under σ₁ → g : Int → Int, so f : Int → Int
 *           parse g's body → g : Int → Int (unchanged)
 *           σ₂ = {f: Int → Int, g: Int → Int}
 *   iter 3: σ₃ = σ₂ → fixpoint reached.
 */

Deno.test("parseToFixpoint — converges on mutually recursive handlers", () => {
  // A trivial grammar (unused for parsing — the test simulates body parsing
  // via callbacks, since the fixpoint primitive is engine-generic).
  const g = new FixpointTestGrammar();

  // The handler bodies, simulated: each returns a type given the current σ.
  // f = λx. g x  →  f's type is g's type (whatever g is in σ).
  // g = λy. y   →  g's type is Int → Int (constant).
  const parseBodies = (sigma: Sigma): Sigma[] => {
    const gType = sigma.get("g") ?? Unknown;
    const fType: Ty = gType.kind === "unknown"
      ? { kind: "arrow", dom: Unknown, cod: Unknown }
      : gType; // f has the same type as g
    const gBodyType: Ty = { kind: "arrow", dom: tInt, cod: tInt };
    return [
      new Map([["f", fType]]),
      new Map([["g", gBodyType]]),
    ];
  };

  const sigma0: Sigma = new Map([["f", Unknown], ["g", Unknown]]);
  const result = g.parseToFixpoint<Sigma>(
    sigma0,
    parseBodies,
    joinSigma,
    sigmaEq,
  );

  assertEquals(result.get("g"), { kind: "arrow", dom: tInt, cod: tInt });
  assertEquals(result.get("f"), { kind: "arrow", dom: tInt, cod: tInt });
});

Deno.test("parseToFixpoint — immediate fixpoint when bodies are stable", () => {
  const g = new FixpointTestGrammar();

  // Bodies that don't depend on σ — fixpoint reached in 1 iteration.
  const parseBodies = (_sigma: Sigma): Sigma[] => {
    return [new Map([["h", tInt]])];
  };
  const sigma0: Sigma = new Map([["h", Unknown]]);
  const result = g.parseToFixpoint<Sigma>(
    sigma0,
    parseBodies,
    joinSigma,
    sigmaEq,
  );
  assertEquals(result.get("h"), tInt);
});

Deno.test("parseToFixpoint — detects monotonicity violation", () => {
  const g = new FixpointTestGrammar();

  // A non-monotone, non-idempotent "join": join(a,b) = (a+b) % 3.
  // This violates the lattice axiom: join(σ, σ') ≠ σ' when (σ + σ') % 3 ≠ σ'.
  const nonMonotoneJoin = (a: number, b: number): number => (a + b) % 3;

  assertThrows(
    () =>
      g.parseToFixpoint<number>(
        0,
        () => [1],
        nonMonotoneJoin,
        (a, b) => a === b,
      ),
    MonotonicityViolationError,
    "monotonicity violated",
  );
});

Deno.test("parseToFixpoint — maxIterations safety net fires on divergence", () => {
  const g = new FixpointTestGrammar();

  // A monotone-but-never-converging chain: σ increments by 1 each iteration.
  // join(a, b) = max(a, b) — monotone, but the chain ascends forever.
  let n = 0;
  const parseBodies = (_sigma: number): number[] => [++n];
  const maxJoin = (a: number, b: number): number => Math.max(a, b);

  assertThrows(
    () =>
      g.parseToFixpoint<number>(
        0,
        parseBodies,
        maxJoin,
        (a, b) => a === b,
        5, // maxIterations
      ),
    FixpointDivergenceError,
    "exceeded maxIterations",
  );
});

Deno.test("parseToFixpoint — maxIterations off by default (no false positives)", () => {
  const g = new FixpointTestGrammar();

  // A chain that takes 3 iterations to converge — should succeed with no cap.
  let n = 0;
  const parseBodies = (sigma: number): number[] => {
    if (sigma < 3) return [++n];
    return [sigma]; // stable at 3
  };
  const result = g.parseToFixpoint<number>(
    0,
    parseBodies,
    Math.max,
    (a, b) => a === b,
  );
  assert(result >= 3);
});
