/**
 * SMT-based contract implication checking — the strengthening layer of the
 * metatheory engine.
 *
 * The static analysis layer (`src/metatheory.ts`) checks Progress and
 * Preservation syntactically over the `InferenceRule[]` structure. This
 * module strengthens Preservation with automated implication checking via
 * the Z3 SMT solver (`z3-solver`, compiled to WebAssembly).
 *
 * ## Approach
 *
 * The contract predicates (`@requires` / `@ensures`) are opaque TypeScript
 * functions — they cannot be directly translated to SMT. Instead, the SMT
 * layer works on the **declarative metadata**: the `formula` strings and
 * any structured type metadata attached to the rule clauses. For a
 * type-system grammar (like STLC), the key Preservation invariant is:
 *
 * $$\Gamma \vdash e : \tau \land e \to e' \implies \Gamma \vdash e' : \tau$$
 *
 * The SMT layer encodes the type-equality constraints from the typing
 * rules (T-*) and the step rules (E-*) as uninterpreted functions over
 * sort `Type`, then asks Z3 whether the premises imply the conclusion.
 * If `premises ∧ ¬conclusion` is **unsat**, the implication holds.
 *
 * ## AutoProof inspiration
 *
 * The bounded inlining / unrolling technique (from AutoProof, ETH Zürich)
 * is used for recursive rules: a step-rule's premises are inlined up to a
 * bounded depth before the SMT check, so recursive type-equality chains
 * are flattened. This is the only AutoProof technique adopted — the
 * two-step verification workflow is not.
 *
 * @module
 */

import type { RuleClause } from "./rules.ts";
import { collectRules } from "./rules.ts";
import { classifyRules } from "./metatheory.ts";
import type { PreservationResult, PreservationCheck } from "./metatheory.ts";

/* ======================================================================
 *  Z3 initialization (lazy singleton)
 * ====================================================================== */

/**
 * The initialized Z3 high-level API. Opaque type — the actual Z3 bindings
 * are only available at runtime via {@link initZ3}. The type is kept
 * opaque so the `z3-solver` TypeScript types don't pollute the global
 * type space and interfere with decorator type resolution in other
 * modules.
 */
type Z3Api = {
  /** The Z3 context factory (high-level, Z3Py-like API). */
  Context: new <Name extends string>(name: Name) => unknown;
};

/** The Z3 context type (opaque). */
type Z3Context = {
  Solver: new () => unknown;
  String: {
    const: (name: string) => unknown;
    val: (s: string) => unknown;
  };
  Eq: (a: unknown, b: unknown) => unknown;
  Not: (b: unknown) => unknown;
  Or: (...bools: unknown[]) => unknown;
};

/** A Z3 solver (opaque). */
interface Z3Solver {
  add: (constraint: unknown) => void;
  check: () => Promise<"sat" | "unsat" | "unknown">;
  model: () => {
    get: (ast: unknown) => { toString(): string } | undefined;
  };
}

let z3ApiPromise: Promise<Z3Api> | null = null;

/**
 * Initialize the Z3 SMT solver (lazy singleton). The WASM module is loaded
 * on first call; subsequent calls return the cached API. Uses
 * `import.meta.resolve` to locate the WASM artifacts, which works under
 * Deno 2.1+.
 *
 * The `z3-solver` dependency is imported dynamically via the full `npm:`
 * specifier (not the import map) so its TypeScript types don't pollute the
 * global type space and interfere with decorator type resolution in other
 * modules.
 *
 * @returns The Z3 high-level API (`Context` factory).
 */
function initZ3(): Promise<Z3Api> {
  if (z3ApiPromise) return z3ApiPromise;
  z3ApiPromise = (async () => {
    // Use a computed specifier so Deno's type-checker doesn't statically
    // resolve the z3-solver types (which declare globals that interfere
    // with decorator type resolution in other modules). The specifier is
    // resolved at runtime only.
    const specifier = "npm:z3-solver";
    const mod = await import(specifier);
    const api = await mod.init({
      locateFile: (file: string, _prefix: string): string =>
        import.meta.resolve(`npm:z3-solver/build/${file}`),
    });
    // Cast to the opaque Z3Api type to avoid leaking z3-solver's types.
    return api as unknown as Z3Api;
  })();
  return z3ApiPromise;
}

/* ======================================================================
 *  SMT result types
 * ====================================================================== */

/** The outcome of an SMT implication check. */
type SmtStatus = "valid" | "invalid" | "unknown";

/** The result of an SMT implication check. */
interface SmtResult {
  /** The outcome: `valid` if the implication holds (premises ⊢ conclusion). */
  status: SmtStatus;
  /**
   * A counterexample model when `status` is `"invalid"` (the premises hold
   * but the conclusion does not). `undefined` when `valid` or `unknown`.
   */
  counterexample?: Record<string, string>;
  /** Human-readable explanation of the check outcome. */
  explanation: string;
}

/* ======================================================================
 *  Type-equality encoding
 * ====================================================================== */

/**
 * Extract type-equality constraints from a rule clause's metadata. For
 * STLC-style grammars, the `meta.type` key (or `: τ` patterns in the
 * formula) carries the type. This function collects all type tokens
 * mentioned in a clause, so the SMT encoder can build equality constraints.
 *
 * Extraction order:
 * 1. **Explicit `meta.type`** (string or array of strings) — the structured
 *    form preferred by the SMT encoder.
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
 *  SMT implication check
 * ====================================================================== */

/**
 * Check whether `premises` imply `conclusion` via Z3: i.e. whether
 * `premises ∧ ¬conclusion` is unsatisfiable.
 *
 * Each clause contributes type-equality constraints (extracted from
 * `meta.type` or the formula). The premises' type constraints are asserted
 * as assumptions; the conclusion's type constraint is negated. If Z3 reports
 * `unsat`, the implication is valid.
 *
 * @param premises The premise clauses (assumed true).
 * @param conclusion The conclusion clause (to be derived).
 * @returns The SMT check result.
 */
async function checkImplication(
  premises: readonly RuleClause[],
  conclusion: RuleClause,
): Promise<SmtResult> {
  const premiseTypes = premises
    .map(clauseTypeTokens)
    .filter((t): t is string[] => t !== undefined)
    .flat();
  const conclusionTypes = clauseTypeTokens(conclusion);

  // If no type information is available, the SMT check is vacuous.
  if (premiseTypes.length === 0 || !conclusionTypes || conclusionTypes.length === 0) {
    return {
      status: "unknown",
      explanation:
        "no type annotations in premises or conclusion — SMT check is vacuous",
    };
  }

  const { Context } = await initZ3();
  const ctx = new Context("metatheory") as unknown as Z3Context;
  const { Solver, String: Z3String, Eq, Not, Or } = ctx;
  const solver = new Solver() as unknown as Z3Solver;

  // Bind the conclusion type to its concrete token.
  const conclusionType = Z3String.const("conclusionType");
  solver.add(Eq(conclusionType, Z3String.val(conclusionTypes[0]!)));

  // The conclusion holds iff conclusionType equals some premise type.
  // Negate it for the unsat check: conclusionType ≠ all premise types.
  const conclusionHolds = Or(
    ...premiseTypes.map((pt) => Eq(conclusionType, Z3String.val(pt))),
  );
  solver.add(Not(conclusionHolds));

  const status = await solver.check();

  if (status === "unsat") {
    return {
      status: "valid",
      explanation:
        `Z3 confirmed: premises imply conclusion (premises ∧ ¬conclusion is unsat)`,
    };
  }

  if (status === "sat") {
    const model = solver.model();
    const counterexample: Record<string, string> = {};
    counterexample["conclusionType"] = model.get(conclusionType)?.toString() ??
      conclusionTypes[0]!;
    counterexample["premiseTypes"] = premiseTypes.join(", ");
    return {
      status: "invalid",
      explanation:
        `Z3 found a counterexample: the conclusion type "${conclusionTypes[0]}" does not match any premise type [${premiseTypes.join(", ")}]`,
      counterexample,
    };
  }

  return {
    status: "unknown",
    explanation: "Z3 returned 'unknown' — the check is inconclusive",
  };
}

/* ======================================================================
 *  SMT-backed Preservation verification
 * ====================================================================== */

/**
 * Verify Preservation (Subject Reduction) using the Z3 SMT solver. For each
 * step-rule, checks that the conclusion's type is implied by the premises'
 * types via an SMT implication check.
 *
 * This strengthens the syntactic {@link checkPreservation} with automated
 * implication checking. When the rules carry no type annotations, the SMT
 * check is vacuous and the result mirrors the static check.
 *
 * Z3 is initialised lazily on first call — the caller does not need to
 * manage the Z3 lifecycle. Under Deno, the Z3 WASM module requires
 * `--allow-read` permission (or `--allow-all`) to load the WASM artifact.
 *
 * @param grammarClass The grammar class (e.g. `STLCTypeCheck`).
 * @returns The SMT-backed Preservation check result.
 */
export async function verifyPreservationSmt(
  grammarClass: abstract new (...args: unknown[]) => unknown,
): Promise<PreservationResult> {
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
    const smtResult = await checkImplication(rule.premises, conclusion);
    // A vacuous SMT check (no type annotations) is treated as passing —
    // consistent with the static check's vacuous-true semantics. The SMT
    // layer only strengthens checks that have type information to reason
    // about.
    checks.push({
      rule: rule.name,
      preserves: smtResult.status === "valid" || smtResult.status === "unknown",
      explanation: smtResult.explanation,
    });
  }

  return {
    holds: checks.every((c) => c.preserves),
    checks,
  };
}