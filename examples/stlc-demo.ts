/**
 * Runnable demo for Simply Typed Lambda Calculus.
 *
 * Shows all four interpretations of the same abstract grammar:
 *  • STLCAST       — syntax builder
 *  • STLCTypeCheck — one-pass type checker (judgment `Γ ⊢ e : τ`)
 *  • STLCEval      — one-pass evaluator (judgment `ρ ⊢ e ⇓ v`)
 *  • STLCTyped     — proof-bearing type checker (derivation trees)
 */

import {
  STLCAST,
  STLCTypeCheck,
  STLCEval,
  STLCTyped,
  TypeEnv,
  ValEnv,
  Closure,
  type Term,
} from "./stlc.ts";

/* ── AST ────────────────────────────────────────────────────────────── */

console.log("— STLCAST (syntax) —");
const g = new STLCAST();
const id = [...g.parse("\\x:Int. x")][0] as Term;
console.log(`  \\x:Int. x → ${id.print()}`);
const letId = [...g.parse("let f : Int -> Int = \\x:Int. x in f 7")][0] as Term;
console.log(`  let f = \\x:Int. x in f 7 → ${letId.print()}`);

/* ── Type checking ──────────────────────────────────────────────────── */

console.log("\n— STLCTypeCheck (typing judgment Γ ⊢ e : τ) —");
const tc = new STLCTypeCheck();
const tcCases: [string, TypeEnv][] = [
  ["\\x:Int. x", TypeEnv.empty()],
  ["\\x:Int. \\y:Bool. x", TypeEnv.empty()],
  ["(\\x:Int -> Int. x) (\\y:Int. y)", TypeEnv.empty()],
  ["let f : Int -> Int = \\x:Int. x in f 7", TypeEnv.empty()],
  ["\\x:Int. x x", TypeEnv.empty()],
];
for (const [src, env] of tcCases) {
  const results = [...tc.parseWith(src, env)];
  if (results.length === 0) {
    console.log(`  ${src.padEnd(45)} : REJECTED (ill-typed)`);
  } else {
    console.log(`  ${src.padEnd(45)} : ${results[0]}`);
  }
}

/* ── Evaluation ─────────────────────────────────────────────────────── */

console.log("\n— STLCEval (evaluation judgment ρ ⊢ e ⇓ v) —");
const ev = new STLCEval();
const evCases: [string, ValEnv][] = [
  ["let f : Int -> Int = \\x:Int. x in f 7", ValEnv.empty()],
  ["(\\x:Int -> Int. x) (\\y:Int. y)", ValEnv.empty()],
  ["(\\x:Int. x) 42", ValEnv.empty()],
];
for (const [src, env] of evCases) {
  const results = [...ev.parseWith(src, env)];
  if (results.length === 0) {
    console.log(`  ${src.padEnd(45)} : REJECTED`);
  } else {
    const v = results[0]!;
    const desc = v instanceof Closure ? `<closure ${v.param}>` : String(v);
    console.log(`  ${src.padEnd(45)} ⇓ ${desc}`);
  }
}

/* ── Proof-bearing type checking ────────────────────────────────────── */

console.log("\n— STLCTyped (proof-bearing: derivation tree) —");
const tt = new STLCTyped();
const idTT = [...tt.parseWith("\\x:Int. x", TypeEnv.empty())][0]!;
console.log(`  \\x:Int. x :`);
console.log(`    ${idTT.print()}`);

const appTT = [...tt.parseWith("(\\x:Int -> Int. x) (\\y:Int. y)", TypeEnv.empty())][0]!;
console.log(`  (\\x:Int -> Int. x) (\\y:Int. y) :`);
console.log(`    ${appTT.print()}`);