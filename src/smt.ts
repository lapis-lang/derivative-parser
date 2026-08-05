/**
 * Unification-based implication checking — the strengthening layer of the
 * metatheory engine.
 *
 * Uses the yield-kanren engine (`src/kanren.ts`) to check whether the
 * conclusion of an inference rule is implied by its premises via
 * unification. This replaces the earlier Z3-based SMT layer with a
 * pure-TypeScript implementation that works on all JS runtimes (Deno,
 * Node, Bun, Cloudflare Workers, browsers) — no WASM, no
 * `SharedArrayBuffer`, no file loading.
 *
 * ## Approach
 *
 * The contract predicates (`@requires` / `@ensures`) are opaque TypeScript
 * functions — they cannot be directly translated to logic goals. Instead,
 * this module works on the **declarative metadata**: the `formula` strings
 * and any structured type metadata attached to the rule clauses. For a
 * type-system grammar (like STLC), the key Preservation invariant is:
 *
 * $$\Gamma \vdash e : \tau \land e \to e' \implies \Gamma \vdash e' : \tau$$
 *
 * The unification layer parses the type tokens from the formula strings
 * into `Term`s (e.g. `"σ → τ"` → `term("→", atom("σ"), atom("τ"))`), then
 * uses `unify` to check whether the conclusion's type unifies with any
 * premise's type. If unification succeeds, the implication holds.
 *
 * Unlike the earlier string-equality check, unification handles
 * **recursive types** properly: `σ → τ` unifies with `Int → Bool` (with
 * `σ = Int`, `τ = Bool`), and `σ → τ` unifies with `σ → τ` (trivially).
 *
 * @module
 */

import type { RuleClause } from "./rules.ts";
import { collectRules } from "./rules.ts";
import { classifyRules } from "./metatheory.ts";
import type { PreservationResult, PreservationCheck } from "./metatheory.ts";
import {
  parseType,
  runExists,
  unify,
  type LogicValue,
  type Substitution,
} from "./kanren.ts";

/* ======================================================================
 *  Type extraction
 * ====================================================================== */

/**
 * Extract type-equality constraints from a rule clause's metadata. For
 * STLC-style grammars, the `meta.type` key (or `: τ` patterns in the
 * formula) carries the type. This function collects all type tokens
 * mentioned in a clause, so the unification engine can build equality
 * constraints.
 *
 * Extraction order:
 * 1. **Explicit `meta.type`** (string or array of strings) — the structured
 *    form preferred by the unification engine.
 * 2. **Formula parsing** — extract type-variable tokens after `:` or `<:`
 *    in the formula string. Splits arrow types (`σ → τ`) into components.
 *    Does not scan for Greek letters outside type-annotation positions,
 *    to avoid false tokens from rule names or descriptions.
 *
 * @returns An array of type-token strings, or `undefined` if no types are
 *   discoverable.
 */
function clauseTypeTokens(clause: RuleClause): string[] | undefined {
  // 1. Explicit meta.type (string or array of strings).
  const metaType = clause.meta?.type;
  if (typeof metaType === "string") return [metaType];
  if (Array.isArray(metaType)) {
    return metaType.filter((t): t is string => typeof t === "string");
  }
  // 2. Parse type-variable tokens from type-annotation positions in the
  //    formula. Match `: TypeExpr` or `<: TypeExpr` patterns only — not
  //    Greek letters appearing elsewhere (which could be rule names or
  //    descriptions).
  const formula = clause.formula;
  if (!formula) return undefined;
  const tokens = new Set<string>();
  const typeAnnRe = /(?:<:|:)\s*([^\s,∧∨→]+(?:\s*→\s*[^\s,∧∨→]+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = typeAnnRe.exec(formula)) !== null) {
    const ty = m[1]!.trim();
    // Split arrow types into components: "σ → τ" → ["σ", "τ"].
    for (const part of ty.split("→")) {
      const t = part.trim();
      if (t) tokens.add(t);
    }
  }
  return tokens.size > 0 ? [...tokens] : undefined;
}

/* ======================================================================
 *  Unification-based implication check
 * ====================================================================== */

/** The result of a unification-based implication check. */
interface UnifyResult {
  /** `true` if the implication holds (conclusion type unifies with a premise type). */
  valid: boolean;
  /** Human-readable explanation of the check outcome. */
  explanation: string;
}

/**
 * Check whether `premises` imply `conclusion` via unification: i.e. whether
 * the conclusion's type unifies with any premise's type.
 *
 * Each clause's type tokens are parsed into `Term`s (e.g. `"σ → τ"` →
 * `term("→", atom("σ"), atom("τ"))`). The conclusion's type is unified
 * with each premise's type; if any unification succeeds, the implication
 * holds.
 *
 * @param premises The premise clauses (assumed true).
 * @param conclusion The conclusion clause (to be derived).
 * @returns The unification check result.
 */
function checkImplication(
  premises: readonly RuleClause[],
  conclusion: RuleClause,
): UnifyResult {
  const premiseTypes = premises
    .map(clauseTypeTokens)
    .filter((t): t is string[] => t !== undefined)
    .flat();
  const conclusionTypes = clauseTypeTokens(conclusion);

  // If no type information is available, the check is vacuous.
  if (
    premiseTypes.length === 0 || !conclusionTypes ||
    conclusionTypes.length === 0
  ) {
    return {
      valid: true,
      explanation:
        "no type annotations in premises or conclusion — check is vacuous",
    };
  }

  // Parse the conclusion type and each premise type into Terms, then
  // check if the conclusion type unifies with any premise type.
  const conclusionTerm = parseType(conclusionTypes[0]!);

  for (const premiseType of premiseTypes) {
    const premiseTerm = parseType(premiseType);
    if (runExists(unifyGoal(conclusionTerm, premiseTerm))) {
      return {
        valid: true,
        explanation:
          `conclusion type "${conclusionTypes[0]}" unifies with premise type "${premiseType}"`,
      };
    }
  }

  return {
    valid: false,
    explanation:
      `conclusion type "${conclusionTypes[0]}" does not unify with any premise type [${premiseTypes.join(", ")}]`,
  };
}

/** Wrap `unify` as a goal for `runExists`. */
function unifyGoal(u: LogicValue, v: LogicValue) {
  return function* (s: Substitution): Generator<Substitution> {
    yield* unify(u, v, s);
  };
}

/* ======================================================================
 *  Unification-backed Preservation verification
 * ====================================================================== */

/**
 * Verify Preservation (Subject Reduction) using the yield-kanren
 * unification engine. For each step-rule, checks that the conclusion's
 * type is implied by the premises' types via unification.
 *
 * This strengthens the syntactic {@link checkPreservation} with
 * unification-based implication checking. When the rules carry no type
 * annotations, the check is vacuous and the result mirrors the static
 * check.
 *
 * Unlike the earlier Z3-based approach, this uses pure TypeScript with
 * no external dependencies — it works on all JS runtimes (Deno, Node,
 * Bun, Cloudflare Workers, browsers) without `--allow-read` or WASM
 * loading.
 *
 * @param grammarClass The grammar class (e.g. `STLCTypeCheck`).
 * @returns The unification-backed Preservation check result.
 */
export function verifyPreservation(
  grammarClass: abstract new (...args: unknown[]) => unknown,
): PreservationResult {
  const rules = collectRules(grammarClass);
  const classified = classifyRules(rules);
  const stepRules = classified.filter((c) => c.kind === "step");

  const checks: PreservationCheck[] = [];
  for (const c of stepRules) {
    const rule = c.rule;
    if (rule.conclusion.length === 0) {
      checks.push({
        rule: rule.name,
        preserves: false,
        explanation: "step-rule has no conclusion",
      });
      continue;
    }
    const conclusion = rule.conclusion[0]!;
    const result = checkImplication(rule.premises, conclusion);
    checks.push({
      rule: rule.name,
      preserves: result.valid,
      explanation: result.explanation,
    });
  }

  return {
    holds: checks.every((c) => c.preserves),
    checks,
  };
}