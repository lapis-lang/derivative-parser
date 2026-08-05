/**
 * First-class inference-rule model — an opt-in interpretive layer over the
 * schema-less {@link ContractMeta} metadata.
 *
 * The library's contract metadata (`@requires` / `@ensures` / `@rule`) is
 * deliberately schema-less: `ContractMeta` is `Record<string, unknown>` and
 * the library imposes no structure on it. This keeps the contract system
 * generic and applicable to any domain.
 *
 * However, many grammars — especially programming-language grammars —
 * follow a convention where `@requires` / `@ensures` metadata carries
 * `rule`, `role`, `formula`, and `description` keys, encoding the inference
 * rules of a formal semantics (e.g. `T-Var`, `T-Abs`, `T-App`). This module
 * provides an **opt-in interpretive layer** that groups those contracts into
 * first-class {@link InferenceRule} objects, making the rule structure
 * queryable independently of the executable predicates.
 *
 * Grammars that don't follow the convention are unaffected —
 * {@link collectRules} returns an empty array for them. Grammars that do
 * unlock:
 *
 * - **Type-directed generation** (#35): read a rule's conclusion to know
 *   what type a production yields; read its premises to know what sub-terms
 *   to generate and at which types — *before* synthesizing any sub-values.
 * - **Static metatheory analysis** (#38): enumerate rules, partition into
 *   value-rules and step-rules, check exhaustiveness (Progress) and type
 *   preservation (Preservation) over the rule set.
 * - **Proof export** (#38): emit `Inductive HasType` / `Inductive Step`
 *   directly from the {@link InferenceRule[]} without re-parsing string
 *   formulas.
 *
 * @module
 */

import {
  collectMetadata,
  type ContractMeta,
  type ContractMetadataReport,
  type EnsuresContract,
  type RequiresContract,
} from "./contracts.ts";

/* ======================================================================
 *  Types
 * ====================================================================== */

/** The role a contract plays within an inference rule. */
export type RuleRole = "premise" | "conclusion" | "frame" | "side";

/**
 * A single premise or conclusion of an inference rule, derived from a
 * `@requires` (premise) or `@ensures` (conclusion) contract whose metadata
 * follows the `rule`/`role`/`formula` convention.
 */
export interface RuleClause {
  /** The inference-rule name, e.g. `"T-App"` (from `meta.rule`). */
  rule: string;
  /** The clause's role within the rule (from `meta.role`). */
  role: RuleRole;
  /** The declarative formula (from `meta.formula`), if present. */
  formula?: string;
  /** A human-readable description (from `meta.description`), if present. */
  description?: string;
  /** The full declarative metadata object, for any extra keys the author set. */
  meta: ContractMeta;
  /**
   * The executable predicate (unbound — pass `self` as the first argument
   * when invoking). For a premise this is the `@requires` predicate; for a
   * conclusion this is the `@ensures` predicate.
   */
  predicate: (...args: unknown[]) => boolean;
  /**
   * The name of the semantic-action method that carries this contract
   * (e.g. `"app"`, `"varRef"`), so the rule can be linked back to the
   * grammar method that implements it.
   */
  method: PropertyKey;
  /** `true` if this clause came from a `@requires` (premise) contract. */
  readonly isPremise: boolean;
  /** `true` if this clause came from an `@ensures` (conclusion) contract. */
  readonly isConclusion: boolean;
}

/**
 * A first-class inference rule — a named, declarative grouping of premises
 * and a conclusion, built from `@requires`/`@ensures` contracts that share
 * the same `meta.rule` name.
 *
 * The rule is linked to the grammar production that implements it via
 * {@link production} (the `@rule` method name, when discoverable) and to the
 * semantic-action method(s) via {@link methods}.
 */
export interface InferenceRule {
  /** The rule name, e.g. `"T-App"` (from `meta.rule`). */
  name: string;
  /** The premises (`@requires` contracts with `role: "premise"`). */
  premises: RuleClause[];
  /** The conclusion (`@ensures` contracts with `role: "conclusion"`). */
  conclusion: RuleClause[];
  /** Side conditions (`@requires` contracts with `role: "side"`). */
  sideConditions: RuleClause[];
  /** Frame conditions (`@ensures` contracts with `role: "frame"`). */
  frameConditions: RuleClause[];
  /**
   * The semantic-action method name(s) that carry this rule's contracts.
   * A rule may span multiple methods (e.g. `T-App` may have its premise on
   * `app` and its conclusion on `app`).
   */
  methods: PropertyKey[];
  /**
   * The `@rule` production name that implements this rule, when
   * discoverable from the contract metadata's `production` key. `undefined`
   * when the rule is not linked to a specific production.
   */
  production?: string;
  /** The full declarative metadata of the first clause, for extra keys. */
  meta?: ContractMeta;
}

/**
 * An {@link InferenceRule} with the `format()` method attached.
 * {@link collectRules} returns this type — the `format()` method is always
 * present on rules returned by `collectRules` / `Grammar.rules`, so callers
 * can use `rule.format()` without a null-check.
 */
export type FormattedInferenceRule = InferenceRule & {
  /**
   * Format this rule as standard inference-rule notation (proof tree).
   *
   * ```text
   * premise₁   premise₂   …   side-condition
   * ─────────────────────────  ruleName
   * conclusion
   * ```
   */
  format: () => string;
};

/* ======================================================================
 *  Helpers
 * ====================================================================== */

/**
 * Does a `ContractMeta` object follow the inference-rule convention — i.e.
 * does it carry a `rule` key (a non-empty string)?
 */
function hasRuleName(meta: ContractMeta | undefined): meta is ContractMeta {
  return (
    meta !== undefined &&
    meta !== null &&
    typeof meta === "object" &&
    typeof (meta as { rule?: unknown }).rule === "string" &&
    (meta as { rule: string }).rule.length > 0
  );
}

/**
 * Normalise a `meta.role` value to a {@link RuleRole}. When `role` is
 * missing or unrecognised, fall back to `defaultRole` — `"premise"` for
 * `@requires` clauses, `"conclusion"` for `@ensures` clauses.
 */
function normaliseRole(role: unknown, defaultRole: RuleRole): RuleRole {
  if (
    role === "premise" || role === "conclusion" || role === "frame" ||
    role === "side"
  ) {
    return role;
  }
  return defaultRole;
}

/** Build a {@link RuleClause} from a `@requires` contract. */
function clauseFromRequires(
  contract: RequiresContract,
  method: PropertyKey,
): RuleClause {
  const meta = contract.meta ?? {};
  return {
    rule: (meta.rule as string) ?? "",
    role: normaliseRole(meta.role, "premise"),
    formula: typeof meta.formula === "string" ? meta.formula : undefined,
    description: typeof meta.description === "string"
      ? meta.description
      : undefined,
    meta,
    predicate: contract.predicate as (...args: unknown[]) => boolean,
    method,
    isPremise: true,
    isConclusion: false,
  };
}

/** Build a {@link RuleClause} from an `@ensures` contract. */
function clauseFromEnsures(
  contract: EnsuresContract,
  method: PropertyKey,
): RuleClause {
  const meta = contract.meta ?? {};
  return {
    rule: (meta.rule as string) ?? "",
    role: normaliseRole(meta.role, "conclusion"),
    formula: typeof meta.formula === "string" ? meta.formula : undefined,
    description: typeof meta.description === "string"
      ? meta.description
      : undefined,
    meta,
    predicate: contract.predicate as (...args: unknown[]) => boolean,
    method,
    isPremise: false,
    isConclusion: true,
  };
}

/* ======================================================================
 *  Collection
 * ====================================================================== */

/**
 * Collect first-class {@link InferenceRule}s from a grammar's contract
 * metadata. Walks the inheritance chain via {@link collectMetadata} and
 * groups every `@requires`/`@ensures` contract whose metadata carries a
 * `rule` key (the inference-rule convention) by that rule name.
 *
 * Contracts without a `rule` key in their metadata are ignored — they are
 * ordinary contracts, not inference-rule clauses. This makes the
 * inference-rule model fully opt-in: grammars that don't follow the
 * convention get an empty array and are completely unaffected.
 *
 * Accepts either a `Grammar` **instance** or a `Grammar` **subclass**
 * (same inputs as {@link collectMetadata}).
 *
 * @example
 * ```ts
 * const rules = collectRules(STLCTypeCheck);
 * const tApp = rules.find(r => r.name === "T-App");
 * // tApp.premises   — the @requires clauses (domain match)
 * // tApp.conclusion — the @ensures clauses (result : τ)
 * ```
 */
export function collectRules(
  instanceOrClass: object | (abstract new (...args: unknown[]) => unknown),
): FormattedInferenceRule[] {
  const report: ContractMetadataReport = collectMetadata(instanceOrClass);
  // Group clauses by rule name. A Map preserves insertion order (first-seen),
  // so rules appear in the order their first clause is encountered.
  const rules = new Map<string, InferenceRule>();

  function ensureRule(name: string): InferenceRule {
    let r = rules.get(name);
    if (!r) {
      r = {
        name,
        premises: [],
        conclusion: [],
        sideConditions: [],
        frameConditions: [],
        methods: [],
      };
      rules.set(name, r);
    }
    return r;
  }

  function addClause(rule: InferenceRule, clause: RuleClause): void {
    if (clause.isPremise) {
      if (clause.role === "side") rule.sideConditions.push(clause);
      else rule.premises.push(clause);
    } else {
      if (clause.role === "frame") rule.frameConditions.push(clause);
      else rule.conclusion.push(clause);
    }
    // Track the implementing method (dedup).
    if (!rule.methods.includes(clause.method)) {
      rule.methods.push(clause.method);
    }
    // Link the production name if the clause's meta carries a `production` key.
    if (
      rule.production === undefined &&
      typeof clause.meta.production === "string"
    ) {
      rule.production = clause.meta.production;
    }
    // Preserve the first clause's meta as the rule's representative meta.
    if (rule.meta === undefined) rule.meta = clause.meta;
  }

  for (const key of Reflect.ownKeys(report.methods)) {
    const methodReport = report.methods[key as PropertyKey];
    if (!methodReport) continue;
    // Link @rule production metadata: if a @rule(meta) carries a `rule` key
    // matching an inference rule, record the production method name. This
    // connects e.g. `@rule({ rule: "T-App", production: "appProd" })` to the
    // `T-App` inference rule, so the rule knows which production implements it.
    if (methodReport.isRule && methodReport.rule?.meta !== undefined) {
      const prodMeta = methodReport.rule.meta;
      if (hasRuleName(prodMeta)) {
        const ruleName = prodMeta.rule as string;
        const rule = ensureRule(ruleName);
        if (rule.production === undefined) {
          // The @rule meta's `production` key names the production method;
          // fall back to the @rule method's own name (the key) if absent.
          rule.production = typeof prodMeta.production === "string"
            ? prodMeta.production
            : String(key);
        }
      }
    }
    // @requires → premises (or side conditions)
    for (const req of methodReport.requires) {
      if (!hasRuleName(req.meta)) continue; // not an inference-rule clause
      const clause = clauseFromRequires(req, key as PropertyKey);
      const rule = ensureRule(clause.rule);
      addClause(rule, clause);
    }
    // @ensures → conclusion (or frame conditions)
    for (const ens of methodReport.ensures) {
      if (!hasRuleName(ens.meta)) continue; // not an inference-rule clause
      const clause = clauseFromEnsures(ens, key as PropertyKey);
      const rule = ensureRule(clause.rule);
      addClause(rule, clause);
    }
  }

  return [...rules.values()].map(attachFormat);
}

/* ======================================================================
 *  Formatting — inference-rule notation
 * ====================================================================== */

/**
 * Format an {@link InferenceRule} as standard inference-rule (proof-tree)
 * notation:
 *
 * ```text
 * premise₁   premise₂   …   side-condition
 * ─────────────────────────  ruleName
 * conclusion
 * ```
 *
 * Premises and side conditions appear above the line; the rule name and
 * production (if any) label the line; the conclusion appears below. When
 * there are no premises, the line is drawn with nothing above it (an axiom).
 *
 * The separator line is sized to the widest content above or below it.
 *
 * @example
 * ```ts
 * const tApp = STLCTypeCheck.rules.find(r => r.name === "T-App")!;
 * console.log(tApp.format());
 * // fn : σ → τ    arg <: σ
 * // ──────────────────────────  T-App  (appProd)
 * // result : τ
 * ```
 */
export function formatRule(rule: InferenceRule): string {
  // Collect lines above the bar: premises (split on ∧ into spaced judgments)
  // then side conditions. Below: conclusions then frame conditions.
  const clauseText = (c: RuleClause, fallback: string) =>
    c.formula ?? c.description ?? fallback;
  const above = [
    ...rule.premises.map((p) =>
      clauseText(p, `[${rule.name} premise]`)
        .split(/\s*∧\s*/).filter((s) => s.length > 0).join("    ")
    ),
    ...rule.sideConditions.map((s) => clauseText(s, `[${rule.name} side]`)),
  ];
  const below = [
    ...rule.conclusion.map((c) => clauseText(c, `[${rule.name} conclusion]`)),
    ...rule.frameConditions.map((f) => clauseText(f, `[${rule.name} frame]`)),
  ];

  // The bar: a line of ─ sized to the widest content, with the rule name
  // (and production, if linked) appended as a right-aligned label.
  const label = rule.production
    ? `${rule.name}  (${rule.production})`
    : rule.name;
  const contentWidth = Math.max(
    0,
    ...above.map((l) => l.length),
    ...below.map((l) => l.length),
  );
  const barWidth = Math.max(
    contentWidth + 4,
    contentWidth - (label.length + 2) + 4,
  );
  const barLine = "\u2500".repeat(barWidth) + "  " + label;

  return [above.join("\n"), barLine, below.join("\n")]
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * Attach a `format()` method to an {@link InferenceRule} object, returning
 * the same object as a {@link FormattedInferenceRule}. This lets callers
 * write `rule.format()` directly without a null-check.
 */
function attachFormat(rule: InferenceRule): FormattedInferenceRule {
  const formatted = rule as FormattedInferenceRule;
  formatted.format = () => formatRule(rule);
  return formatted;
}
