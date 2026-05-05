/**
 * Shape-typed arithmetic grammar — Magi/Bracha "executable grammar" pattern.
 *
 *   `AbstractMath<S>` declares the structure of `expr`, `term`, `factor`
 *   along with abstract semantic-action methods (`add`, `mul`, `num`).
 *   The `S` shape parameter maps each production name to its parse-tree type.
 *
 * Concrete subclasses pick the shape and supply the semantics:
 *   • `MathEval` ⇒ everything is `number`     — evaluator.
 *   • `MathAST`  ⇒ everything is an `Exp`     — AST builder.
 *
 * `MathTraced` is a third subclass demonstrating Bracha-style **production
 * override**: it overrides `expr` to wrap `super.expr` with a `.map(...)`,
 * so every successful expr parse is recorded into a trace.
 *
 * Productions use the `@rule` decorator (TS5 stage-3): `@rule get expr() {…}`
 * is referenced as `this.expr`, and the decorator memoises a `Delayed` parser
 * per `(instance, getter)` so recursion threads through a single shared node.
 */

import { Grammar, rule } from '../src/index.mjs';
import type { Parser } from '../src/index.mjs';

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
    protected abstract add(l: S['expr'], r: S['term']): S['expr'];
    protected abstract mul(l: S['term'], r: S['factor']): S['term'];
    protected abstract num(s: string): S['factor'];
    protected abstract paren(e: S['expr']): S['factor'];

    /* productions */
    override start(): Parser<S['expr']> { return this.expr; }

    @rule get expr(): Parser<S['expr']> {
        return this.or(
            this.seq(this.expr, this.char('+'), this.term)
                .map(([l, , r]) => this.add(l, r)),
            this.term as Parser<S['expr']>,
        );
    }

    @rule get term(): Parser<S['term']> {
        return this.or(
            this.seq(this.term, this.char('*'), this.factor)
                .map(([l, , r]) => this.mul(l, r)),
            this.factor as Parser<S['term']>,
        );
    }

    @rule get factor(): Parser<S['factor']> {
        return this.or(
            this.seq(this.char('('), this.expr, this.char(')'))
                .map(([, e]) => this.paren(e)),
            this.digits.map((s) => this.num(s)),
        );
    }

    /** One or more decimal digits, joined into a string. */
    @rule protected get digits(): Parser<string> {
        return this.or(
            this.seq(this.digit, this.digits).map(([d, ds]) => d + ds),
            this.digit,
        );
    }

    protected get digit(): Parser<string> {
        return this.pred((c) => c >= '0' && c <= '9', '<digit>');
    }
}

/* ─── Concrete: evaluator (numbers) ──────────────────────────────────── */

export class MathEval extends AbstractMath<{ expr: number; term: number; factor: number }> {
    protected add(l: number, r: number): number { return l + r; }
    protected mul(l: number, r: number): number { return l * r; }
    protected num(s: string): number { return Number(s); }
    protected paren(e: number): number { return e; }
}

/* ─── Concrete: AST builder ──────────────────────────────────────────── */

export type Exp =
    | { tag: 'num'; value: number }
    | { tag: 'add'; left: Exp; right: Exp }
    | { tag: 'mul'; left: Exp; right: Exp };

export class MathAST extends AbstractMath<{ expr: Exp; term: Exp; factor: Exp }> {
    protected add(l: Exp, r: Exp): Exp { return { tag: 'add', left: l, right: r }; }
    protected mul(l: Exp, r: Exp): Exp { return { tag: 'mul', left: l, right: r }; }
    protected num(s: string): Exp { return { tag: 'num', value: Number(s) }; }
    protected paren(e: Exp): Exp { return e; }
}

/* ─── Concrete: tracing evaluator (Bracha-style production override) ── */

/**
 * Demonstrates the Bracha "executable grammar" hallmark: a subclass wraps
 * a parent production by accessing `super.expr.map(...)`. Every successful
 * `expr` parse appends to the live `trace` array — *without* re-implementing
 * the parent's algebra. The override gets its own decorator slot, so it
 * still memoises correctly across recursive references to `this.expr`.
 */
export class MathTraced extends MathEval {
    readonly trace: number[] = [];
    @rule override get expr(): Parser<number> {
        return super.expr.map((n) => {
            this.trace.push(n);
            return n;
        });
    }
}
