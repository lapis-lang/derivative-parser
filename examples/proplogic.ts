/**
 * Propositional Logic — formulas, truth evaluation, and natural-deduction
 * proofs as grammar productions.
 *
 * This file demonstrates the Curry–Howard correspondence from the ChatGPT
 * discussion: **inference rules are a grammar over proofs**, and a
 * natural-deduction derivation is literally a parse tree.
 *
 * ─── Surface syntax ───────────────────────────────────────────────────
 *
 *   formula ::= imp
 *   imp      ::= imp → or | or              (right-associative →)
 *   or       ::= or ∨ and | and              (left-associative ∨)
 *   and      ::= and ∧ atom | atom           (left-associative ∧)
 *   atom     ::= ⊤ | ⊥ | var | ( formula ) | ¬ atom
 *
 *   var ::= [a-z]+
 *
 * ─── Interpretations ──────────────────────────────────────────────────
 *
 *   • `PropAST`   — shape `{formula:Formula; atom:Formula}`: formula builder.
 *   • `PropTruth` — `@rule formula(α): Parser<boolean>`: truth-table evaluator
 *                   under a variable assignment (inherited context, Pattern 2
 *                   with read-only env — like `arith-var.ts`).
 *   • `PropProof` — `@rule formula(Γ): Parser<NDProof>`: natural-deduction
 *                   proof builder.  `Γ` is the set of available hypotheses.
 *                   Each connective's introduction rule extends `Γ` for its
 *                   sub-proof.  A successful parse yields a proof tree —
 *                   "proofs as parse trees" (Curry–Howard).
 *
 * Usage:
 *   const g = new PropAST();
 *   const [f] = g.parse("p → p");           // Imp(Var("p"), Var("p"))
 *   const t = new PropTruth();
 *   const [v] = t.parseWith("p ∧ ¬p", {p:true});  // false
 *   const pr = new PropProof();
 *   const [proof] = pr.parseWith("p → p", new Set());  // ImpIntro(...)
 */

import { Grammar, rule } from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ══════════════════════════════════════════════════════════════════════
 *  Formulas
 * ══════════════════════════════════════════════════════════════════════ */

export type Formula =
  | { tag: "var"; name: string }
  | { tag: "top" }
  | { tag: "bot" }
  | { tag: "not"; inner: Formula }
  | { tag: "and"; left: Formula; right: Formula }
  | { tag: "or"; left: Formula; right: Formula }
  | { tag: "imp"; left: Formula; right: Formula };

export function formulaEq(a: Formula, b: Formula): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case "var":
      return a.name === (b as { tag: "var"; name: string }).name;
    case "top":
    case "bot":
      return true;
    case "not":
      return formulaEq(a.inner, (b as { tag: "not"; inner: Formula }).inner);
    case "and":
    case "or":
    case "imp": {
      const bb = b as {
        tag: "and" | "or" | "imp";
        left: Formula;
        right: Formula;
      };
      return formulaEq(a.left, bb.left) && formulaEq(a.right, bb.right);
    }
  }
}

export function printFormula(f: Formula): string {
  switch (f.tag) {
    case "var":
      return f.name;
    case "top":
      return "⊤";
    case "bot":
      return "⊥";
    case "not":
      return `¬${printFormula(f.inner)}`;
    case "and":
      return `(${printFormula(f.left)} ∧ ${printFormula(f.right)})`;
    case "or":
      return `(${printFormula(f.left)} ∨ ${printFormula(f.right)})`;
    case "imp":
      return `(${printFormula(f.left)} → ${printFormula(f.right)})`;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 *  Natural deduction proof trees
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * A natural-deduction proof.  Each constructor is one inference rule.
 * The children are sub-proofs.  This is the "proofs as parse trees" view.
 */
export type NDProof =
  | { tag: "assump"; formula: Formula }
  | { tag: "topIntro" }
  | { tag: "botElim"; proof: NDProof }
  | { tag: "notIntro"; proof: NDProof }
  | { tag: "notElim"; proof: NDProof }
  | { tag: "andIntro"; left: NDProof; right: NDProof }
  | { tag: "andElimL"; proof: NDProof }
  | { tag: "andElimR"; proof: NDProof }
  | { tag: "orIntroL"; proof: NDProof; right: Formula }
  | { tag: "orIntroR"; left: Formula; proof: NDProof }
  | { tag: "orElim"; proof: NDProof; left: NDProof; right: NDProof }
  | { tag: "impIntro"; proof: NDProof }
  | { tag: "impElim"; fn: NDProof; arg: NDProof };

export function printProof(p: NDProof, indent = 0): string {
  const pad = "  ".repeat(indent);
  switch (p.tag) {
    case "assump":
      return `${pad}[${printFormula(p.formula)}]`;
    case "topIntro":
      return `${pad}⊤Intro`;
    case "botElim":
      return `${pad}⊥Elim\n${printProof(p.proof, indent + 1)}`;
    case "notIntro":
      return `${pad}¬Intro\n${printProof(p.proof, indent + 1)}`;
    case "notElim":
      return `${pad}¬Elim\n${printProof(p.proof, indent + 1)}`;
    case "andIntro":
      return `${pad}∧Intro\n${printProof(p.left, indent + 1)}\n${
        printProof(p.right, indent + 1)
      }`;
    case "andElimL":
      return `${pad}∧ElimL\n${printProof(p.proof, indent + 1)}`;
    case "andElimR":
      return `${pad}∧ElimR\n${printProof(p.proof, indent + 1)}`;
    case "orIntroL":
      return `${pad}∨IntroL\n${printProof(p.proof, indent + 1)}`;
    case "orIntroR":
      return `${pad}∨IntroR\n${printProof(p.proof, indent + 1)}`;
    case "orElim":
      return `${pad}∨Elim\n${printProof(p.proof, indent + 1)}\n${
        printProof(p.left, indent + 1)
      }\n${printProof(p.right, indent + 1)}`;
    case "impIntro":
      return `${pad}→Intro\n${printProof(p.proof, indent + 1)}`;
    case "impElim":
      return `${pad}→Elim\n${printProof(p.fn, indent + 1)}\n${
        printProof(p.arg, indent + 1)
      }`;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 *  Shape & abstract grammar
 * ══════════════════════════════════════════════════════════════════════ */

export interface PropShape {
  [k: string]: unknown;
  formula: unknown;
  atom: unknown;
}

/**
 * Abstract propositional-logic grammar.  Precedence (loosest to tightest):
 *   → (right-assoc) > ∨ (left-assoc) > ∧ (left-assoc) > ¬ > atoms
 *
 * Subclasses implement semantic actions to choose the representation.
 */
export abstract class AbstractProp<S extends PropShape> extends Grammar<S> {
  /* ── semantic actions ────────────────────────────────────────────── */

  protected abstract imp(l: S["formula"], r: S["formula"]): S["formula"];
  protected abstract or_(l: S["formula"], r: S["formula"]): S["formula"];
  protected abstract and_(l: S["formula"], r: S["formula"]): S["formula"];
  protected abstract not_(inner: S["atom"]): S["atom"];
  protected abstract top(): S["atom"];
  protected abstract bot(): S["atom"];
  protected abstract var_(name: string, ctx: unknown): S["atom"];
  protected abstract paren(e: S["formula"]): S["atom"];

  override start(): Parser<S["formula"]> {
    return this.formulaProd;
  }

  /* ── formula → imp (right-assoc) ─────────────────────────────────── */

  @rule
  get formulaProd(): Parser<S["formula"]> {
    return this.or(
      this.seq(this.orProd, this.ws, this.arrow, this.ws, this.formulaProd)
        .map(([l, , , , r]) => this.imp(l, r)),
      this.orProd,
    );
  }

  protected get arrow(): Parser<string> {
    return this.or(this.literal("→"), this.literal("->"));
  }

  /* ── or (left-assoc) ────────────────────────────────────────────── */

  @rule
  protected get orProd(): Parser<S["formula"]> {
    return this.or(
      this.seq(this.orProd, this.ws, this.orSym, this.ws, this.andProd)
        .map(([l, , , , r]) => this.or_(l, r)),
      this.andProd,
    );
  }

  protected get orSym(): Parser<string> {
    return this.or(this.literal("∨"), this.literal("|"));
  }

  /* ── and (left-assoc) ───────────────────────────────────────────── */

  @rule
  protected get andProd(): Parser<S["formula"]> {
    return this.or(
      this.seq(this.andProd, this.ws, this.andSym, this.ws, this.notProd)
        .map(([l, , , , r]) => this.and_(l, r)),
      this.notProd,
    );
  }

  protected get andSym(): Parser<string> {
    return this.or(this.literal("∧"), this.literal("&"));
  }

  /* ── not ────────────────────────────────────────────────────────── */

  @rule
  protected get notProd(): Parser<S["formula"]> {
    return this.or(
      this.seq(this.notSym, this.ws, this.atomProd)
        .map(([, , a]) => this.not_(a) as unknown as S["formula"]),
      this.atomProd as Parser<S["formula"]>,
    );
  }

  protected get notSym(): Parser<string> {
    return this.or(this.literal("¬"), this.literal("~"));
  }

  /* ── atom ───────────────────────────────────────────────────────── */

  @rule
  protected get atomProd(): Parser<S["atom"]> {
    return this.or(
      this.literal("⊤").map(() => this.top()),
      this.literal("⊥").map(() => this.bot()),
      this.seq(
        this.char("("),
        this.ws,
        this.formulaProd,
        this.ws,
        this.char(")"),
      )
        .map(([, , e]) => this.paren(e)),
      this.ident.map((name) => this.var_(name, null)),
    );
  }

  /* ── lexemes ─────────────────────────────────────────────────────── */

  @rule
  protected get ident(): Parser<string> {
    return this.seq(this.identFirst, this.identRest)
      .map(([h, t]) => h + t);
  }

  protected get identFirst(): Parser<string> {
    return this.pred((c) => c >= "a" && c <= "z", "<letter>");
  }

  @rule
  protected get identRest(): Parser<string> {
    return this.or(
      this.seq(this.identChar, this.identRest).map(([c, cs]) => c + cs),
      this.epsilon(""),
    );
  }

  protected get identChar(): Parser<string> {
    return this.pred(
      (c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_",
      "<id-char>",
    );
  }

  protected get wsChar(): Parser<string> {
    return this.pred(
      (c) => c === " " || c === "\t" || c === "\n" || c === "\r",
      "<ws>",
    );
  }

  @rule
  protected get ws(): Parser<string> {
    return this.or(
      this.seq(this.wsChar, this.ws).map(([c, cs]) => c + cs),
      this.epsilon(""),
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════
 *  Concrete: formula builder
 * ══════════════════════════════════════════════════════════════════════ */

export class PropAST extends AbstractProp<{ formula: Formula; atom: Formula }> {
  protected imp(l: Formula, r: Formula): Formula {
    return { tag: "imp", left: l, right: r };
  }
  protected or_(l: Formula, r: Formula): Formula {
    return { tag: "or", left: l, right: r };
  }
  protected and_(l: Formula, r: Formula): Formula {
    return { tag: "and", left: l, right: r };
  }
  protected not_(inner: Formula): Formula {
    return { tag: "not", inner };
  }
  protected top(): Formula {
    return { tag: "top" };
  }
  protected bot(): Formula {
    return { tag: "bot" };
  }
  protected var_(name: string, _ctx: unknown): Formula {
    return { tag: "var", name };
  }
  protected paren(e: Formula): Formula {
    return e;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 *  Concrete: truth-table evaluator  — `formula(α): Parser<boolean>`
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Truth-table evaluator.  `α` is a variable assignment (`Record<string, boolean>`).
 * Read-only inherited context — like `arith-var.ts`, the env is supplied
 * externally and never extended during parsing.  Threaded as a parameterised
 * `@rule` method argument (not mutable instance state), so it is safe for
 * concurrent use.
 *
 *   α(p) = b
 *   ──────────  (Var)
 *   α ⊨ p : b
 *
 *   α ⊨ ⊤ : true      α ⊨ ⊥ : false
 *
 *   α ⊨ A : a    α ⊨ B : b
 *   ────────────────────────  (∧)
 *   α ⊨ A ∧ B : a && b
 *
 *   α ⊨ A : a    α ⊨ B : b
 *   ────────────────────────  (∨)
 *   α ⊨ A ∨ B : a || b
 *
 *   α ⊨ A : a    α ⊨ B : b
 *   ──────────────────────────────  (→)
 *   α ⊨ A → B : !a || b
 *
 *   α ⊨ A : a
 *   ─────────────  (¬)
 *   α ⊨ ¬A : !a
 */
export class PropTruth
  extends AbstractProp<{ formula: boolean; atom: boolean }> {
  protected imp(l: boolean, r: boolean): boolean {
    return !l || r;
  }
  protected or_(l: boolean, r: boolean): boolean {
    return l || r;
  }
  protected and_(l: boolean, r: boolean): boolean {
    return l && r;
  }
  protected not_(inner: boolean): boolean {
    return !inner;
  }
  protected top(): boolean {
    return true;
  }
  protected bot(): boolean {
    return false;
  }
  protected var_(name: string, alpha: Record<string, boolean>): boolean {
    const v = alpha[name];
    if (v === undefined) throw new Error(`unbound variable: ${name}`);
    return v;
  }
  protected paren(e: boolean): boolean {
    return e;
  }

  /**
   * Parse `input` under variable assignment `alpha`.  The assignment is
   * threaded as an *inherited attribute* through parameterised `@rule`
   * methods — no mutable instance state, safe for concurrent use.
   */
  parseWith(input: string, alpha: Record<string, boolean>): Set<boolean> {
    return this._parseWith(input, this.formulaEval(alpha));
  }

  /**
   * Default `parse` with an empty assignment.  Variables will be unbound
   * (branches containing them are dropped), so only variable-free formulas
   * (⊤, ⊥, and combinations thereof) produce results.
   */
  override parse(input: string): Set<boolean> {
    return this.parseWith(input, {});
  }

  /** Default `recognize` with an empty assignment. */
  override recognize(input: string): boolean {
    return this.parseWith(input, {}).size > 0;
  }

  /* ── parameterised productions (thread alpha as inherited context) ── */
  //
  // These override the abstract grammar's getter-form productions with
  // parameterised @rule methods, threading `alpha` through the full
  // production chain.  Lexeme productions (ident, ws, etc.) stay as getters
  // since they don't need the context.

  @rule
  formulaEval(alpha: Record<string, boolean>): Parser<boolean> {
    return this.or(
      this.seq(
        this.orEval(alpha),
        this.ws,
        this.arrow,
        this.ws,
        this.formulaEval(alpha),
      )
        .map(([l, , , , r]) => this.imp(l, r)),
      this.orEval(alpha),
    );
  }

  @rule
  protected orEval(alpha: Record<string, boolean>): Parser<boolean> {
    return this.or(
      this.seq(
        this.orEval(alpha),
        this.ws,
        this.orSym,
        this.ws,
        this.andEval(alpha),
      )
        .map(([l, , , , r]) => this.or_(l, r)),
      this.andEval(alpha),
    );
  }

  @rule
  protected andEval(alpha: Record<string, boolean>): Parser<boolean> {
    return this.or(
      this.seq(
        this.andEval(alpha),
        this.ws,
        this.andSym,
        this.ws,
        this.notEval(alpha),
      )
        .map(([l, , , , r]) => this.and_(l, r)),
      this.notEval(alpha),
    );
  }

  @rule
  protected notEval(alpha: Record<string, boolean>): Parser<boolean> {
    return this.or(
      this.seq(this.notSym, this.ws, this.atomEval(alpha))
        .map(([, , a]) => this.not_(a)),
      this.atomEval(alpha),
    );
  }

  @rule
  protected atomEval(alpha: Record<string, boolean>): Parser<boolean> {
    return this.or(
      this.literal("⊤").map(() => this.top()),
      this.literal("⊥").map(() => this.bot()),
      this.seq(
        this.char("("),
        this.ws,
        this.formulaEval(alpha),
        this.ws,
        this.char(")"),
      )
        .map(([, , e]) => this.paren(e)),
      this.ident.map((name) => this.var_(name, alpha)),
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════
 *  Concrete: natural-deduction proof builder  — multi-pass
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Natural-deduction proof builder.  `Γ` is the set of available hypotheses.
 * A successful parse yields a proof tree — "proofs as parse trees".
 *
 * **Multi-pass (Pattern 1)**: proof search requires backtracking and
 * hypothesis management that goes beyond simple L-attributed threading.
 * The `→Intro` rule must extend `Γ` with the antecedent before searching
 * for a proof of the consequent — but the grammar parses both sides of `→`
 * uniformly.  So `PropProof` extends `PropAST` and runs a separate `prove`
 * function over the formula AST.
 *
 * Key rules:
 *
 *   Γ, A ⊢ proof : B
 *   ─────────────────────  (→Intro)
 *   Γ ⊢ →Intro(proof) : A → B
 *
 *   A ∈ Γ
 *   ───────────  (assumption)
 *   Γ ⊢ assump(A) : A
 *
 * **Note**: This is a *constructive* proof system.  Not all tautologies are
 * provable (e.g. excluded middle requires classical rules).  Unprovable
 * formulas produce an empty result set.
 */
export class PropProof extends PropAST {
  parseWith(input: string, gamma: Set<Formula>): Set<NDProof> {
    const formulas = [...this._parseWith(input, this.start())];
    const results = new Set<NDProof>();
    for (const f of formulas) {
      const proof = prove(f as Formula, [...gamma]);
      if (proof !== undefined) results.add(proof);
    }
    return results;
  }
}

/**
 * Search for a natural-deduction proof of `goal` under hypotheses `Γ`.
 * Returns `undefined` if no proof exists.
 *
 * This is the proof-search judgment `Γ ⊢ goal` as a recursive function —
 * one rule per connective.  Each introduction rule recurses on sub-goals
 * (possibly with extended `Γ`).
 */
export function prove(goal: Formula, gamma: Formula[]): NDProof | undefined {
  // 1. Assumption: goal is in Γ
  for (const h of gamma) {
    if (formulaEq(h, goal)) return { tag: "assump", formula: goal };
  }

  switch (goal.tag) {
    case "top":
      return { tag: "topIntro" };

    case "and": {
      // ∧Intro: prove both conjuncts
      const lp = prove(goal.left, gamma);
      const rp = prove(goal.right, gamma);
      if (lp && rp) return { tag: "andIntro", left: lp, right: rp };
      return undefined;
    }

    case "imp": {
      // →Intro: assume antecedent, prove consequent under extended Γ
      const proof = prove(goal.right, [...gamma, goal.left]);
      if (proof) return { tag: "impIntro", proof };
      return undefined;
    }

    case "or": {
      // ∨IntroL: prove left; ∨IntroR: prove right
      const lp = prove(goal.left, gamma);
      if (lp) return { tag: "orIntroL", proof: lp, right: goal.right };
      const rp = prove(goal.right, gamma);
      if (rp) return { tag: "orIntroR", left: goal.left, proof: rp };
      return undefined;
    }

    case "not": {
      // ¬Intro: assume inner, derive ⊥
      const proof = prove({ tag: "bot" }, [...gamma, goal.inner]);
      if (proof) return { tag: "notIntro", proof };
      return undefined;
    }

    case "bot":
    case "var":
      // Cannot prove without it being in Γ (already checked above)
      return undefined;
  }
}
