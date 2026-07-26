/**
 * Simply Typed Lambda Calculus — four interpretations of one grammar:
 * AST builder, type checker, evaluator, proof-bearing type checker.
 * Uses `chain` for L-attributed one-pass context threading. See the README.
 */

import { Grammar, rule } from "../src/index.ts";
import {
  char,
  digits as digitsLexeme,
  empty,
  epsilon,
  flattenTree,
  ident as identLexeme,
  literal,
  or,
  parserOf,
  seq,
  TreeExp,
  ws as wsLexeme,
  ws1 as ws1Lexeme,
} from "../src/index.ts";
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
 * Abstract STLC grammar.  `ctx` is inherited context (TypeEnv, ValEnv, or
 * null).  `chain` threads synthesized values into inherited context.
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
    return or(
      this.sseq(this.atomType, this.arrow, this.type)
        .map(([dom, , cod]) => new TFun(dom, cod)),
      this.atomType,
    );
  }

  protected get arrow(): Parser<string> {
    return or(literal("→"), literal("->"));
  }

  @rule
  protected get atomType(): Parser<Type> {
    // `sseq` auto-inserts `ws` between terms in the parenthesised case.
    return or(
      this.typeIdent.map((name) => new TVar(name)),
      this.sseq(char("("), this.type, char(")"))
        .map(([, t]) => t),
    );
  }

  @rule
  protected get typeIdent(): Parser<string> {
    // Uppercase type identifiers — uses ident() with a custom first-char predicate.
    return identLexeme(
      (c) => c >= "A" && c <= "Z",
      (c) =>
        (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") ||
        (c >= "0" && c <= "9"),
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
    return or(
      this.lambdaProd(ctx),
      this.letProd(ctx),
      this.appProd(ctx),
    );
  }

  /** `λx:τ. body` — chain on τ to extend ctx before parsing body. */
  @rule
  protected lambdaProd(ctx: unknown): Parser<S["expr"]> {
    // `sseq` auto-inserts `ws` between each term.  A trailing `ws` is kept
    // explicit (via the wrapping `seq`) so the body parser sees leading
    // whitespace consumed before it starts — `sseq` only inserts ws
    // *between* terms, not after the last.
    return seq(
      this.sseq(
        this.lambdaHead, // 0  (within sseq tuple)
        this.ident, // 1  param
        char(":"), // 2
        this.type, // 3  τ
        char("."), // 4
      ),
      this.ws, // 1  (within seq tuple) — trailing ws before body
    ).chain(([[, param, , ty]]) => {
      // τ is now available; extend ctx and parse body.
      assert(typeof param === "string", "lambda param must be a string");
      assert(
        ty instanceof TVar || ty instanceof TFun,
        "lambda type must be a Type",
      );
      return this.exprProd(this.extendCtx(ctx, param, ty))
        .map((body) => this.lam(param, ty, body));
    }).map(([, result]) => result);
  }

  /** `let x:τ = def in body` — chain on τ then def's result to extend ctx for body. */
  @rule
  protected letProd(ctx: unknown): Parser<S["expr"]> {
    return seq(
      literal("let"), // 0
      this.ws1, // 1
      this.ident, // 2  name
      this.ws, // 3
      char(":"), // 4
      this.ws, // 5
      this.type, // 6  τ
      this.ws, // 7
      char("="), // 8
      this.ws, // 9
    ).chain(([, , name, , , , ty]) =>
      // Parse def under outer ctx, then consume "in", then parse body.
      this.exprProd(ctx)
        .map((def) => ({ name, ty, def }))
        .chain(({ name, ty, def }) =>
          seq(this.ws1, literal("in"), this.ws1)
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
    return or(
      seq(this.appProd(ctx), this.ws1, this.atomProd(ctx))
        .map(([fn, , arg]) => this.app(fn, arg)),
      this.atomProd(ctx) as Parser<S["expr"]>,
    );
  }

  @rule
  protected atomProd(ctx: unknown): Parser<S["atom"]> {
    // `sseq` auto-inserts `ws` between terms in the parenthesised case.
    return or(
      this.sseq(char("("), this.exprProd(ctx), char(")"))
        .map(([, e]) => this.paren(e)),
      literal("true").map(() => this.boolLit(true)),
      literal("false").map(() => this.boolLit(false)),
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
  //
  // `ident`, `digits`, `ws`, and `ws1` now come from the shared lexeme
  // library (`src/lexemes.ts`).  The reserved-word guard for `let`/`in`/
  // `true`/`false` is handled inline via `chain`.

  @rule
  protected get intLiteral(): Parser<number> {
    return digitsLexeme().map((s) => Number(s));
  }

  @rule
  protected get ident(): Parser<string> {
    return identLexeme().chain((name) => {
      if (
        name === "let" || name === "in" || name === "true" || name === "false"
      ) {
        return empty<string>();
      }
      return epsilon(name);
    }).map(([name]) => name);
  }

  protected get lambdaHead(): Parser<string> {
    return or(char("λ"), char("\\"));
  }

  @rule
  protected override get ws(): Parser<string> {
    return wsLexeme();
  }

  @rule
  protected get ws1(): Parser<string> {
    return ws1Lexeme();
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
 * One-pass type checker.  `Γ ⊢ e : τ` is a parameterised production.
 * Ill-typed terms produce an empty parse forest.
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
   * Application typing rule (App).  `@requires` enforces domain match;
   * on failure returns `undefined` (graceful).
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
  /** Variable typing rule (Var).  `@requires` checks binding in ctx. */
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

  /** Override `appProd` to type-check App via `chain`. */
  @rule
  protected override appProd(ctx: unknown): Parser<Type> {
    return or(
      this.appProd(ctx)
        .map((fnTy) => ({ fnTy }))
        .chain(({ fnTy }) =>
          seq(this.ws1, this.atomProd(ctx))
            .map(([, argTy]) => ({ fnTy, argTy }))
            .chain(({ fnTy, argTy }) => {
              if (!(fnTy instanceof TFun) || !typeEq(fnTy.dom, argTy)) {
                return empty<Type>();
              }
              return epsilon<Type>(fnTy.cod);
            })
            .map(([, result]) => result)
        )
        .map(([, result]) => result),
      this.atomProd(ctx) as Parser<Type>,
    );
  }
}

/* ======================================================================
 *  Concrete: evaluator  — `expr(ρ): Parser<Value>`  (tree-consuming grammar)
 * ====================================================================== */

/**
 * Children extractor for {@link Term} trees, used by {@link STLCEval}.
 * Returns a node's children in source order so {@link flattenTree} produces a
 * preorder stream that the tree-grammar matches positionally.
 */
function termChildren(node: unknown, tag: string): readonly unknown[] {
  switch (tag) {
    case "Var":
    case "BoolLit":
    case "IntLit":
      return [];
    case "Lam":
      return [(node as Lam).body];
    case "App":
      return [(node as App).fn, (node as App).arg];
    case "Let":
      return [(node as Let).def, (node as Let).body];
    default:
      return [];
  }
}

/**
 * Evaluator as a **tree-consuming grammar**.  Instead of extending `STLCAST`
 * and bolting on a recursive `evalTerm`, this is a grammar whose input is a
 * flattened {@link Term} tree and whose semantic actions are the evaluation
 * rules `ρ ⊢ e ⇓ v`.  Each production is a {@link TreeExp} matching a `Term`
 * node by class name; the inherited context `ρ` (`ValEnv`) is threaded via
 * the parameterised `@rule` method `evalExpr(env)`.
 *
 * The higher-order step — applying a closure to an argument — is a nested
 * tree-parse: `app` re-parses the closure's body subtree under the extended
 * environment.  This is a higher-order attribute: a semantic action that
 * produces a new tree fragment (the body, re-decorated under `ρ[x:=v]`)
 * which the engine evaluates on demand.  Per-pass memo isolation (Layer 0)
 * makes the nested re-entry safe.
 */
export class STLCEval extends Grammar<{ expr: Value }> {
  /** Parse source to AST (via `STLCAST`), then evaluate each AST as a tree. */
  parseWith(input: string, env: ValEnv): Set<Value> {
    const asts = [...new STLCAST().parse(input)] as Term[];
    const results = new Set<Value>();
    for (const ast of asts) {
      try {
        const toks = flattenTree(ast, termChildren);
        for (const v of this._parseTreeWith(toks, this.evalExpr(env))) {
          results.add(v);
        }
      } catch {
        // stuck term — skip
      }
    }
    return results;
  }

  override start(): Parser<Value> {
    return this.evalExpr(ValEnv.empty());
  }

  /** `ρ ⊢ e ⇓ v` — the evaluation judgment, parameterised by the value env. */
  @rule
  evalExpr(env: ValEnv): Parser<Value> {
    return or(
      this.evalVar(env),
      this.evalLam(env),
      this.evalApp(env),
      this.evalLet(env),
      this.evalBool(env),
      this.evalInt(env),
    );
  }

  /** Var: `ρ ⊢ x ⇓ ρ(x)`. */
  protected evalVar(env: ValEnv): Parser<Value> {
    return parserOf<Value>(
      new TreeExp("Var", [], (node: unknown) => {
        const v = env.lookup((node as Var).name);
        if (v === undefined) throw new Error(`unbound variable`);
        return v;
      }),
    );
  }

  /** Lam: `ρ ⊢ λx:τ. body ⇓ ⟨x, body, ρ⟩` (a closure capturing the env). */
  protected evalLam(env: ValEnv): Parser<Value> {
    // Match the Lam node only (do not evaluate the body — it is captured
    // unevaluated in the closure). The body subtree is left unconsumed in
    // the stream; it is evaluated on demand when the closure is applied.
    return parserOf<Value>(
      new TreeExp(
        "Lam",
        [],
        (node: unknown) =>
          new Closure(
            (node as Lam).param,
            (node as Lam).type,
            (node as Lam).body,
            env,
          ),
      ),
    );
  }

  /**
   * App: `ρ ⊢ e₁ e₂ ⇓ v` where `ρ ⊢ e₁ ⇓ ⟨x,body,ρ'⟩`, `ρ ⊢ e₂ ⇓ v₂`,
   * and `ρ' ⊢ body[x:=v₂] ⇓ v`.  The body re-evaluation is a **nested
   * tree-parse** over the closure's body subtree under `ρ'.extend(x, v₂)` —
   * the higher-order attribute.
   */
  protected evalApp(env: ValEnv): Parser<Value> {
    return parserOf<Value>(
      new TreeExp(
        "App",
        [this.evalExpr(env)._exp, this.evalExpr(env)._exp],
        (_node: unknown, [fnVal, argVal]: unknown[]) => {
          if (!(fnVal instanceof Closure)) {
            throw new Error(`cannot apply non-function`);
          }
          const bodyEnv = (fnVal.env as ValEnv).extend(
            fnVal.param,
            argVal as Value,
          );
          // Higher-order step: re-parse the closure body subtree under bodyEnv.
          const bodyToks = flattenTree(fnVal.body as Term, termChildren);
          const results = [
            ...this._parseTreeWith(bodyToks, this.evalExpr(bodyEnv)),
          ];
          if (results.length === 0) throw new Error(`stuck application`);
          return results[0]!;
        },
      ),
    );
  }

  /** Let: `ρ ⊢ let x:τ = def in body ⇓ v` where `ρ ⊢ def ⇓ v₁`, `ρ ⊢ body[x:=v₁] ⇓ v`. */
  protected evalLet(env: ValEnv): Parser<Value> {
    return parserOf<Value>(
      new TreeExp(
        "Let",
        [this.evalExpr(env)._exp],
        (node: unknown, [defVal]: unknown[]) => {
          // def evaluated under ρ; body evaluated under ρ[x:=v₁] via a
          // nested tree-parse (the higher-order step, as in `app`).
          const bodyEnv = env.extend((node as Let).name, defVal as Value);
          const bodyToks = flattenTree((node as Let).body, termChildren);
          const results = [
            ...this._parseTreeWith(bodyToks, this.evalExpr(bodyEnv)),
          ];
          if (results.length === 0) throw new Error(`stuck let`);
          return results[0]!;
        },
      ),
    );
  }

  protected evalBool(_env: ValEnv): Parser<Value> {
    return parserOf<Value>(
      new TreeExp("BoolLit", [], (node: unknown) => (node as BoolLit).value),
    );
  }

  protected evalInt(_env: ValEnv): Parser<Value> {
    return parserOf<Value>(
      new TreeExp("IntLit", [], (node: unknown) => (node as IntLit).value),
    );
  }
}

/* ======================================================================
 *  Concrete: proof-bearing type checker  — `expr(Γ): Parser<TypedTerm>`
 * ====================================================================== */

/** Proof-bearing type checker — returns `TypedTerm` carrying derived types and sub-derivations. */
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
    return or(
      this.appProd(ctx)
        .map((fnTT) => ({ fnTT }))
        .chain(({ fnTT }) =>
          seq(this.ws1, this.atomProd(ctx))
            .map(([, argTT]) => ({ fnTT, argTT }))
            .chain(({ fnTT, argTT }) => {
              if (
                !(fnTT.type instanceof TFun) ||
                !typeEq(fnTT.type.dom, argTT.type)
              ) {
                return empty<TypedTerm>();
              }
              return epsilon<TypedTerm>(
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
