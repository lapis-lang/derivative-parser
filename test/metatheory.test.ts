/**
 * Tests for PBI #38 — Native Metatheory & Proof Verification Engine.
 *
 * Covers:
 * - Phase 0: Dynamic-semantics step-rule annotations on STLCEval.
 * - Phase 1: Static Progress/Preservation analysis (verifyMetatheory).
 * - Phase 2: Unification-based implication checking (verifyPreservation).
 * - Phase 3: Generative counterexample search (findCounterexamples).
 */

import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import {
  checkPreservation,
  checkProgress,
  classifyRules,
  collectRules,
  findCounterexamples,
  verifyMetatheory,
  verifyPreservation,
} from "../src/index.ts";
import { MathEval } from "../examples/arith.ts";
import {
  STLCTypeCheck,
  STLCEval,
  ValEnv,
  isValue,
} from "../examples/stlc.ts";

/* ── Phase 0: Dynamic-semantics step-rule annotations ──────────────── */

Deno.test("Phase 0 — STLCEval has E-* step-rule annotations", () => {
  const rules = collectRules(STLCEval);
  const names = rules.map((r) => r.name).sort();
  assertEquals(
    names,
    ["E-Abs", "E-App", "E-Bool", "E-Int", "E-Let", "E-Var"],
  );
});

Deno.test("Phase 0 — E-App has premise and conclusion", () => {
  const rules = collectRules(STLCEval);
  const eApp = rules.find((r) => r.name === "E-App");
  assertExists(eApp);
  assertEquals(eApp!.premises.length, 1);
  assertEquals(eApp!.premises[0]!.formula, "ρ ⊢ e₁ ⇓ ⟨x,τ,span,ρ'⟩");
  assertEquals(eApp!.conclusion.length, 1);
  assertEquals(eApp!.conclusion[0]!.formula, "ρ ⊢ e₁ e₂ ⇓ v");
});

Deno.test("Phase 0 — E-Abs is a value-rule (no premises)", () => {
  const rules = collectRules(STLCEval);
  const eAbs = rules.find((r) => r.name === "E-Abs");
  assertExists(eAbs);
  assertEquals(eAbs!.premises.length, 0);
  assertEquals(eAbs!.conclusion.length, 1);
  assertEquals(eAbs!.production, "lambdaProd");
});

Deno.test("Phase 0 — isValue classifies values correctly", () => {
  assert(isValue(42));
  assert(isValue(true));
  assert(isValue(false));
  assertFalse(isValue("hello" as unknown as never));
  assertFalse(isValue({} as unknown as never));
  assertFalse(isValue(undefined as unknown as never));
});

Deno.test("Phase 0 — STLCEval evaluation still works with contracts", () => {
  const ev = new STLCEval();
  const results = [...ev.parseWith("(\\x:Int. x) 42", ValEnv.empty())];
  assertEquals(results.length, 1);
  assertEquals(results[0], 42);
});

/* ── Phase 1: Static Progress/Preservation analysis ────────────────── */

Deno.test("Phase 1 — classifyRule partitions value vs step", () => {
  const rules = collectRules(STLCEval);
  const classified = classifyRules(rules);
  const valueRules = classified.filter((c) => c.kind === "value");
  const stepRules = classified.filter((c) => c.kind === "step");
  assertEquals(valueRules.map((c) => c.rule.name).sort(), ["E-Abs", "E-Bool", "E-Int", "E-Let"]);
  assertEquals(stepRules.map((c) => c.rule.name).sort(), ["E-App", "E-Var"]);
});

Deno.test("Phase 1 — checkProgress holds for STLCEval", () => {
  const rules = collectRules(STLCEval);
  const result = checkProgress(rules, STLCEval);
  assert(result.holds);
  assertEquals(result.gaps.length, 0);
});

Deno.test("Phase 1 — checkPreservation is vacuous for E-* rules", () => {
  const rules = collectRules(STLCEval);
  const result = checkPreservation(rules);
  // E-* rules have no type annotations (they use ⇓, not :), so the check
  // is vacuous (passes).
  assert(result.holds);
});

Deno.test("Phase 1 — verifyMetatheory with static+dynamic cross-check", () => {
  // Full cross-check: STLCEval (dynamic) + STLCTypeCheck (static).
  const report = verifyMetatheory(STLCEval, STLCTypeCheck);
  assert(report.holds);
  assert(report.progress.holds);
  assert(report.preservation.holds);
});

Deno.test("Phase 1 — verifyMetatheory on grammar without rules is vacuous", () => {
  const report = verifyMetatheory(MathEval);
  // MathEval has no inference-rule annotations.
  assert(report.progress.holds);
  assert(report.preservation.holds);
  assertEquals(report.progress.rules.length, 0);
});

Deno.test("Phase 1 — Progress gap detected for rule with no conclusion", () => {
  // STLCTypeCheck's T-Var has a premise but no @ensures conclusion.
  const rules = collectRules(STLCTypeCheck);
  const result = checkProgress(rules, STLCTypeCheck);
  // T-Var is classified as a step-rule (has premise) but has no conclusion.
  assertFalse(result.holds);
  assert(result.gaps.some((g) => g.rule === "T-Var"));
});

/* ── Phase 2: Unification-based implication checking ─────────────── */

Deno.test("Phase 2 — verifyPreservation on STLCEval (vacuous)", () => {
  const result = verifyPreservation(STLCEval);
  // E-* rules have no type annotations → vacuous → treated as passing.
  assert(result.holds);
});

Deno.test("Phase 2 — verifyPreservation on STLCTypeCheck", () => {
  const result = verifyPreservation(STLCTypeCheck);
  // T-App passes (τ unifies with σ or τ); T-Var has no conclusion → fails.
  const tAppCheck = result.checks.find((c) => c.rule === "T-App");
  assertExists(tAppCheck);
  assert(tAppCheck!.preserves);
});

/* ── Phase 3: Generative counterexample search ─────────────────────── */

Deno.test("Phase 3 — findCounterexamples passes for STLCEval", () => {
  const ev = new STLCEval();
  const result = findCounterexamples(ev, undefined, {
    numRuns: 30,
    seed: 42,
    generator: { maxDepth: 3, maxSteps: 500 },
  });
  assert(result.passed);
  assertEquals(result.counterexamples.length, 0);
});

Deno.test("Phase 3 — findCounterexamples with type checker", () => {
  const ev = new STLCEval();
  const tc = new STLCTypeCheck();
  const result = findCounterexamples(ev, tc, {
    numRuns: 30,
    seed: 42,
    generator: { maxDepth: 3, maxSteps: 500 },
  });
  assert(result.passed);
});

Deno.test("Phase 3 — findCounterexamples is reproducible", () => {
  const ev = new STLCEval();
  const r1 = findCounterexamples(ev, undefined, {
    numRuns: 20,
    seed: 99,
    generator: { maxDepth: 3, maxSteps: 500 },
  });
  const r2 = findCounterexamples(ev, undefined, {
    numRuns: 20,
    seed: 99,
    generator: { maxDepth: 3, maxSteps: 500 },
  });
  assertEquals(r1.passed, r2.passed);
  assertEquals(r1.counterexamples.length, r2.counterexamples.length);
});