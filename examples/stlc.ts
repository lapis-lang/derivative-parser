/**
 * Simply Typed Lambda Calculus — the headline *semantics-as-grammar* example.
 *
 * This file demonstrates the central thesis of the ChatGPT discussion:
 * **inference rules can be encoded as grammar productions**.  A typing
 * judgment `Γ ⊢ e : τ` becomes a parameterised production
 * `expr(Γ): Parser<Type>`; an evaluation judgment `ρ ⊢ e ⇓ v` becomes
 * `expr(ρ): Parser<Value>`.  The grammar is no longer merely recognising
 * syntax — it is *deriving judgments*.
 *
 * ─── One-pass context threading via `chain` ────────────────────────────
 *
 * The key enabler is the `chain` combinator (monadic bind): it parses the
 * first parser, then — *after* it completes — calls a function with the
 * result to construct the second parser.  This lets a left sibling's
 * *synthesised* value determine the right sibling's *inherited* context,
 * which is exactly the **L-attributed grammar** pattern.
 *
 * For `λx:τ. body`, the type `τ` is parsed first; `chain` then constructs
 * `body`'s parser under `Γ + {x:τ}` — before `body` is parsed.  No two-pass
 * AST-then-evaluate needed; the typing judgment is computed *during parsing*.
 *
 *   this.chain(this.type, (ty) => this.expr(Γ.extend(name, ty)))
 *
 * Without `chain`, `seq` builds all children eagerly at construction time,
 * so the parsed `τ` cannot flow into `body`'s parser.  See
 * `examples/arith-var.ts` for a case where `seq` suffices (read-only env,
 * never extended during parsing).
 *
 * ─── Surface syntax ───────────────────────────────────────────────────
 *
 *   Types:    τ ::= Int | Bool | τ → τ        (right-associative →)
 *   Terms:    e ::= \ x : τ . e              (abstraction, λ or \)
 *                  | let x : τ = e in e       (let-binding with annotation)
 *                  | app
 *   app       ::= app atom | atom             (left-associative application)
 *   atom      ::= x | ( e ) | true | false | n
 *
 * ─── Interpretations (the payoff) ─────────────────────────────────────
 *
 *   • `STLCAST`       — shape `{expr:Term; atom:Term; type:Type}`:
 *                       pure syntax builder (no env, `seq` only).
 *   • `STLCTypeCheck` — shape `{expr:Type; atom:Type; type:Type}`:
 *                       `@rule expr(Γ): Parser<Type>` — the typing judgment
 *                       (one-pass via `chain`).  Ill-typed terms produce an
 *                       **empty parse forest** — rejection *is* the type
 *                       error.
 *   • `STLCEval`      — shape `{expr:Value; atom:Value; type:Type}`:
 *                       `@rule expr(ρ): Parser<Value>` — call-by-value
 *                       evaluation (one-pass via `chain`).
 *   • `STLCTyped`     — shape `{expr:TypedTerm; atom:TypedTerm; type:Type}`:
 *                       `@rule expr(Γ): Parser<TypedTerm>` — proof-bearing
 *                       type checker.  Each successful parse yields a term
 *                       annotated with its derived type *and* sub-derivations
 *                       — a typing derivation tree ("proofs as parse trees",
 *                       Curry–Howard).
 *
 * Usage:
 *   const tc = new STLCTypeCheck();
 *   const [ty] = tc.parseWith("\\x:Int. x", TypeEnv.empty());
 *   // ty === TFun(TVar("Int"), TVar("Int"))
 *   tc.parseWith("\\x:Int. x x", TypeEnv.empty());  // Set {} — ill-typed
 */

import { Grammar, rule } from "../src/index.ts";
import type { Parser } from "../src/index.ts";
import { assert, ensures, invariant, requires } from "../src/index.ts";

/* ======================================================================
 *  Types
 * ====================================================================== */

export class TVar {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

export class TFun {
  constructor(readonly dom: Type, readonly cod: Type) {}
  toString(): string {
    return `(${this.dom} → ${this.cod})`;
  }
}

export type Type = TVar | TFun;

export function typeEq(a: Type, b: Type): boolean {
  if (a instanceof TVar && b instanceof TVar) return a.name === b.name;
  if (a instanceof TFun && b instanceof TFun) {
    return typeEq(a.dom, b.dom) && typeEq(a.cod, b.cod);
  }
  return false;
}

/* ======================================================================
 *  Terms (AST) — for STLCAST
 * ====================================================================== */

export abstract class Term {
  abstract print(): string;
}

export class Var extends Term {
  constructor(readonly name: string) {
    super();
  }
  override print(): string {
    return this.name;
  }
}

export class Lam extends Term {
  constructor(
    readonly param: string,
    readonly type: Type,
    readonly body: Term,
  ) {
    super();
  }
  override print(): string {
    return `(λ${this.param}:${this.type}. ${this.body.print()})`;
  }
}

export class App extends Term {
  constructor(readonly fn: Term, readonly arg: Term) {
    super();
  }
  override print(): string {
    return `(${this.fn.print()} ${this.arg.print()})`;
  }
}

export class Let extends Term {
  constructor(
    readonly name: string,
    readonly type: Type,
    readonly def: Term,
    readonly body: Term,
  ) {
    super();
  }
  override print(): string {
    return `(let ${this.name}:${this.type} = ${this.def.print()} in ${this.body.print()})`;
  }
}

export class BoolLit extends Term {
  constructor(readonly value: boolean) {
    super();
  }
  override print(): string {
    return String(this.value);
  }
}

export class IntLit extends Term {
  constructor(readonly value: number) {
    super();
  }
  override print(): string {
    return String(this.value);
  }
}

/* ======================================================================
 *  Typed terms (proof-bearing — a typing derivation tree)
 * ====================================================================== */

export abstract class TypedTerm {
  abstract readonly type: Type;
  abstract print(): string;
}

export class TypedVar extends TypedTerm {
  constructor(readonly name: string, readonly type: Type) {
    super();
  }
  override print(): string {
    return `${this.name}:${this.type}`;
  }
}

export class TypedLam extends TypedTerm {
  readonly type: TFun;
  constructor(
    readonly param: string,
    readonly paramType: Type,
    readonly body: TypedTerm,
  ) {
    super();
    this.type = new TFun(paramType, body.type);
  }
  override print(): string {
    return `(λ${this.param}:${this.paramType}. ${this.body.print()}) : ${this.type}`;
  }
}

export class TypedApp extends TypedTerm {
  constructor(
    readonly fn: TypedTerm,
    readonly arg: TypedTerm,
    readonly type: Type,
  ) {
    super();
  }
  override print(): string {
    return `(${this.fn.print()} @ ${this.arg.print()}) : ${this.type}`;
  }
}

export class TypedLet extends TypedTerm {
  constructor(
    readonly name: string,
    readonly type: Type,
    readonly def: TypedTerm,
    readonly body: TypedTerm,
  ) {
    super();
  }
  override print(): string {
    return `(let ${this.name}:${this.type} = ${this.def.print()} in ${this.body.print()}) : ${this.body.type}`;
  }
}

export class TypedBool extends TypedTerm {
  readonly type: Type;
  constructor(readonly value: boolean) {
    super();
    this.type = new TVar("Bool");
  }
  override print(): string {
    return `${this.value}:${this.type}`;
  }
}

export class TypedInt extends TypedTerm {
  readonly type: Type;
  constructor(readonly value: number) {
    super();
    this.type = new TVar("Int");
  }
  override print(): string {
    return `${this.value}:${this.type}`;
  }
}

/* ======================================================================
 *  Values (evaluation results)
 * ====================================================================== */

export type Value = Closure | boolean | number;

export class Closure {
  constructor(
    readonly param: string,
    readonly type: Type,
    readonly body: unknown, // The body parser's result type varies per interpretation
    readonly env: unknown, // The env type varies per interpretation
  ) {}
}

/* ======================================================================
 *  Type environment  (Γ — the typing context)
 * ====================================================================== */

export class TypeEnv {
  private constructor(
    readonly name: string | null,
    readonly type: Type | null,
    readonly parent: TypeEnv | null,
  ) {}

  static empty(): TypeEnv {
    return new TypeEnv(null, null, null);
  }

  extend(name: string, type: Type): TypeEnv {
    return new TypeEnv(name, type, this);
  }

  lookup(name: string): Type | undefined {
    if (this.name === name) return this.type ?? undefined;
    return this.parent?.lookup(name);
  }
}

/* ======================================================================
 *  Value environment  (ρ — the evaluation context)
 * ====================================================================== */

export class ValEnv {
  private constructor(
    readonly name: string | null,
    readonly value: Value | null,
    readonly parent: ValEnv | null,
  ) {}

  static empty(): ValEnv {
    return new ValEnv(null, null, null);
  }

  extend(name: string, value: Value): ValEnv {
    return new ValEnv(name, value, this);
  }

  lookup(name: string): Value | undefined {
    if (this.name === name) return this.value ?? undefined;
    return this.parent?.lookup(name);
  }
}

/* ======================================================================
 *  Shape
 * ====================================================================== */

export interface STLCShape {
  [k: string]: unknown;
  expr: unknown;
  atom: unknown;
  type: unknown;
}

/* ======================================================================
 *  Abstract grammar — shared structure
 * ====================================================================== */

/**
 * Abstract STLC grammar.  The `type` production is shared (always `Type`).
 * Term productions are parameterised by context (`Γ` or `ρ`) and use `chain`
 * to thread extended context into sub-productions.
 *
 * Subclasses implement the abstract semantic-action methods to choose the
 * representation (AST, Type, Value, TypedTerm) — the Bracha / initial-algebra
 * pattern from `arith.ts`.
 *
 * A class `@invariant` declares the well-formedness contract: the grammar's
 * entry production must be defined (not `undefined`). This is checked before
 * each `parse()` / `recognize()` call via `assertInvariants` (see
 * `src/contracts.ts`).
 */
@invariant((self: AbstractSTLC<STLCShape>) => self.start() !== undefined)
export abstract class AbstractSTLC<S extends STLCShape> extends Grammar<S> {
  /* ── semantic actions ────────────────────────────────────────────── */

  protected abstract lam(
    param: string,
    type: Type,
    body: S["expr"],
  ): S["expr"];
  protected abstract app(fn: S["atom"], arg: S["atom"]): S["expr"];
  protected abstract let_(
    name: string,
    type: Type,
    def: S["expr"],
    body: S["expr"],
  ): S["expr"];
  protected abstract varRef(name: string, ctx: unknown): S["atom"];
  protected abstract boolLit(b: boolean): S["atom"];
  protected abstract intLit(n: number): S["atom"];
  protected abstract paren(e: S["expr"]): S["atom"];

  /* ── type production (shared — always returns Type) ──────────────── */

  @rule
  get type(): Parser<Type> {
    return this.or(
      this.seq(this.atomType, this.ws, this.arrow, this.ws, this.type)
        .map(([dom, , , , cod]) => new TFun(dom, cod)),
      this.atomType,
    );
  }

  protected get arrow(): Parser<string> {
    return this.or(this.literal("→"), this.literal("->"));
  }

  @rule
  protected get atomType(): Parser<Type> {
    return this.or(
      this.typeIdent.map((name) => new TVar(name)),
      this.seq(this.char("("), this.ws, this.type, this.ws, this.char(")"))
        .map(([, , t]) => t),
    );
  }

  @rule
  protected get typeIdent(): Parser<string> {
    return this.seq(this.typeIdentFirst, this.typeIdentRest)
      .map(([h, t]) => h + t);
  }

  protected get typeIdentFirst(): Parser<string> {
    return this.pred((c) => c >= "A" && c <= "Z", "<Type-letter>");
  }

  @rule
  protected get typeIdentRest(): Parser<string> {
    return this.or(
      this.seq(this.typeIdentChar, this.typeIdentRest).map(([c, cs]) => c + cs),
      this.epsilon(""),
    );
  }

  protected get typeIdentChar(): Parser<string> {
    return this.pred(
      (c) =>
        (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") ||
        (c >= "0" && c <= "9"),
      "<type-char>",
    );
  }

  /* ── term productions (parameterised by context) ─────────────────── */
  //
  // `ctx` is the inherited context: `TypeEnv` (Γ) for type checking,
  // `ValEnv` (ρ) for evaluation, or `null` for pure syntax.  The `chain`
  // combinator lets a parsed annotation/value extend `ctx` before parsing
  // the body — the L-attributed pattern.

  @rule
  exprProd(ctx: unknown): Parser<S["expr"]> {
    return this.or(
      this.lambdaProd(ctx),
      this.letProd(ctx),
      this.appProd(ctx),
    );
  }

  /**
   * `λx:τ. body` — the key `chain` usage.
   *
   * Parse `\ x : τ .` as a `seq`, then `chain` on the type `τ` to construct
   * `body`'s parser under `ctx + {x:τ}`.  The `chain` fires *after* `τ` is
   * parsed, so the extended context is available when `body` is parsed.
   */
  @rule
  protected lambdaProd(ctx: unknown): Parser<S["expr"]> {
    return this.seq(
      this.lambdaHead, // 0
      this.ident, // 1  param
      this.ws, // 2
      this.char(":"), // 3
      this.ws, // 4
      this.type, // 5  τ
      this.ws, // 6
      this.char("."), // 7
      this.ws, // 8
    ).chain(([, param, , , , ty]) => {
      // τ is now available; extend ctx and parse body.
      // `assert` narrows the destructured tuple members (catching bracket-count
      // bugs at parse time) — a Phase 0 proof of concept of inline assertions.
      assert(typeof param === "string", "lambda param must be a string");
      assert(
        ty instanceof TVar || ty instanceof TFun,
        "lambda type must be a Type",
      );
      return this.exprProd(this.extendCtx(ctx, param, ty))
        .map((body) => this.lam(param, ty, body));
    }).map(([, result]) => result);
  }

  /**
   * `let x:τ = def in body` — `chain` on `τ` to parse `def` under outer `ctx`,
   * then `chain` on `def`'s result to extend `ctx` for `body`.
   *
   * For type checking: `def` is checked under `ctx`, yielding its type; `body`
   * is checked under `ctx + {x:τ}`.  For evaluation: `def` is evaluated under
   * `ctx`, yielding its value; `body` is evaluated under `ctx + {x:v}`.
   */
  @rule
  protected letProd(ctx: unknown): Parser<S["expr"]> {
    return this.seq(
      this.kw("let"), // 0
      this.ws1, // 1
      this.ident, // 2  name
      this.ws, // 3
      this.char(":"), // 4
      this.ws, // 5
      this.type, // 6  τ
      this.ws, // 7
      this.char("="), // 8
      this.ws, // 9
    ).chain(([, , name, , , , ty]) =>
      // Parse def under outer ctx, then consume "in", then parse body.
      this.exprProd(ctx)
        .map((def) => ({ name, ty, def }))
        .chain(({ name, ty, def }) =>
          this.seq(this.ws1, this.kw("in"), this.ws1)
            .chain(() =>
              this.exprProd(this.extendCtx(ctx, name, ty))
                .map((body) => this.let_(name, ty, def, body))
            )
            .map(([, result]) => result)
        )
        .map(([, result]) => result)
    ).map(([, result]) => result);
  }

  @rule
  protected appProd(ctx: unknown): Parser<S["expr"]> {
    return this.or(
      this.seq(this.appProd(ctx), this.ws1, this.atomProd(ctx))
        .map(([fn, , arg]) => this.app(fn, arg)),
      this.atomProd(ctx) as Parser<S["expr"]>,
    );
  }

  @rule
  protected atomProd(ctx: unknown): Parser<S["atom"]> {
    return this.or(
      this.seq(
        this.char("("),
        this.ws,
        this.exprProd(ctx),
        this.ws,
        this.char(")"),
      )
        .map(([, , e]) => this.paren(e)),
      this.kw("true").map(() => this.boolLit(true)),
      this.kw("false").map(() => this.boolLit(false)),
      this.intLiteral.map((n) => this.intLit(n)),
      this.ident.map((name) => this.varRef(name, ctx)),
    );
  }

  /* ── context extension hook ──────────────────────────────────────── */
  //
  // `extendCtx` is called inside `chain` callbacks — *after* the annotation
  // is parsed, *before* the body is parsed.  The default is a no-op (for
  // `STLCAST`, which ignores context).  Semantic subclasses override it.

  protected extendCtx(ctx: unknown, _name: string, _type: Type): unknown {
    return ctx;
  }

  /* ── lexemes ─────────────────────────────────────────────────────── */

  @rule
  protected get intLiteral(): Parser<number> {
    return this.digits.map((s) => Number(s));
  }

  @rule
  protected get digits(): Parser<string> {
    return this.or(
      this.seq(this.digit, this.digits).map(([d, ds]) => d + ds),
      this.digit,
    );
  }

  protected get digit(): Parser<string> {
    return this.pred((c) => c >= "0" && c <= "9", "<digit>");
  }

  @rule
  protected get ident(): Parser<string> {
    return this.seq(this.identFirst, this.identRest)
      .map(([h, t]) => h + t)
      .chain((name) => {
        if (
          name === "let" || name === "in" || name === "true" || name === "false"
        ) {
          return this.empty() as unknown as Parser<string>;
        }
        return this.epsilon(name);
      })
      .map(([name]) => name);
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

  protected get lambdaHead(): Parser<string> {
    return this.or(this.char("λ"), this.char("\\"));
  }

  protected kw(word: string): Parser<string> {
    return this.literal(word);
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

  @rule
  protected get ws1(): Parser<string> {
    return this.seq(this.wsChar, this.ws).map(([c, cs]) => c + cs);
  }
}

/* ======================================================================
 *  Concrete: AST builder (no context)
 * ====================================================================== */

export class STLCAST
  extends AbstractSTLC<{ expr: Term; atom: Term; type: Type }> {
  override start(): Parser<Term> {
    return this.exprProd(null);
  }

  protected lam(param: string, type: Type, body: Term): Term {
    return new Lam(param, type, body);
  }
  protected app(fn: Term, arg: Term): Term {
    return new App(fn, arg);
  }
  protected let_(name: string, type: Type, def: Term, body: Term): Term {
    return new Let(name, type, def, body);
  }
  protected varRef(name: string, _ctx: unknown): Term {
    return new Var(name);
  }
  protected boolLit(b: boolean): Term {
    return new BoolLit(b);
  }
  protected intLit(n: number): Term {
    return new IntLit(n);
  }
  protected paren(e: Term): Term {
    return e;
  }
}

/* ======================================================================
 *  Concrete: type checker  — `expr(Γ): Parser<Type>`
 * ====================================================================== */

/**
 * One-pass type checker.  The typing judgment `Γ ⊢ e : τ` is a parameterised
 * production `expr(Γ): Parser<Type>`.  `chain` threads the extended `Γ` into
 * sub-productions.  Ill-typed terms produce an **empty parse forest** —
 * rejection *is* the type error.
 *
 * Inference rules encoded:
 *
 *   Γ(x) = τ
 *   ─────────────  (Var)
 *   Γ ⊢ x : τ
 *
 *   Γ, x:τ₁ ⊢ body : τ₂
 *   ──────────────────────────────  (Lam)
 *   Γ ⊢ λx:τ₁. body : τ₁ → τ₂
 *
 *   Γ ⊢ fn : τ₁ → τ₂    Γ ⊢ arg : τ₁
 *   ─────────────────────────────────  (App)
 *   Γ ⊢ fn arg : τ₂
 *
 *   Γ ⊢ def : τ    Γ, x:τ ⊢ body : τ'
 *   ────────────────────────────────────  (Let)
 *   Γ ⊢ let x:τ = def in body : τ'
 *
 * The `App` rule uses `chain` to check the domain matches: parse `fn`
 * (getting `τ₁→τ₂`), then parse `arg` (getting `τ₃`), then if `τ₁ = τ₃`
 * return `ε(τ₂)`, else return `∅` (empty — the parse fails, i.e. the term
 * is ill-typed).
 */
export class STLCTypeCheck
  extends AbstractSTLC<{ expr: Type; atom: Type; type: Type }> {
  parseWith(input: string, env: TypeEnv): Set<Type> {
    return this._parseWith(input, this.exprProd(env));
  }

  override start(): Parser<Type> {
    return this.exprProd(TypeEnv.empty());
  }

  protected override extendCtx(
    ctx: unknown,
    name: string,
    type: Type,
  ): unknown {
    return (ctx as TypeEnv).extend(name, type);
  }

  protected lam(_param: string, type: Type, body: Type): Type {
    return new TFun(type, body);
  }
  /**
   * Application typing rule (App): `fn` must be a function type whose domain
   * matches `arg`'s type. Declared as `@requires` (the inference-rule
   * premise) and `@ensures` (the conclusion: the result is a valid `Type`).
   *
   * On a failed premise, `@requires` returns `undefined` (graceful) — the
   * calling `chain` callback produces `empty()`, so the ill-typed branch is
   * rejected without raising an exception.
   */
  @requires((_self: STLCTypeCheck, fn: Type, arg: Type) =>
    fn instanceof TFun && typeEq(fn.dom, arg)
  )
  @ensures(
    (
      _self: STLCTypeCheck,
      _args: [Type, Type],
      _old: STLCTypeCheck,
      result: Type,
    ) => result instanceof TVar || result instanceof TFun,
  )
  protected app(fn: Type, _arg: Type): Type {
    // The premise is enforced by @requires; the body is the rule's conclusion.
    return (fn as TFun).cod;
  }
  protected let_(_name: string, _type: Type, _def: Type, body: Type): Type {
    return body;
  }
  /**
   * Variable typing rule (Var): `name` must be bound in `ctx`. Declared as
   * `@requires` — on failure returns `undefined` (graceful), so an unbound
   * variable produces an empty parse forest rather than throwing.
   */
  @requires((_self: STLCTypeCheck, name: string, ctx: unknown) =>
    ctx instanceof TypeEnv && ctx.lookup(name) !== undefined
  )
  protected varRef(name: string, ctx: unknown): Type {
    return (ctx as TypeEnv).lookup(name) as Type;
  }
  protected boolLit(_b: boolean): Type {
    return new TVar("Bool");
  }
  protected intLit(_n: number): Type {
    return new TVar("Int");
  }
  protected paren(e: Type): Type {
    return e;
  }

  /**
   * Override `appProd` to type-check `App` via `chain`:
   * parse `fn` → get `fnTy`; parse `arg` → get `argTy`; if `fnTy` is a
   * function type and `fnTy.dom = argTy`, return `ε(fnTy.cod)`, else `∅`.
   *
   * (Full `@rescue` integration — emitting a diagnostic instead of a silent
   * `∅` — requires zipper-engine hooks to detect the empty forest per
   * production; that is deferred to a future phase. See issue #4 Phase 2.)
   */
  @rule
  protected override appProd(ctx: unknown): Parser<Type> {
    return this.or(
      this.appProd(ctx)
        .map((fnTy) => ({ fnTy }))
        .chain(({ fnTy }) =>
          this.seq(this.ws1, this.atomProd(ctx))
            .map(([, argTy]) => ({ fnTy, argTy }))
            .chain(({ fnTy, argTy }) => {
              if (!(fnTy instanceof TFun) || !typeEq(fnTy.dom, argTy)) {
                return this.empty() as unknown as Parser<Type>;
              }
              return this.epsilon<Type>(fnTy.cod);
            })
            .map(([, result]) => result)
        )
        .map(([, result]) => result),
      this.atomProd(ctx) as Parser<Type>,
    );
  }
}

/* ======================================================================
 *  Concrete: evaluator  — `expr(ρ): Parser<Value>`
 * ====================================================================== */

/**
 * One-pass call-by-value evaluator.  The evaluation judgment `ρ ⊢ e ⇓ v` is
 * a parameterised production `expr(ρ): Parser<Value>`.  `chain` threads the
 * extended `ρ` into sub-productions.
 *
 *   ρ(x) = v
 *   ──────────  (Var)
 *   ρ ⊢ x ⇓ v
 *
 *   ρ ⊢ λx:τ. body ⇓ ⟨x, τ, body, ρ⟩        (closure)
 *
 *   ρ ⊢ fn ⇓ ⟨x, body, ρ'⟩    ρ ⊢ arg ⇓ v    ρ', x=v ⊢ body ⇓ w
 *   ─────────────────────────────────────────────────────────────  (App)
 *   ρ ⊢ fn arg ⇓ w
 *
 *   ρ ⊢ def ⇓ v    ρ, x=v ⊢ body ⇓ w
 *   ────────────────────────────────────────  (Let)
 *   ρ ⊢ let x = def in body ⇓ w
 *
 * **Multi-pass (Pattern 1)**: evaluation of lambda abstractions requires
 * deferring the body — a closure captures the *unevaluated* body AST and
 * evaluates it on application under an extended environment.  This cannot be
 * done in a single forward pass (the body text is consumed once), so
 * `STLCEval` extends `STLCAST` and evaluates the AST built by `super` via a
 * separate recursive function.  This is the Bracha multi-pass pattern: the
 * class hierarchy *is* the compiler pipeline.
 */
export class STLCEval extends STLCAST {
  /**
   * Parse to AST (via `super`) then evaluate under `env`.
   * The grammar builds the AST; `evalTerm` is the evaluation judgment.
   */
  parseWith(input: string, env: ValEnv): Set<Value> {
    const asts = [...this._parseWith(input, this.start())];
    const results = new Set<Value>();
    for (const ast of asts) {
      try {
        results.add(evalTerm(ast as Term, env));
      } catch {
        // ill-typed or stuck term — skip
      }
    }
    return results;
  }
}

/**
 * Evaluate `term` under `env` (call-by-value).  This is the evaluation
 * judgment `ρ ⊢ e ⇓ v` as a syntax-directed recursive function — one rule
 * per AST constructor.
 *
 *   ρ(x) = v
 *   ──────────  (Var)
 *   ρ ⊢ x ⇓ v
 *
 *   ρ ⊢ λx:τ. body ⇓ ⟨x, τ, body, ρ⟩        (closure)
 *
 *   ρ ⊢ fn ⇓ ⟨x, body, ρ'⟩    ρ ⊢ arg ⇓ v    ρ', x=v ⊢ body ⇓ w
 *   ─────────────────────────────────────────────────────────────  (App)
 *   ρ ⊢ fn arg ⇓ w
 *
 *   ρ ⊢ def ⇓ v    ρ, x=v ⊢ body ⇓ w
 *   ────────────────────────────────────────  (Let)
 *   ρ ⊢ let x = def in body ⇓ w
 */
export function evalTerm(term: Term, env: ValEnv): Value {
  if (term instanceof Var) {
    const v = env.lookup(term.name);
    if (v === undefined) throw new Error(`unbound variable: ${term.name}`);
    return v;
  }
  if (term instanceof Lam) {
    return new Closure(term.param, term.type, term.body, env);
  }
  if (term instanceof App) {
    const fn = evalTerm(term.fn, env);
    const arg = evalTerm(term.arg, env);
    if (!(fn instanceof Closure)) throw new Error(`cannot apply non-function`);
    return evalTerm(fn.body as Term, (fn.env as ValEnv).extend(fn.param, arg));
  }
  if (term instanceof Let) {
    const defVal = evalTerm(term.def, env);
    return evalTerm(term.body, env.extend(term.name, defVal));
  }
  if (term instanceof BoolLit) return term.value;
  if (term instanceof IntLit) return term.value;
  throw new Error(`unknown term`);
}

/* ======================================================================
 *  Concrete: proof-bearing type checker  — `expr(Γ): Parser<TypedTerm>`
 * ====================================================================== */

/**
 * Proof-bearing type checker.  Like `STLCTypeCheck` but returns `TypedTerm` —
 * each node carries its derived type *and* the sub-derivations.  A successful
 * parse yields a typing derivation tree ("proofs as parse trees", Curry–Howard).
 */
export class STLCTyped
  extends AbstractSTLC<{ expr: TypedTerm; atom: TypedTerm; type: Type }> {
  parseWith(input: string, env: TypeEnv): Set<TypedTerm> {
    return this._parseWith(input, this.exprProd(env));
  }

  override start(): Parser<TypedTerm> {
    return this.exprProd(TypeEnv.empty());
  }

  protected override extendCtx(
    ctx: unknown,
    name: string,
    type: Type,
  ): unknown {
    return (ctx as TypeEnv).extend(name, type);
  }

  protected lam(param: string, type: Type, body: TypedTerm): TypedTerm {
    return new TypedLam(param, type, body);
  }
  protected app(fn: TypedTerm, arg: TypedTerm): TypedTerm {
    // Not used — App is handled via chain in appProd override.
    if (!(fn.type instanceof TFun)) return undefined as unknown as TypedTerm;
    return new TypedApp(fn, arg, fn.type.cod);
  }
  protected let_(
    name: string,
    type: Type,
    def: TypedTerm,
    body: TypedTerm,
  ): TypedTerm {
    return new TypedLet(name, type, def, body);
  }
  protected varRef(name: string, ctx: unknown): TypedTerm {
    const ty = (ctx as TypeEnv).lookup(name);
    if (!ty) return undefined as unknown as TypedTerm;
    return new TypedVar(name, ty);
  }
  protected boolLit(b: boolean): TypedTerm {
    return new TypedBool(b);
  }
  protected intLit(n: number): TypedTerm {
    return new TypedInt(n);
  }
  protected paren(e: TypedTerm): TypedTerm {
    return e;
  }

  @rule
  protected override appProd(ctx: unknown): Parser<TypedTerm> {
    return this.or(
      this.appProd(ctx)
        .map((fnTT) => ({ fnTT }))
        .chain(({ fnTT }) =>
          this.seq(this.ws1, this.atomProd(ctx))
            .map(([, argTT]) => ({ fnTT, argTT }))
            .chain(({ fnTT, argTT }) => {
              if (
                !(fnTT.type instanceof TFun) ||
                !typeEq(fnTT.type.dom, argTT.type)
              ) {
                return this.empty() as unknown as Parser<TypedTerm>;
              }
              return this.epsilon<TypedTerm>(
                new TypedApp(fnTT, argTT, fnTT.type.cod),
              );
            })
            .map(([, result]) => result)
        )
        .map(([, result]) => result),
      this.atomProd(ctx) as Parser<TypedTerm>,
    );
  }
}
