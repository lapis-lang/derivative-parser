/**
 * Untyped Lambda Calculus — AST builder + call-by-value evaluator.
 *
 * A bridge from the old `lambda.ts` (syntax-only) to the semantics-as-grammar
 * pattern.  Uses the shape-typed abstract-grammar pattern from `arith.ts`:
 * one abstract grammar, two interpretations (AST builder + evaluator).
 *
 * The evaluator is **multi-pass** (Pattern 1): the grammar builds the AST,
 * then `evalTerm` evaluates it.  This is honest — one-pass evaluation of
 * lambda abstractions requires deferring the body (see `stlc.ts` for
 * discussion).
 *
 * Grammar (informal):
 *
 *   expr  →  let id = expr in expr       (let binding)
 *         |  λ id . expr                  (abstraction, λ or \)
 *         |  app
 *   app   →  app atom                     (left-associative application)
 *         |  atom
 *   atom  →  id | ( expr )
 *
 * Usage:
 *   const g = new LambdaAST();
 *   const [ast] = g.parse("let id = \\x.x in id id 7");
 *   const v = lambdaEval(ast, ValEnv.empty());   // 7
 */

import { Grammar, rule } from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ─── AST ────────────────────────────────────────────────────────────── */

export abstract class UTTerm {
  abstract print(): string;
}

export class UTVar extends UTTerm {
  constructor(readonly name: string) {
    super();
  }
  override print(): string {
    return this.name;
  }
}

export class UTLam extends UTTerm {
  constructor(readonly param: string, readonly body: UTTerm) {
    super();
  }
  override print(): string {
    return `(λ${this.param}.${this.body.print()})`;
  }
}

export class UTApp extends UTTerm {
  constructor(readonly fn: UTTerm, readonly arg: UTTerm) {
    super();
  }
  override print(): string {
    return `(${this.fn.print()} ${this.arg.print()})`;
  }
}

export class UTLet extends UTTerm {
  constructor(readonly name: string, readonly def: UTTerm, readonly body: UTTerm) {
    super();
  }
  override print(): string {
    return `(let ${this.name} = ${this.def.print()} in ${this.body.print()})`;
  }
}

/* ─── Values ─────────────────────────────────────────────────────────── */

export type UTValue = UTClosure | number | boolean;

export class UTClosure {
  constructor(readonly param: string, readonly body: UTTerm, readonly env: UTValEnv) {}
}

/* ─── Environments ───────────────────────────────────────────────────── */

export class UTValEnv {
  private constructor(
    readonly name: string | null,
    readonly value: UTValue | null,
    readonly parent: UTValEnv | null,
  ) {}

  static empty(): UTValEnv {
    return new UTValEnv(null, null, null);
  }

  extend(name: string, value: UTValue): UTValEnv {
    return new UTValEnv(name, value, this);
  }

  lookup(name: string): UTValue | undefined {
    if (this.name === name) return this.value ?? undefined;
    return this.parent?.lookup(name);
  }
}

/* ─── Shape & abstract grammar ───────────────────────────────────────── */

export interface LambdaShape {
  [k: string]: unknown;
  expr: unknown;
  atom: unknown;
}

export abstract class AbstractLambda<S extends LambdaShape> extends Grammar<S> {
  protected abstract lam(param: string, body: S["expr"]): S["expr"];
  protected abstract app(fn: S["atom"], arg: S["atom"]): S["expr"];
  protected abstract let_(name: string, def: S["expr"], body: S["expr"]): S["expr"];
  protected abstract varRef(name: string): S["atom"];
  protected abstract paren(e: S["expr"]): S["atom"];

  override start(): Parser<S["expr"]> {
    return this.exprProd;
  }

  @rule
  get exprProd(): Parser<S["expr"]> {
    return this.or(this.letProd, this.lambdaProd, this.appProd);
  }

  @rule
  protected get letProd(): Parser<S["expr"]> {
    return this.seq(
      this.kw("let"), this.ws1, this.ident, this.ws, this.char("="), this.ws,
      this.exprProd, this.ws1, this.kw("in"), this.ws1, this.exprProd,
    ).map(([, , name, , , , def, , , , body]) => this.let_(name, def, body));
  }

  @rule
  protected get lambdaProd(): Parser<S["expr"]> {
    return this.seq(
      this.lambdaHead, this.ident, this.ws, this.char("."), this.ws, this.exprProd,
    ).map(([, param, , , , body]) => this.lam(param, body));
  }

  @rule
  protected get appProd(): Parser<S["expr"]> {
    return this.or(
      this.seq(this.appProd, this.ws1, this.atomProd)
        .map(([fn, , arg]) => this.app(fn, arg)),
      this.atomProd as Parser<S["expr"]>,
    );
  }

  @rule
  protected get atomProd(): Parser<S["atom"]> {
    return this.or(
      this.seq(this.char("("), this.ws, this.exprProd, this.ws, this.char(")"))
        .map(([, , e]) => this.paren(e)),
      this.ident.map((name) => this.varRef(name)),
    );
  }

  /* ── lexemes ─────────────────────────────────────────────────────── */

  @rule
  protected get ident(): Parser<string> {
    return this.seq(this.identFirst, this.identRest)
      .map(([h, t]) => h + t)
      .chain((name) => {
        if (name === "let" || name === "in") {
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

/* ─── Concrete: AST builder ──────────────────────────────────────────── */

export class LambdaAST extends AbstractLambda<{ expr: UTTerm; atom: UTTerm }> {
  protected lam(param: string, body: UTTerm): UTTerm {
    return new UTLam(param, body);
  }
  protected app(fn: UTTerm, arg: UTTerm): UTTerm {
    return new UTApp(fn, arg);
  }
  protected let_(name: string, def: UTTerm, body: UTTerm): UTTerm {
    return new UTLet(name, def, body);
  }
  protected varRef(name: string): UTTerm {
    return new UTVar(name);
  }
  protected paren(e: UTTerm): UTTerm {
    return e;
  }
}

/* ─── Evaluator (multi-pass) ─────────────────────────────────────────── */

/**
 * Call-by-value evaluator.  The evaluation judgment `ρ ⊢ e ⇓ v` as a
 * syntax-directed recursive function over the AST.
 */
export function lambdaEval(term: UTTerm, env: UTValEnv): UTValue {
  if (term instanceof UTVar) {
    const v = env.lookup(term.name);
    if (v === undefined) throw new Error(`unbound variable: ${term.name}`);
    return v;
  }
  if (term instanceof UTLam) {
    return new UTClosure(term.param, term.body, env);
  }
  if (term instanceof UTApp) {
    const fn = lambdaEval(term.fn, env);
    const arg = lambdaEval(term.arg, env);
    if (!(fn instanceof UTClosure)) throw new Error(`cannot apply non-function`);
    return lambdaEval(fn.body, fn.env.extend(fn.param, arg));
  }
  if (term instanceof UTLet) {
    const defVal = lambdaEval(term.def, env);
    return lambdaEval(term.body, env.extend(term.name, defVal));
  }
  throw new Error(`unknown term`);
}