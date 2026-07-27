/**
 * Circular attribute flow demo — `let rec` type inference via fixpoint.
 *
 * Demonstrates `STLCRecTypeCheck.parseRec` on a mutually recursive `let rec`
 * binding. Two handlers `f` and `g` reference each other; their types are
 * computed by iterating to a fixpoint.
 *
 * Run: deno run examples/stlc-fixpoint-demo.ts
 */

import { STLCRecTypeCheck } from "./stlc-fixpoint.ts";
import { TypeEnv } from "./stlc.ts";

function main(): void {
  const g = new STLCRecTypeCheck();

  // `let rec f:Int -> Int = g and g:Int -> Int = \y:Int. y in g 7`
  //
  // f's body is `g` (references g, whose type isn't known yet).
  // g's body is `\y:Int. y` (identity on Int → Int → Int).
  //
  // Fixpoint:
  //   σ₀ = {f: ⊥, g: ⊥}
  //   iter 0: f's body `g` under σ₀ → g:⊥, so f:⊥; g's body `\y:Int. y` → Int→Int
  //           σ₁ = {f: ⊥, g: Int→Int}
  //   iter 1: f's body `g` under σ₁ → g:Int→Int, so f:Int→Int; g unchanged
  //           σ₂ = {f: Int→Int, g: Int→Int}
  //   iter 2: σ₃ = σ₂ → fixpoint ✓
  //
  // Then `g 7` type-checks under {f: Int→Int, g: Int→Int} → Int.
  const input = "let rec f:Int -> Int = g and g:Int -> Int = \\y:Int. y in g 7";

  console.log("Circular attribute flow — let rec type inference");
  console.log("===================================================");
  console.log(`  input: ${input}`);
  console.log();

  const results = g.parseWith(input, TypeEnv.empty());
  console.log(`  result type: ${[...results].map((t) => t.toString())}`);
  console.log();
  console.log("  Fixpoint reached — mutually recursive bindings typed.");
}

if (import.meta.main) main();
