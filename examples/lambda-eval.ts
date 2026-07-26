/**
 * Untyped lambda calculus — AST builder + call-by-value evaluator.
 * Multi-pass: grammar builds AST, then `evalTerm` evaluates it.
 */

import { Grammar, rule } from "../src/index.ts";
import {
  char,
  empty,
  epsilon,
  ident as identLexeme,
  literal,
  or,
  seq,
  ws as wsLexeme,
  ws1 as ws1Lexeme,
} from "../src/index.ts";
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
  constructor(
    readonly name: string,
    readonly def: UTTerm,
    readonly body: UTTerm,
  ) {
    super();
  }
  override print(): string {
    return `(let ${this.name} = ${this.def.print()} in ${this.body.print()})`;
  }
}

/* ─── Values ─────────────────────────────────────────────────────────── */

export type UTValue = UTClosure | number | boolean;

export class UTClosure {
  constructor(
    readonly param: string,
    readonly body: UTTerm,
    readonly env: UTValEnv,
  ) {}
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
  protected abstract let_(
    name: string,
    def: S["expr"],
    body: S["expr"],
  ): S["expr"];
  protected abstract varRef(name: string): S["atom"];
  protected abstract paren(e: S["expr"]): S["atom"];

  override start(): Parser<S["expr"]> {
    return this.exprProd;
  }

  @rule
  get exprProd(): Parser<S["expr"]> {
    return or(this.letProd, this.lambdaProd, this.appProd);
  }

  @rule
  protected get letProd(): Parser<S["expr"]> {
    // `ws1` is used explicitly where at least one space is required (after
    // keywords, before the body); `ws` (zero-or-more) suffices elsewhere.
    return seq(
      literal("let"),
      this.ws1,
      this.ident,
      this.ws,
      char("="),
      this.ws,
      this.exprProd,
      this.ws1,
      literal("in"),
      this.ws1,
      this.exprProd,
    ).map(([, , name, , , , def, , , , body]) => this.let_(name, def, body));
  }

  @rule
  protected get lambdaProd(): Parser<S["expr"]> {
    // `sseq` auto-inserts `ws` (zero-or-more) between terms — no manual
    // `this.ws` threading needed between the head, param, dot, and body.
    return this.sseq(
      this.lambdaHead,
      this.ident,
      char("."),
      this.exprProd,
    ).map(([, param, , body]) => this.lam(param, body));
  }

  @rule
  protected get appProd(): Parser<S["expr"]> {
    return or(
      seq(this.appProd, this.ws1, this.atomProd)
        .map(([fn, , arg]) => this.app(fn, arg)),
      this.atomProd as Parser<S["expr"]>,
    );
  }

  @rule
  protected get atomProd(): Parser<S["atom"]> {
    // `sseq` auto-inserts `ws` between terms — no manual `this.ws` threading.
    return or(
      this.sseq(char("("), this.exprProd, char(")"))
        .map(([, e]) => this.paren(e)),
      this.ident.map((name) => this.varRef(name)),
    );
  }

  /* ── lexemes ─────────────────────────────────────────────────────── */
  //
  // `ident`, `ws`, and `ws1` come from the shared lexeme library
  // (`src/lexemes.ts`). The reserved-word guard for `let`/`in` is handled
  // inline via `.chain()` below.

  @rule
  protected get ident(): Parser<string> {
    return identLexeme().chain((name) => {
      if (name === "let" || name === "in") return empty<string>();
      return epsilon(name);
    }).map(([, name]) => name);
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

/** Call-by-value evaluation judgment `ρ ⊢ e ⇓ v` as a syntax-directed recursive function. */
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
    if (!(fn instanceof UTClosure)) {
      throw new Error(`cannot apply non-function`);
    }
    return lambdaEval(fn.body, fn.env.extend(fn.param, arg));
  }
  if (term instanceof UTLet) {
    const defVal = lambdaEval(term.def, env);
    return lambdaEval(term.body, env.extend(term.name, defVal));
  }
  throw new Error(`unknown term`);
}

/** Multi-pass evaluator: parses to AST via `super`, then evaluates with `lambdaEval`. */
export class LambdaEval extends LambdaAST {
  parseWith(input: string, env: UTValEnv): Set<UTValue> {
    const asts = [...this._parseWith(input, this.start())];
    const results = new Set<UTValue>();
    for (const ast of asts) {
      try {
        results.add(lambdaEval(ast, env));
      } catch {
        // stuck term — skip
      }
    }
    return results;
  }
}
