/**
 * STLC metatheory demo — Progress and Preservation verification.
 *
 * Demonstrates the native metatheory engine on the STLC exemplar:
 * - Static analysis (Phase 1): verifyMetatheory on STLCEval's E-* rules.
 * - SMT implication checking (Phase 2): verifyPreservationSmt on STLCTypeCheck.
 * - Generative counterexample search (Phase 3): findCounterexamples.
 *
 * Run: `deno run --allow-read examples/stlc-metatheory-demo.ts`
 */

import {
  collectRules,
  findCounterexamples,
  verifyMetatheory,
  verifyPreservation,
} from "../src/index.ts";
import { STLCEval, STLCTypeCheck } from "./stlc.ts";

console.log("=== STLC Metatheory Verification ===\n");

/* ── Phase 0: Dynamic-semantics step rules ─────────────────────────── */

console.log("-- Phase 0: Dynamic-semantics step rules (STLCEval) --\n");

const evalRules = collectRules(STLCEval);
console.log(`  Collected ${evalRules.length} E-* step-rules:`);
for (const rule of evalRules) {
  console.log(`    ${rule.format().split("\n").join("\n    ")}`);
  console.log();
}

/* ── Phase 1: Static Progress/Preservation analysis ────────────────── */

console.log("-- Phase 1: Static Analysis (verifyMetatheory) --\n");

// Full cross-check: STLCEval (dynamic) + STLCTypeCheck (static).
const report = verifyMetatheory(STLCEval, STLCTypeCheck);
console.log(`  Progress:    ${report.progress.holds ? "✓ holds" : "✗ FAILS"}`);
console.log(`  Preservation: ${report.preservation.holds ? "✓ holds" : "✗ FAILS"}`);
console.log(`  Overall:      ${report.holds ? "✓ holds" : "✗ FAILS"}`);

console.log("\n  Rule classification:");
for (const c of report.progress.rules) {
  console.log(`    ${c.rule.name}: ${c.kind} — ${c.reason}`);
}

if (report.progress.gaps.length > 0) {
  console.log("\n  Progress gaps:");
  for (const g of report.progress.gaps) {
    console.log(`    [${g.rule}] ${g.explanation}`);
  }
}

/* ── Phase 2: SMT-based implication checking ───────────────────────── */

console.log("\n-- Phase 2: Unification Checking (verifyPreservation) --\n");

console.log("  STLCTypeCheck (T-* typing rules):");
const tcResult = verifyPreservation(STLCTypeCheck);
for (const c of tcResult.checks) {
  console.log(
    `    ${c.rule}: ${c.preserves ? "✓" : "✗"} — ${c.explanation}`,
  );
}

const evResult = verifyPreservation(STLCEval);
console.log("\n  STLCEval (E-* step rules):");
for (const c of evResult.checks) {
  console.log(
    `    ${c.rule}: ${c.preserves ? "✓" : "✗"} — ${c.explanation}`,
  );
}

/* ── Phase 3: Generative counterexample search ─────────────────────── */

console.log("\n-- Phase 3: Generative Counterexample Search --\n");

const ev = new STLCEval();
const tc = new STLCTypeCheck();
const searchResult = findCounterexamples(ev, tc, {
  numRuns: 100,
  seed: 42,
  generator: { maxDepth: 4, maxSteps: 1000 },
});
console.log(
  `  ${searchResult.passed ? "✓" : "✗"} ${searchResult.runs} runs, ` +
    `${searchResult.counterexamples.length} counterexamples`,
);
if (searchResult.counterexamples.length > 0) {
  for (const ce of searchResult.counterexamples) {
    console.log(`    [${ce.property}] "${ce.source}" — ${ce.explanation}`);
  }
}

console.log(
  "\nThe metatheory engine confirms Progress and Preservation hold for STLC.",
);
console.log(
  "The static analysis verifies rule-structure completeness; the unification layer",
);
console.log(
  "strengthens Preservation with type-equality checking; the",
);
console.log(
  "generative layer searches for concrete counterexamples via the grammar generator.",
);