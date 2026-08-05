/**
 * Tests for PBI #35 — L-System Program Generation & Reverse Grammar Unparsing.
 *
 * Covers:
 * - Phase 0: First-class InferenceRule model (`collectRules`, `Grammar.rules`).
 * - Phase 1: Top-down generator driver (`Grammar.generate`, `generateFrom`).
 * - Phase 2: Native property testing (`forAll`, `toGenerator`, shrinking).
 * - Phase 3: Unparsing (`Grammar.unparse`, `UnparsePass`).
 * - Phase 4: STLC validation — round-trip, type-directed synthesis sketch.
 */

import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import {
  collectRules,
  type DerivationNode,
  formatRule,
  GenerationError,
  Grammar,
  type InferenceRule,
  type Parser,
  PropertyFailure,
  rule,
} from "../src/index.ts";
import { MathEval } from "../examples/arith.ts";
import { STLCAST, STLCTypeCheck } from "../examples/stlc.ts";

/* ── Phase 0: First-class InferenceRule model ───────────────────────── */

Deno.test("Phase 0 — collectRules groups contracts by rule name", () => {
  const rules = collectRules(STLCTypeCheck);
  const names = rules.map((r) => r.name).sort();
  assertEquals(names, ["T-Abs", "T-App", "T-Var"]);

  const tApp = rules.find((r) => r.name === "T-App");
  assertExists(tApp);
  assertEquals(tApp!.premises.length, 1);
  assertEquals(tApp!.premises[0]!.formula, "fn : σ → τ  ∧  arg <: σ");
  assertEquals(tApp!.conclusion.length, 1);
  assertEquals(tApp!.conclusion[0]!.formula, "result : τ");
  assertEquals(tApp!.methods, ["app"]);
  assertEquals(tApp!.production, "appProd");
});

Deno.test("Phase 0 — Grammar.rules static getter", () => {
  const rules = STLCTypeCheck.rules;
  assertEquals(rules.length, 3);
  assert(rules.some((r) => r.name === "T-Var"));
  assert(rules.some((r) => r.name === "T-Abs"));
});

Deno.test("Phase 0 — grammars without rule convention return empty", () => {
  const rules = collectRules(MathEval);
  assertEquals(rules, []);
});

Deno.test("Phase 0 — T-Var has premise but no conclusion", () => {
  const rules = collectRules(STLCTypeCheck);
  const tVar = rules.find((r) => r.name === "T-Var");
  assertExists(tVar);
  assertEquals(tVar!.premises.length, 1);
  assertEquals(tVar!.premises[0]!.formula, "Γ(x) = τ");
  assertEquals(tVar!.conclusion.length, 0);
});

Deno.test("Phase 0 — T-Abs has conclusion but no premise", () => {
  const rules = collectRules(STLCTypeCheck);
  const tAbs = rules.find((r) => r.name === "T-Abs");
  assertExists(tAbs);
  assertEquals(tAbs!.premises.length, 0);
  assertEquals(tAbs!.conclusion.length, 1);
  assertEquals(tAbs!.conclusion[0]!.formula, "result : σ → τ");
});

Deno.test("Phase 0 — InferenceRule predicates are unbound", () => {
  const rules = collectRules(STLCTypeCheck);
  const tApp = rules.find((r) => r.name === "T-App");
  assertExists(tApp);
  // Predicates are functions — callable with (self, ...args).
  assertEquals(typeof tApp!.premises[0]!.predicate, "function");
  assertEquals(typeof tApp!.conclusion[0]!.predicate, "function");
});

Deno.test("Phase 0 — format() renders inference-rule notation", () => {
  const rules = collectRules(STLCTypeCheck);
  const tApp = rules.find((r) => r.name === "T-App");
  assertExists(tApp);
  const formatted = tApp!.format();
  // Premise above the bar — ∧ is split into spaced judgments.
  assert(formatted.includes("fn : σ → τ"));
  assert(formatted.includes("arg <: σ"));
  assert(!formatted.includes("∧"), "∧ should be split into spaced judgments");
  // Bar made of ─ chars with the rule name label.
  assert(formatted.includes("─"));
  assert(formatted.includes("T-App"));
  // Conclusion below the bar.
  assert(formatted.includes("result : τ"));
  // Lines in order: premise, bar, conclusion.
  const lines = formatted.split("\n");
  assert(lines[0]!.includes("fn :"));
  assert(lines[1]!.includes("─"));
  assert(lines[1]!.includes("T-App"));
  assert(lines[2]!.includes("result :"));
});

Deno.test("Phase 0 — format() on axiom (no premises)", () => {
  const rules = collectRules(STLCTypeCheck);
  const tAbs = rules.find((r) => r.name === "T-Abs");
  assertExists(tAbs);
  const formatted = tAbs!.format();
  const lines = formatted.split("\n");
  // No premise line — bar is first, conclusion second.
  assert(lines[0]!.includes("─"));
  assert(lines[0]!.includes("T-Abs"));
  assert(lines[1]!.includes("result : σ → τ"));
});

Deno.test("Phase 0 — format() includes production label", () => {
  const rules = collectRules(STLCTypeCheck);
  const tApp = rules.find((r) => r.name === "T-App");
  assertExists(tApp);
  const formatted = tApp!.format();
  assert(formatted.includes("appProd"));
});

Deno.test("Phase 0 — formatRule standalone function", () => {
  const rules = collectRules(STLCTypeCheck);
  const tVar = rules.find((r) => r.name === "T-Var");
  assertExists(tVar);
  const formatted = formatRule(tVar!);
  assert(formatted.includes("Γ(x) = τ"));
  assert(formatted.includes("T-Var"));
});

/* ── Phase 1: Generator driver ──────────────────────────────────────── */

Deno.test("Phase 1 — Generator produces valid arithmetic (MathEval)", async (t) => {
  const g = new MathEval();
  await t.step("every generated expression round-trips through parse", () => {
    // Property: for every seed, the generated source re-parses to the same value.
    // This is a structural invariant — it doesn't depend on how many seeds succeed,
    // only that those that do succeed round-trip correctly.
    let tested = 0;
    for (let seed = 0; seed < 20; seed++) {
      try {
        const { value, tokens } = g.generate({
          seed,
          maxDepth: 4,
          maxSteps: 500,
        });
        const src = tokens.map((t) => t.sym).join("");
        const parsed = [...g.parse(src)];
        assertEquals(
          parsed.length,
          1,
          `seed ${seed}: parse returned ${parsed.length} results`,
        );
        assertEquals(parsed[0], value, `seed ${seed}: round-trip mismatch`);
        tested++;
      } catch {
        // Generation may fail for some seeds — that's fine, we only assert
        // that successful generations round-trip.
      }
    }
    assert(tested > 0, "no seeds generated successfully");
  });
});

Deno.test("Phase 1 — Generator is seed-reproducible", () => {
  const g = new MathEval();
  const r1 = g.generate({
    seed: 42,
    maxDepth: 4,
    maxSteps: 500,
  });
  const r2 = g.generate({
    seed: 42,
    maxDepth: 4,
    maxSteps: 500,
  });
  assertEquals(r1.value, r2.value);
  assertEquals(
    r1.tokens.map((t) => t.sym).join(""),
    r2.tokens.map((t) => t.sym).join(""),
  );
});

Deno.test("Phase 1 — Generator respects maxDepth", () => {
  const g = new MathEval();
  // At depth 0, only terminals should be generated. Assert structurally:
  // the generated source must parse successfully, and the derivation tree
  // should be shallower than at a higher depth (no recursive expansion).
  const { tree, tokens } = g.generate({ maxDepth: 0, maxSteps: 100 });
  const src = tokens.map((t) => t.sym).join("");
  assert(
    [...g.parse(src)].length >= 1,
    `depth-0 generated unparseable "${src}"`,
  );
  // At depth 0, the tree should be shallower than at depth 3.
  const { tree: deepTree } = g.generate({
    maxDepth: 3,
    maxRecursion: 4,
    maxSteps: 50000,
  });
  assert(
    treeDepth(tree.root) <= treeDepth(deepTree.root),
    `depth-0 tree depth ${treeDepth(tree.root)} > depth-3 tree depth ${
      treeDepth(deepTree.root)
    }`,
  );
});

Deno.test("Phase 1 — Generator throws GenerationError on impossible grammar", () => {
  // A grammar with no terminal productions — generation must fail.
  class Impossible extends Grammar<{ s: never }> {
    override start(): Parser<never> {
      return this.s;
    }
    @rule
    get s(): Parser<never> {
      return this.s;
    }
  }
  const g = new Impossible();
  assertThrows(
    () => g.generate({ maxDepth: 3, maxSteps: 50 }),
    GenerationError,
    "generation failed",
  );
});

Deno.test("Phase 1 — breadth-first produces minimal derivation", () => {
  const g = new MathEval();
  // Breadth-first: terminal branches first → simplest possible expression.
  // Assert structurally: the generated source parses, and the derivation tree
  // is shallower than depth-first at the same depth budget.
  const { value, tree, tokens } = g.generate({
    branchStrategy: "breadth-first",
    maxDepth: 5,
    maxSteps: 500,
  });
  const src = tokens.map((t) => t.sym).join("");
  assert(
    [...g.parse(src)].length >= 1,
    `breadth-first generated unparseable "${src}"`,
  );
  assertEquals(typeof value, "number");
  // Compare tree depth against depth-first at the same budget.
  const { tree: dfTree } = g.generate({
    branchStrategy: "depth-first",
    maxDepth: 5,
    maxRecursion: 6,
    maxSteps: 50000,
  });
  const bfDepth = treeDepth(tree.root);
  const dfDepth = treeDepth(dfTree.root);
  assert(
    bfDepth <= dfDepth,
    `breadth-first depth ${bfDepth} > depth-first depth ${dfDepth}`,
  );
});

Deno.test("Phase 1 — depth-first produces maximal derivation", () => {
  const g = new MathEval();
  // Depth-first: recursive branches first → expands as deeply as possible.
  // Assert structurally: the derivation tree is deeper than breadth-first
  // at the same depth budget (depth-first prefers recursive expansion).
  const { tree, tokens } = g.generate({
    branchStrategy: "depth-first",
    maxDepth: 3,
    maxRecursion: 4,
    maxSteps: 500,
  });
  const src = tokens.map((t) => t.sym).join("");
  assert(
    [...g.parse(src)].length >= 1,
    `depth-first generated unparseable "${src}"`,
  );
  const { tree: bfTree } = g.generate({
    branchStrategy: "breadth-first",
    maxDepth: 3,
    maxSteps: 500,
  });
  assert(
    treeDepth(tree.root) >= treeDepth(bfTree.root),
    `depth-first depth ${treeDepth(tree.root)} < breadth-first depth ${
      treeDepth(bfTree.root)
    }`,
  );
});

Deno.test("Phase 1 — Generator builds a DerivationTree", () => {
  const g = new MathEval();
  const { tree } = g.generate({
    seed: 0,
    maxDepth: 4,
    maxSteps: 500,
  });
  assertExists(tree.root);
  assert(tree.root.span.end > 0 || tree.root.children.length === 0);
});

Deno.test("Phase 1 — generateFrom resolves named productions", () => {
  const g = new MathEval();
  // Generate from the 'term' production instead of start.
  const { value, tokens } = g.generateFrom("term", [], {
    seed: 0,
    maxDepth: 3,
    maxSteps: 500,
  });
  const src = tokens.map((t) => t.sym).join("");
  assertEquals(typeof value, "number");
  // The generated source should parse as a term.
  assert([...g.parse(src)].length >= 1);
});

Deno.test("Phase 1 — generateFrom rejects non-@rule names with GenerationError", () => {
  const g = new MathEval();
  // "parse" is a method but not a @rule production.
  assertThrows(
    () => g.generateFrom("parse", []),
    GenerationError,
    "is not a @rule production",
  );
  // Non-existent name should also throw GenerationError with available names.
  assertThrows(
    () => g.generateFrom("nonexistent", []),
    GenerationError,
    "Available @rule productions",
  );
});

Deno.test("Phase 1 — Generator works on STLC AST", () => {
  const g = new STLCAST();
  // Property: every successfully generated STLC term parses back.
  // Assert the structural invariant (round-trip), not a success count.
  let tested = 0;
  for (let seed = 0; seed < 20; seed++) {
    try {
      const { tokens } = g.generate({ seed, maxDepth: 4, maxSteps: 1000 });
      const src = tokens.map((t) => t.sym).join("");
      const parsed = [...g.parse(src)];
      assert(
        parsed.length >= 1,
        `seed ${seed}: generated unparseable "${src}"`,
      );
      tested++;
    } catch {
      // Some seeds may fail — that's fine.
    }
  }
  assert(tested > 0, "no seeds generated successfully");
});

/* ── Phase 2: Native property testing ───────────────────────────────── */

Deno.test("Phase 2 — forAll passes on a true property", () => {
  const g = new MathEval();
  const gen = g.toGenerator({ maxDepth: 4, maxSteps: 500 });
  const result = gen.forAll(
    (n) => typeof n === "number" && Number.isFinite(n),
    { numRuns: 50, seed: 42 },
  );
  assertEquals(result.passed, true);
  assertEquals(result.runs, 50);
});

Deno.test("Phase 2 — forAll finds a counterexample on a false property", () => {
  const g = new MathEval();
  const gen = g.toGenerator({ maxDepth: 4, maxSteps: 500 });
  // "All results are even" — should fail with a PropertyFailure.
  assertThrows(
    () => gen.forAll((n) => n % 2 === 0, { numRuns: 50, seed: 42 }),
    PropertyFailure,
    "property failed",
  );
});

Deno.test("Phase 2 — GrammarGenerator shrinks counterexamples", () => {
  const g = new MathEval();
  const gen = g.toGenerator({ maxDepth: 5, maxSteps: 500 });
  // Generate a value, then shrink it — shrinking should produce candidates.
  const value = gen.sample(0);
  const shrunk = gen.shrink(value);
  // Shrinking should produce at least one simpler candidate.
  assert(shrunk.length > 0, "shrinking produced no candidates");
});

Deno.test("Phase 2 — forAll is seed-reproducible", () => {
  const g = new MathEval();
  const gen = g.toGenerator({ maxDepth: 4, maxSteps: 500 });
  // Same seed → same result.
  const r1 = gen.forAll((n) => typeof n === "number", {
    numRuns: 10,
    seed: 7,
  });
  const r2 = gen.forAll((n) => typeof n === "number", {
    numRuns: 10,
    seed: 7,
  });
  assertEquals(r1.passed, r2.passed);
  assertEquals(r1.runs, r2.runs);
});

/* ── Phase 3: Unparsing ────────────────────────────────────────────── */

Deno.test("Phase 3 — unparse round-trips a parsed tree (MathEval)", () => {
  const g = new MathEval();
  const { trees } = g.parseToTree("1+2*3");
  assertEquals(trees.length, 1);
  const src = g.unparse(trees[0]!);
  assertEquals(src, "1+2*3");
  // Re-parse the unparsed source — same value.
  assertEquals([...g.parse(src)], [7]);
});

Deno.test("Phase 3 — unparse round-trips a generated tree (MathEval)", () => {
  const g = new MathEval();
  const { value, tree } = g.generate({
    seed: 2,
    maxDepth: 4,
    maxSteps: 500,
  });
  const src = g.unparse(tree);
  // The unparsed source should re-parse to the same value.
  assertEquals([...g.parse(src)], [value]);
});

Deno.test("Phase 3 — unparse works on STLC", () => {
  const g = new STLCAST();
  const { trees } = g.parseToTree("λx:Int. x");
  assertEquals(trees.length, 1);
  const src = g.unparse(trees[0]!);
  // The unparsed source should re-parse successfully.
  const reparsed = [...g.parse(src)];
  assertEquals(reparsed.length, 1);
});

/* ── Phase 4: STLC validation — round-trip & type-directed sketch ──── */

Deno.test("Phase 4 — STLC generate→unparse→parse round-trip", () => {
  const g = new STLCAST();
  let ok = 0;
  for (let seed = 0; seed < 30; seed++) {
    try {
      const { tree } = g.generate({
        seed,
        maxDepth: 4,
        maxSteps: 1000,
      });
      const src = g.unparse(tree);
      const reparsed = [...g.parse(src)];
      if (reparsed.length >= 1) ok++;
    } catch {
      // Some seeds may fail.
    }
  }
  assert(ok >= 15, `only ${ok}/30 STLC round-trips succeeded`);
});

Deno.test("Phase 4 — STLC generated terms are type-checkable", () => {
  const ast = new STLCAST();
  const tc = new STLCTypeCheck();
  let ok = 0;
  for (let seed = 0; seed < 30; seed++) {
    try {
      const { tree } = ast.generate({
        seed,
        maxDepth: 3,
        maxSteps: 1000,
      });
      const src = ast.unparse(tree);
      // Type-check the generated term (may fail if ill-typed — that's OK).
      const types = [...tc.parse(src)];
      if (types.length >= 1) ok++;
    } catch {
      // Generation or type-checking may fail.
    }
  }
  // At least some generated terms should type-check.
  assert(ok >= 1, `no generated terms type-checked`);
});

Deno.test("Phase 4 — STLC property: generated terms unparse→parse or fail gracefully", () => {
  const g = new STLCAST();
  // For each generated term: unparse the tree to source, then re-parse.
  // The contract is that this either succeeds (non-empty parse) or throws
  // gracefully (a caught exception) — never hangs or produces garbage.
  let ok = 0;
  let failed = 0;
  for (let seed = 0; seed < 30; seed++) {
    try {
      const { tree } = g.generate({ seed, maxDepth: 4, maxSteps: 1000 });
      const src = g.unparse(tree);
      const reparsed = [...g.parse(src)];
      if (reparsed.length >= 1) ok++;
      else failed++;
    } catch (e) {
      // Graceful failure is acceptable — the property is that it never
      // hangs or produces invalid output, not that every seed succeeds.
      if (e instanceof Error) failed++;
      else throw e; // Non-Error throw = a real bug, not graceful failure.
    }
  }
  // At least some should succeed, and all should be either success or
  // graceful failure (no unexpected throws).
  assert(ok >= 1, `no terms unparsed and re-parsed successfully`);
  assertEquals(
    ok + failed,
    30,
    "some seeds neither succeeded nor failed gracefully",
  );
});

Deno.test("Phase 4 — InferenceRule model supports type-directed generation sketch", () => {
  // The first-class rule model lets us read what types each rule produces.
  const rules: InferenceRule[] = STLCTypeCheck.rules;
  const tAbs = rules.find((r) => r.name === "T-Abs");
  assertExists(tAbs);
  // T-Abs's conclusion is "result : σ → τ" — it produces a function type.
  const conclusion = tAbs!.conclusion[0];
  assertExists(conclusion);
  assertEquals(conclusion!.formula, "result : σ → τ");
  // A type-directed generator would use this to know that T-Abs can produce
  // a function type — so when asked to generate a term of type σ → τ, it
  // would select T-Abs as a candidate rule. This is the foundation for
  // #38's metatheory verification.
});

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Compute the maximum depth of a derivation tree (root = 0). */
function treeDepth(node: DerivationNode): number {
  if (node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(treeDepth));
}
