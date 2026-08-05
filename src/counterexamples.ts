/**
 * Generative counterexample search — the dynamic layer of the metatheory
 * engine.
 *
 * Uses the grammar generator to synthesize well-formed terms, then checks
 * Progress and Preservation dynamically. This complements the static
 * analysis (`src/metatheory.ts`) and unification (`src/smt.ts`) layers: where they
 * reason about the rule *structure*, this layer tests the *behavior* on
 * concrete terms.
 *
 * - **Progress** (dynamic): for each generated term, check that it is
 *   either a value (normal form) or can take a step (evaluation produces a
 *   result without getting stuck).
 * - **Preservation** (dynamic): for each generated term that steps, check
 *   that the stepped result has the same type as the original (requires a
 *   type-checking grammar). For a one-pass evaluator, "stepping" is
 *   evaluation — so Preservation means the evaluated value's type is
 *   consistent with the type checker's result type for the source.
 *
 * @module
 */

import type { Grammar, GrammarShape } from "./Grammar.ts";
import { RNG, type GeneratorOptions } from "./generate.ts";

/* ======================================================================
 *  Types
 * ====================================================================== */

/** Options for {@link findCounterexamples}. */
export interface CounterexampleOptions {
  /** Generation options (depth, recursion, seed, …). See {@link GeneratorOptions}. */
  generator?: GeneratorOptions;
  /** Number of random terms to generate and check. Default: `100`. */
  numRuns?: number;
  /** Base RNG seed for reproducibility. Default: `0`. */
  seed?: number;
}

/** A counterexample found by the generative search. */
export interface Counterexample {
  /** Which property was violated: `"progress"` or `"preservation"`. */
  property: "progress" | "preservation";
  /** The source text of the counterexample term (unparsed). */
  source: string;
  /** Human-readable explanation of the violation. */
  explanation: string;
}

/** The result of a generative counterexample search. */
export interface CounterexampleResult {
  /** `true` if no counterexamples were found (the properties hold for all generated terms). */
  passed: boolean;
  /** The number of terms generated and checked. */
  runs: number;
  /** Counterexamples found (empty when `passed` is `true`). */
  counterexamples: Counterexample[];
}

/* ======================================================================
 *  Value-type inference
 * ====================================================================== */

/**
 * Infer the type of an evaluated value, for the Preservation check. For
 * STLC-style evaluators, values are closures (type `TFun`), booleans (type
 * `Bool`), and numbers (type `Int`). This is a heuristic — grammars with
 * different value spaces may need to override this logic.
 *
 * @returns A string representation of the value's type, or `undefined` if
 *   the value's type cannot be inferred.
 */
function inferValueType(value: unknown): string | undefined {
  if (typeof value === "boolean") return "Bool";
  if (typeof value === "number") return "Int";
  // Closures have a function type. We can't fully reconstruct the type
  // from the closure alone (we'd need the body's type), but we can identify
  // it as a function type.
  if (value !== null && typeof value === "object" &&
    "param" in value && "type" in value && "bodySpan" in value) {
    return "σ → τ";
  }
  return undefined;
}

/**
 * Check whether a value's inferred type is consistent with a type checker's
 * result type. For base types (`Bool`, `Int`), this is a direct string
 * match. For function types, any function type is consistent (the full
 * type comparison requires re-checking the body, which is beyond the
 * scope of the dynamic check).
 */
function typeConsistent(valueType: string, sourceType: string): boolean {
  if (valueType === sourceType) return true;
  // Both are function types — consistent (full comparison is the SMT
  // layer's job).
  if (valueType.includes("→") && sourceType.includes("→")) return true;
  if (valueType.includes("→") && sourceType.includes("→")) return true;
  // Fall back to arrow-variant check
  if (valueType.includes("→") || sourceType.includes("→")) {
    return valueType.includes("→") && sourceType.includes("→");
  }
  return false;
}

/* ======================================================================
 *  Counterexample search
 * ====================================================================== */

/**
 * Search for Progress and Preservation counterexamples by generating
 * well-formed terms and checking the properties dynamically.
 *
 * **Progress** (dynamic): for each generated term, check that it is either
 * a value (normal form) or can take a step (evaluation produces a result
 * without getting stuck). A term that is neither a value nor steppable is
 * a Progress violation.
 *
 * **Preservation** (dynamic): for each generated term that steps, check
 * that the stepped result has the same type as the original. This requires
 * a type-checking grammar to re-check the result type; when no type checker
 * is provided, the Preservation check is skipped.
 *
 * @param evalGrammar An evaluator grammar instance (e.g. `new STLCEval()`)
 *   used to step generated terms.
 * @param typeCheckGrammar An optional type-checker grammar instance (e.g.
 *   `new STLCTypeCheck()`) used to check the result type for Preservation.
 *   When omitted, only Progress is checked.
 * @param options Search options.
 * @returns The counterexample search result.
 */
export function findCounterexamples<S extends GrammarShape>(
  evalGrammar: Grammar<S>,
  typeCheckGrammar?: Grammar<S>,
  options: CounterexampleOptions = {},
): CounterexampleResult {
  const numRuns = options.numRuns ?? 100;
  const seed = options.seed ?? 0;
  const genOpts = options.generator ?? { maxDepth: 4, maxSteps: 1000 };
  const counterexamples: Counterexample[] = [];

  const rng = new RNG(seed);

  for (let run = 0; run < numRuns && counterexamples.length < 5; run++) {
    const runSeed = rng.next();
    let source: string;
    let value: unknown;
    try {
      const result = evalGrammar.generate({ ...genOpts, seed: runSeed });
      source = result.tokens.map((t) => t.sym).join("");
      value = result.value;
    } catch {
      // Generation may fail for some seeds (depth/recursion budget) — skip.
      continue;
    }

    // Progress check: re-parse the source with the evaluator and check it
    // produces a result. A stuck term would produce an empty parse forest
    // or throw.
    try {
      const results = [...evalGrammar.parse(source)];
      if (results.length === 0) {
        counterexamples.push({
          property: "progress",
          source,
          explanation:
            `generated term does not re-parse (stuck or ill-formed): "${source}"`,
        });
        continue;
      }
    } catch (e) {
      counterexamples.push({
        property: "progress",
        source,
        explanation:
          `generated term gets stuck on re-evaluation: ${(e as Error).message}`,
      });
      continue;
    }

    // Preservation check (optional): if a type checker is provided, verify
    // that the evaluated value's type is consistent with the type checker's
    // result type for the source. This is the dynamic Subject Reduction
    // check: if Γ ⊢ e : τ and e ⇓ v, then v has type τ.
    if (typeCheckGrammar) {
      try {
        const typeResults = [...typeCheckGrammar.parse(source)];
        if (typeResults.length === 0) {
          // The generated term is ill-typed — a generation issue, not a
          // Preservation violation. Skip.
          continue;
        }
        const sourceType = String(typeResults[0]);
        const valueType = inferValueType(value);
        if (valueType !== undefined && !typeConsistent(valueType, sourceType)) {
          counterexamples.push({
            property: "preservation",
            source,
            explanation:
              `type mismatch: source has type "${sourceType}" but evaluated value has type "${valueType}"`,
          });
        }
      } catch (e) {
        counterexamples.push({
          property: "preservation",
          source,
          explanation:
            `type check failed on generated term: ${(e as Error).message}`,
        });
      }
    }
  }

  return {
    passed: counterexamples.length === 0,
    runs: numRuns,
    counterexamples,
  };
}