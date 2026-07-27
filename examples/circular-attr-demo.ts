/**
 * Circular attribute flow demo — fixpoint composition.
 *
 * Demonstrates {@link Grammar.parseToFixpoint} on a small mutually-recursive
 * type inference problem. Two handlers `f` and `g` reference each other; their
 * types are computed by iterating to a fixpoint:
 *
 *   σ₀ = {f: ⊥, g: ⊥}            (placeholder)
 *   σ₁ = parse bodies under σ₀, join results
 *   …
 *   σₙ = σₙ₊₁                    (fixpoint)
 *
 * Run: deno run examples/circular-attr-demo.ts
 */

import { Grammar, parserOf } from "../src/index.ts";
import { EmptyExp } from "../src/zipper.ts";

/* ── A minimal type lattice ─────────────────────────────────────────── */

type Ty = { kind: "unknown" } | { kind: "base"; name: string } | {
  kind: "arrow";
  dom: Ty;
  cod: Ty;
};

const Unknown: Ty = { kind: "unknown" };
const tInt: Ty = { kind: "base", name: "Int" };

function joinTy(a: Ty, b: Ty): Ty {
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;
  if (tyEq(a, b)) return a;
  if (a.kind === "arrow" && b.kind === "arrow") {
    return {
      kind: "arrow",
      dom: joinTy(a.dom, b.dom),
      cod: joinTy(a.cod, b.cod),
    };
  }
  return { kind: "base", name: "Top" };
}

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

function showTy(t: Ty): string {
  if (t.kind === "unknown") return "?";
  if (t.kind === "base") return t.name;
  return `${showTy(t.dom)} → ${showTy(t.cod)}`;
}

/* ── σ = { handler → Ty } ───────────────────────────────────────────── */

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

function showSigma(s: Sigma): string {
  return `{${
    [...s.entries()].map(([k, v]) => `${k}: ${showTy(v)}`).join(", ")
  }}`;
}

/* ── Trivial grammar (fixpoint primitive is engine-generic) ─────────── */

class DemoGrammar extends Grammar {
  override start() {
    return parserOf<unknown>(new EmptyExp());
  }
}

/* ── The mutually-recursive scenario ────────────────────────────────── */
//
//   f = λx. g x    →  f's type is g's type (f applies g to its argument)
//   g = λy. y      →  g's type is Int → Int (identity on Int)
//
// Fixpoint:
//   σ₀ = {f: ?, g: ?}
//   iter 0: f's body under σ₀ → g is ?, so f: ? → ?; g's body → Int → Int
//           σ₁ = {f: ? → ?, g: Int → Int}
//   iter 1: f's body under σ₁ → g: Int → Int, so f: Int → Int; g unchanged
//           σ₂ = {f: Int → Int, g: Int → Int}
//   iter 2: σ₃ = σ₂ → fixpoint ✓

function main(): void {
  const g = new DemoGrammar();

  const parseBodies = (sigma: Sigma): Sigma[] => {
    const gType = sigma.get("g") ?? Unknown;
    const fType: Ty = gType.kind === "unknown"
      ? { kind: "arrow", dom: Unknown, cod: Unknown }
      : gType;
    const gBodyType: Ty = { kind: "arrow", dom: tInt, cod: tInt };
    return [new Map([["f", fType]]), new Map([["g", gBodyType]])];
  };

  const sigma0: Sigma = new Map([["f", Unknown], ["g", Unknown]]);
  console.log("Circular attribute flow — fixpoint composition (Approach D)");
  console.log("============================================================");
  console.log(`  f = λx. g x   (f's type = g's type)`);
  console.log(`  g = λy. y      (g's type = Int → Int)`);
  console.log();
  console.log(`  σ₀ = ${showSigma(sigma0)}`);

  const result = g.parseToFixpoint<Sigma>(
    sigma0,
    parseBodies,
    joinSigma,
    sigmaEq,
  );

  console.log(`  σ* = ${showSigma(result)}`);
  console.log();
  console.log(
    "  Fixpoint reached — both handlers typed without engine rework.",
  );
}

if (import.meta.main) main();
