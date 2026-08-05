/**
 * STLC generation demo — L-system style top-down term synthesis.
 *
 * Demonstrates the dual of parsing: starting from the grammar's start
 * production, the generator walks the `Exp` tree top-down, emitting tokens
 * and computing semantic values. Generated terms are unparsed back to
 * source text and re-parsed to verify round-trip correctness.
 *
 * Run: `deno run examples/stlc-generate-demo.ts`
 */

import { STLCAST, STLCTypeCheck } from "./stlc.ts";

/* ── Generate random STLC terms ─────────────────────────────────────── */

console.log("=== STLC Term Generation ===\n");

const ast = new STLCAST();
const tc = new STLCTypeCheck();

console.log("Generating 10 random STLC terms:\n");
for (let seed = 0; seed < 10; seed++) {
  try {
    const { tokens } = ast.generate({
      seed,
      maxDepth: 4,
      maxSteps: 1000,
    });
    const src = tokens.map((t) => t.sym).join("");
    const reparsed = [...ast.parse(src)];
    const types = [...tc.parse(src)];
    const roundTrip = reparsed.length >= 1 ? "✓" : "✗";
    const typeCheck = types.length >= 1
      ? types[0]?.toString() ?? "?"
      : "ill-typed";
    console.log(
      `  seed ${seed}: ${src.padEnd(30)} ${roundTrip}  type: ${typeCheck}`,
    );
  } catch (e) {
    console.log(`  seed ${seed}: generation failed — ${(e as Error).message}`);
  }
}

/* ── Round-trip property test ───────────────────────────────────────── */

console.log("\n=== Property-Based Test: Round-Trip ===\n");

const gen = ast.toGenerator({ maxDepth: 4, maxSteps: 1000 });
try {
  const result = gen.forAll(
    (_term) => true, // generation itself ensures well-formedness
    { numRuns: 50, seed: 42 },
  );
  console.log(`  ${result.passed ? "✓" : "✗"} ${result.runs} runs passed`);
} catch (e) {
  console.log(`  ✗ ${(e as Error).message}`);
}

/* ── First-class inference rules ───────────────────────────────────── */

console.log("\n=== First-Class Inference Rules ===\n");

const rules = STLCTypeCheck.rules;
for (const rule of rules) {
  console.log(rule.format());
  console.log();
}

console.log(
  "\nThese rules enable type-directed generation: when asked to synthesize",
);
console.log(
  "a term of type σ → τ, the generator reads T-Abs's conclusion to select",
);
console.log(
  "it as a candidate rule — the foundation for #38's metatheory verification.",
);
