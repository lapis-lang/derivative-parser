/**
 * Shape-typed arithmetic grammar — Bracha "executable grammar" pattern.
 * Abstract grammar declares structure; concrete subclasses supply semantics
 * (evaluator, AST builder, tracing). See the README for the full discussion.
 */

import { Grammar, rule } from "../src/index.ts";
import { char, digits, or, seq } from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ─── Shape ──────────────────────────────────────────────────────────── */

export interface MathShape {
  [k: string]: unknown;
  expr: unknown;
  term: unknown;
  factor: unknown;
}

/* ─── Abstract grammar ───────────────────────────────────────────────── */

export abstract class AbstractMath<S extends MathShape> extends Grammar<S> {
  /* semantic actions — subclasses choose representation */
  protected abstract add(l: S["expr"], r: S["term"]): S["expr"];
  protected abstract mul(l: S["term"], r: S["factor"]): S["term"];
  protected abstract num(s: string): S["factor"];
  protected abstract paren(e: S["expr"]): S["factor"];

  /* productions */
  override start(): Parser<S["expr"]> {
    return this.expr;
  }

  @rule
  get expr(): Parser<S["expr"]> {
    return or(
      seq(this.expr, char("+"), this.term)
        .map(([l, , r]) => this.add(l, r)),
      this.term as Parser<S["expr"]>,
    );
  }

  @rule
  get term(): Parser<S["term"]> {
    return or(
      seq(this.term, char("*"), this.factor)
        .map(([l, , r]) => this.mul(l, r)),
      this.factor as Parser<S["term"]>,
    );
  }

  @rule
  get factor(): Parser<S["factor"]> {
    return or(
      seq(char("("), this.expr, char(")"))
        .map(([, e]) => this.paren(e)),
      digits().map((s) => this.num(s)),
    );
  }

  // `digits` and `digit` are now imported from the shared lexeme library
  // — no need to hand-roll the repetition here.
}

/* ─── Concrete: evaluator (numbers) ──────────────────────────────────── */

export class MathEval
  extends AbstractMath<{ expr: number; term: number; factor: number }> {
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
}

/* ─── Concrete: AST builder ──────────────────────────────────────────── */

export type Exp =
  | { tag: "num"; value: number }
  | { tag: "add"; left: Exp; right: Exp }
  | { tag: "mul"; left: Exp; right: Exp };

export class MathAST
  extends AbstractMath<{ expr: Exp; term: Exp; factor: Exp }> {
  protected add(l: Exp, r: Exp): Exp {
    return { tag: "add", left: l, right: r };
  }
  protected mul(l: Exp, r: Exp): Exp {
    return { tag: "mul", left: l, right: r };
  }
  protected num(s: string): Exp {
    return { tag: "num", value: Number(s) };
  }
  protected paren(e: Exp): Exp {
    return e;
  }
}

/* ─── Concrete: tracing evaluator (Bracha-style production override) ── */

/** Bracha-style production override: wraps `super.expr` with a `.map(...)` to trace each parse. */
export class MathTraced extends MathEval {
  readonly trace: number[] = [];
  @rule
  override get expr(): Parser<number> {
    return super.expr.map((n) => {
      this.trace.push(n);
      return n;
    });
  }
}
