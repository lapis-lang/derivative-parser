/**
 * Runnable demo for Propositional Logic.
 *
 * Shows:
 *  • PropAST   — formula builder
 *  • PropTruth — truth-table evaluator under a variable assignment
 *  • PropProof — natural-deduction proof builder (proofs as parse trees)
 */

import {
  PropAST,
  PropTruth,
  PropProof,
  printFormula,
  printProof,
} from "./proplogic.ts";

/* ── AST ────────────────────────────────────────────────────────────── */

console.log("— PropAST (formula builder) —");
const g = new PropAST();
const cases = ["p → p", "p ∧ ¬p", "p ∨ q → r", "⊤ → ⊥"];
for (const src of cases) {
  const [f] = [...g.parse(src)];
  console.log(`  ${src.padEnd(15)} → ${printFormula(f)}`);
}

/* ── Truth evaluation ───────────────────────────────────────────────── */

console.log("\n— PropTruth (truth-table evaluator) —");
const t = new PropTruth();
const alpha = { p: true, q: false, r: true };
const truthCases = ["p → p", "p ∧ ¬p", "p ∨ q", "p → q", "⊤", "⊥"];
for (const src of truthCases) {
  const [v] = [...t.parseWith(src, alpha)];
  console.log(`  ${src.padEnd(15)} under {p:T, q:F, r:T} → ${v}`);
}

/* ── Proof building ─────────────────────────────────────────────────── */

console.log("\n— PropProof (natural-deduction proofs) —");
const pr = new PropProof();

// p → p: prove under empty Γ
// →Intro: assume p, prove p (by assumption), discharge p
const [proof1] = [...pr.parseWith("p → p", new Set())];
if (proof1) {
  console.log("  p → p:");
  console.log("    " + printProof(proof1, 1));
}

// p → (p ∧ p): assume p, prove p ∧ p (both by assumption)
const [proof2] = [...pr.parseWith("p → (p ∧ p)", new Set())];
if (proof2) {
  console.log("  p → (p ∧ p):");
  console.log("    " + printProof(proof2, 1));
}

// ⊤ is provable without assumptions
const [proof3] = [...pr.parseWith("⊤", new Set())];
if (proof3) {
  console.log("  ⊤:");
  console.log("    " + printProof(proof3, 1));
}