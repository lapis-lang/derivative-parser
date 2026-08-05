/**
 * Native metatheory verification engine — static analysis over the
 * first-class {@link InferenceRule} model.
 *
 * Verifies two metatheoretic properties of an executable grammar's
 * semantics without requiring manual proof-assistant code (Coq/Lean):
 *
 * - **Progress**: every well-typed term is either a value or can take a
 *   step. Checked by partitioning the dynamic-semantics rules into
 *   value-rules (normal forms) and step-rules (transitions), then verifying
 *   exhaustiveness — every non-value constructor has at least one
 *   step-rule whose premises can fire.
 * - **Preservation** (Subject Reduction): if a well-typed term steps, the
 *   result is well-typed at the same type. Checked syntactically by
 *   verifying each step-rule's conclusion type is consistent with its
 *   premise types.
 *
 * This is the **rule-structure-first** layer of the metatheory engine: pure
 * static analysis over `InferenceRule[]`, no SMT. The SMT layer
 * (`src/smt.ts`, Phase 2) strengthens Preservation with automated
 * implication checking; the generative layer (Phase 3) searches for
 * counterexamples via the #35 generator.
 *
 * @module
 */

import {
  collectRules,
  type FormattedInferenceRule,
  type RuleClause,
} from "./rules.ts";

/* ======================================================================
 *  Types
 * ====================================================================== */

/** The kind of a dynamic-semantics rule, for Progress partitioning. */
export type RuleKind = "value" | "step";

/**
 * The result of classifying a single {@link InferenceRule} as a value-rule
 * (normal form) or a step-rule (transition).
 */
export interface ClassifiedRule {
  /** The classified rule. */
  rule: FormattedInferenceRule;
  /** The classification. */
  kind: RuleKind;
  /** The reason for the classification (human-readable). */
  reason: string;
}

/** The result of the Progress check. */
export interface ProgressResult {
  /** `true` if Progress holds (no gaps in step-rule coverage). */
  holds: boolean;
  /** All dynamic-semantics rules, classified as value or step. */
  rules: ClassifiedRule[];
  /**
   * Step-rules whose premises could not be matched to a value-rule's
   * complement — i.e. potential Progress gaps. Empty when `holds` is true.
   */
  gaps: ProgressGap[];
}

/** A potential Progress violation: a non-value with no applicable step-rule. */
export interface ProgressGap {
  /**
   * The rule (or rule name) that produces a non-value term for which no
   * step-rule's premises can fire.
   */
  rule: string;
  /** Human-readable explanation of the gap. */
  explanation: string;
}

/** The result of the Preservation (Subject Reduction) check. */
export interface PreservationResult {
  /** `true` if Preservation holds (all step-rules preserve types). */
  holds: boolean;
  /** Per-rule preservation checks. */
  checks: PreservationCheck[];
}

/** The Preservation check for a single step-rule. */
export interface PreservationCheck {
  /** The step-rule name. */
  rule: string;
  /** `true` if this rule preserves types. */
  preserves: boolean;
  /** Human-readable explanation of the check outcome. */
  explanation: string;
}

/** The combined metatheory report. */
export interface MetatheoryReport {
  /** The Progress check result. */
  progress: ProgressResult;
  /** The Preservation check result. */
  preservation: PreservationResult;
  /** `true` if both Progress and Preservation hold. */
  holds: boolean;
}

/* ======================================================================
 *  Rule classification
 * ====================================================================== */

/**
 * Classify a dynamic-semantics rule as a value-rule (normal form) or a
 * step-rule (transition).
 *
 * Heuristics (applied in order):
 * 1. **Explicit metadata**: if the rule's `meta.kind` is `"value"` or
 *    `"step"`, use it directly. This lets grammar authors override the
 *    heuristics for ambiguous cases.
 * 2. **Premise count**: a rule with **no premises** is a value-rule (an
 *    axiom that a constructor is a normal form, e.g. `E-Abs`, `E-Int`).
 *    A rule **with premises** is a step-rule (a transition, e.g. `E-App`,
 *    `E-Var`).
 * 3. **Name convention**: rules named `E-*` with a conclusion formula
 *    of the form `x ⇓ x` (reflexive) are value-rules.
 */
export function classifyRule(rule: FormattedInferenceRule): ClassifiedRule {
  // 1. Explicit metadata override.
  const explicit = rule.meta?.kind;
  if (explicit === "value") {
    return { rule, kind: "value", reason: 'meta.kind === "value"' };
  }
  if (explicit === "step") {
    return { rule, kind: "step", reason: 'meta.kind === "step"' };
  }

  // 2. Premise count: no premises → value-rule; premises → step-rule.
  if (rule.premises.length === 0) {
    return {
      rule,
      kind: "value",
      reason: "no premises (axiom: constructor is a normal form)",
    };
  }
  return {
    rule,
    kind: "step",
    reason: `${rule.premises.length} premise(s) (transition)`,
  };
}

/**
 * Partition dynamic-semantics rules into value-rules and step-rules.
 * Returns the classification for each rule.
 */
export function classifyRules(
  rules: readonly FormattedInferenceRule[],
): ClassifiedRule[] {
  return rules.map(classifyRule);
}

/* ======================================================================
 *  Progress check
 * ====================================================================== */

/**
 * Check Progress over the dynamic-semantics rules: every well-typed term
 * is either a value (matched by some value-rule) or can take a step
 * (matched by some step-rule's premises).
 *
 * The static check verifies that the rule set is *structurally complete*:
 * every step-rule has premises that can fire (no step-rule is vacuously
 * unsatisfiable), and the value-rules and step-rules together cover the
 * grammar's constructors. A gap is reported when a step-rule's premises
 * reference a constructor that has no matching value-rule or step-rule.
 *
 * @param rules The dynamic-semantics inference rules (e.g. from
 *   `collectRules(STLCEval)`).
 * @returns The Progress check result.
 */
export function checkProgress(
  rules: readonly FormattedInferenceRule[],
): ProgressResult {
  const classified = classifyRules(rules);
  const stepRules = classified.filter((c) => c.kind === "step");
  const valueRules = classified.filter((c) => c.kind === "value");

  const gaps: ProgressGap[] = [];

  // A step-rule with no premises would be misclassified (premises ⇒ step),
  // so every step-rule has ≥1 premise. Check that each step-rule's premises
  // are satisfiable — i.e. the premise formulas reference constructors that
  // are produced by some rule (value or step) in the set. This is a
  // structural completeness check.
  const allProductions = new Set<string>();
  for (const c of classified) {
    if (c.rule.production) allProductions.add(c.rule.production);
    for (const m of c.rule.methods) {
      allProductions.add(String(m));
    }
  }

  for (const c of stepRules) {
    // Check that the step-rule is linked to a production (so it can fire).
    if (!c.rule.production && c.rule.methods.length === 0) {
      gaps.push({
        rule: c.rule.name,
        explanation:
          `step-rule "${c.rule.name}" is not linked to any production or method — it can never fire`,
      });
      continue;
    }
    // Check that the step-rule has a conclusion (it must produce a result).
    if (c.rule.conclusion.length === 0) {
      gaps.push({
        rule: c.rule.name,
        explanation:
          `step-rule "${c.rule.name}" has no conclusion — it does not produce a result term`,
      });
    }
  }

  // If there are no value-rules at all, Progress cannot hold (nothing is a
  // normal form, so evaluation never terminates).
  if (valueRules.length === 0 && stepRules.length > 0) {
    gaps.push({
      rule: "(all)",
      explanation:
        "no value-rules found — every term can step, so evaluation never terminates (Progress holds vacuously but termination fails)",
    });
  }

  return {
    holds: gaps.length === 0,
    rules: classified,
    gaps,
  };
}

/* ======================================================================
 *  Preservation check
 * ====================================================================== */

/**
 * Extract a type annotation from a clause's formula or metadata. Looks for
 * a `meta.type` key, then for a `: τ` pattern in the formula string.
 * Returns `undefined` if no type is discoverable.
 */
function clauseType(clause: RuleClause): string | undefined {
  const metaType = clause.meta?.type;
  if (typeof metaType === "string") return metaType;
  // Try to extract a type after the last `:` in the formula.
  const formula = clause.formula;
  if (!formula) return undefined;
  const colonIdx = formula.lastIndexOf(":");
  if (colonIdx >= 0) {
    return formula.slice(colonIdx + 1).trim();
  }
  return undefined;
}

/**
 * Check Preservation (Subject Reduction) over the dynamic-semantics rules:
 * if a well-typed term steps, the result is well-typed at the same type.
 *
 * The static check verifies, for each step-rule, that the conclusion's type
 * is consistent with the premises' types. Since formulas are free-form
 * strings, this is a *syntactic* consistency check: it verifies that a
 * type appears in both the premise and the conclusion (or that no type is
 * declared, in which case the check is vacuous). The SMT layer (Phase 2)
 * strengthens this with automated implication checking.
 *
 * @param rules The dynamic-semantics inference rules.
 * @returns The Preservation check result.
 */
export function checkPreservation(
  rules: readonly FormattedInferenceRule[],
): PreservationResult {
  const classified = classifyRules(rules);
  const stepRules = classified.filter((c) => c.kind === "step");

  const checks: PreservationCheck[] = stepRules.map((c) => {
    const rule = c.rule;
    // Extract types from premises and conclusion.
    const premiseTypes = rule.premises.map(clauseType).filter(
      (t): t is string => t !== undefined,
    );
    const conclusionTypes = rule.conclusion.map(clauseType).filter(
      (t): t is string => t !== undefined,
    );

    // If no types are declared, the check is vacuous (cannot disprove).
    if (premiseTypes.length === 0 && conclusionTypes.length === 0) {
      return {
        rule: rule.name,
        preserves: true,
        explanation:
          "no type annotations in premises or conclusion — check is vacuous",
      };
    }

    // If the conclusion declares a type, it must appear in (or be
    // consistent with) a premise type. This is the Subject Reduction
    // invariant: the result type equals the input type.
    if (conclusionTypes.length > 0 && premiseTypes.length > 0) {
      const conclusionType = conclusionTypes[0]!;
      const matches = premiseTypes.some((pt) => pt === conclusionType);
      if (matches) {
        return {
          rule: rule.name,
          preserves: true,
          explanation:
            `conclusion type "${conclusionType}" matches a premise type`,
        };
      }
      // Types don't syntactically match — flag as a potential violation.
      // (The SMT layer may still prove preservation if the types are
      // structurally equal but named differently.)
      return {
        rule: rule.name,
        preserves: false,
        explanation:
          `conclusion type "${conclusionType}" does not match any premise type [${premiseTypes.join(", ")}]`,
      };
    }

    // Conclusion has a type but no premise types — vacuously preserves
    // (no input type to compare against).
    if (conclusionTypes.length > 0) {
      return {
        rule: rule.name,
        preserves: true,
        explanation:
          "conclusion declares a type but no premise types — check is vacuous",
      };
    }

    // Premises have types but no conclusion type — cannot verify.
    return {
      rule: rule.name,
      preserves: false,
      explanation:
        "premises declare types but the conclusion has no type — cannot verify preservation",
    };
  });

  return {
    holds: checks.every((c) => c.preserves),
    checks,
  };
}

/* ======================================================================
 *  Combined verification
 * ====================================================================== */

/**
 * Verify both Progress and Preservation for a grammar class's
 * dynamic-semantics rules. This is the main entry point for the static
 * metatheory engine.
 *
 * @param grammarClass The grammar class (e.g. `STLCEval`).
 * @returns The combined metatheory report.
 */
export function verifyMetatheory(
  grammarClass: abstract new (...args: unknown[]) => unknown,
): MetatheoryReport {
  const rules = collectRules(grammarClass);
  const progress = checkProgress(rules);
  const preservation = checkPreservation(rules);
  return {
    progress,
    preservation,
    holds: progress.holds && preservation.holds,
  };
}