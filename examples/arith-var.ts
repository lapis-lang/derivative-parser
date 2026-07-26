/**
 * Arithmetic with variables — parameterised productions threading an
 * environment as inherited attribute. Two interpretations: evaluator and
 * AST builder. See the README for the full discussion.
 */

import { Grammar, rule } from "../src/index.ts";
import {
  char,
  digits as digitsLexeme,
  ident as identLexeme,
  or,
  ws as wsLexeme,
} from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ─── Environment ────────────────────────────────────────────────────── */

/** Persistent environment mapping names to values. */
export class Env {
  constructor(
    readonly name: string | null,
    readonly value: unknown,
    readonly parent: Env | null,
  ) {}

  static empty(): Env {
    return new Env(null, undefined, null);
  }

  extend(name: string, value: unknown): Env {
    return new Env(name, value, this);
  }

  lookup(name: string): unknown {
    if (this.name === name) return this.value;
    return this.parent?.lookup(name);
  }
}

/* ─── Shape ──────────────────────────────────────────────────────────── */

export interface ArithVarShape {
  [k: string]: unknown;
  expr: unknown;
  term: unknown;
  factor: unknown;
}

/* ─── Abstract grammar ───────────────────────────────────────────────── */

export abstract class AbstractArithVar<S extends ArithVarShape>
  extends Grammar<S> {
  /* semantic actions — subclasses choose representation */
  protected abstract add(l: S["expr"], r: S["term"]): S["expr"];
  protected abstract mul(l: S["term"], r: S["factor"]): S["term"];
  protected abstract num(s: string): S["factor"];
  protected abstract paren(e: S["expr"]): S["factor"];
  /** Reference to a bound identifier, looked up in `env`. */
  protected abstract ref(name: string, env: Env): S["factor"];

  /** Parse `input` under environment `env` (inherited context). */
  parseWith(input: string, env: Env): Set<S["expr"]> {
    return this._parseWith(input, this.expr(env));
  }

  override parse(input: string): Set<S["expr"]> {
    return this.parseWith(input, Env.empty());
  }

  /* ── expr (parameterised by env) ─────────────────────────────────── */

  @rule
  expr(env: Env): Parser<S["expr"]> {
    return this.addProd(env);
  }

  /** Production: `add → add + mul | mul` (left-recursive, parameterised). */
  @rule
  protected addProd(env: Env): Parser<S["expr"]> {
    return or(
      this.sseq(this.addProd(env), char("+"), this.mulProd(env))
        .map(([l, , r]) => this.add(l, r)),
      this.mulProd(env) as Parser<S["expr"]>,
    );
  }

  /** Production: `mul → mul * atom | atom` (left-recursive, parameterised). */
  @rule
  protected mulProd(env: Env): Parser<S["term"]> {
    return or(
      this.sseq(this.mulProd(env), char("*"), this.atomProd(env))
        .map(([l, , r]) => this.mul(l, r)),
      this.atomProd(env) as Parser<S["term"]>,
    );
  }

  /** Production: `atom → ( expr ) | id | digits` (parameterised). */
  @rule
  protected atomProd(env: Env): Parser<S["factor"]> {
    // `sseq` auto-inserts `ws` between terms — no manual `this.ws` threading.
    return or(
      this.sseq(char("("), this.expr(env), char(")"))
        .map(([, e]) => this.paren(e)),
      this.ident.map((name) => this.ref(name, env)),
      digitsLexeme().map((s) => this.num(s)),
    );
  }

  /* ── lexemes ─────────────────────────────────────────────────────── */
  //
  // `ident`, `digits`, and `ws` now come from the shared lexeme library
  // (`src/lexemes.ts`) — no more hand-rolled repetition in every grammar.

  @rule
  protected get ident(): Parser<string> {
    return identLexeme();
  }

  @rule
  protected override get ws(): Parser<string> {
    return wsLexeme();
  }
}

/* ─── Concrete: evaluator (numbers) ─────────────────────────────────── */

export class ArithVarEval
  extends AbstractArithVar<{ expr: number; term: number; factor: number }> {
  override start(): Parser<number> {
    return this.expr(Env.empty());
  }

  protected add(l: number, r: number): number {
    return l + r;
  }
  protected mul(l: number, r: number): number {
    return l * r;
  }
  protected num(s: string): number {
    return Number(s);
  }
  protected paren(e: number): number {
    return e;
  }
  protected ref(name: string, env: Env): number {
    const v = env.lookup(name);
    if (typeof v !== "number") {
      throw new Error(`unbound variable: ${name}`);
    }
    return v;
  }
}

/* ─── Concrete: AST builder ─────────────────────────────────────────── */

export type ArithVarExp =
  | { tag: "num"; value: number }
  | { tag: "var"; name: string }
  | { tag: "add"; left: ArithVarExp; right: ArithVarExp }
  | { tag: "mul"; left: ArithVarExp; right: ArithVarExp };

export class ArithVarAST extends AbstractArithVar<
  { expr: ArithVarExp; term: ArithVarExp; factor: ArithVarExp }
> {
  override start(): Parser<ArithVarExp> {
    return this.expr(Env.empty());
  }

  protected add(l: ArithVarExp, r: ArithVarExp): ArithVarExp {
    return { tag: "add", left: l, right: r };
  }
  protected mul(l: ArithVarExp, r: ArithVarExp): ArithVarExp {
    return { tag: "mul", left: l, right: r };
  }
  protected num(s: string): ArithVarExp {
    return { tag: "num", value: Number(s) };
  }
  protected paren(e: ArithVarExp): ArithVarExp {
    return e;
  }
  /** AST ignores the env — the same parameterised grammar, different algebra. */
  protected ref(name: string, _env: Env): ArithVarExp {
    return { tag: "var", name };
  }
}
