/**
 * Lambda Calculus with let-expressions.
 *
 * Grammar (informal):
 *
 *   expr  →  let id = expr in expr       (let binding)
 *         |  λ id . expr                  (abstraction, λ or \)
 *         |  app
 *
 *   app   →  app atom                     (left-associative application)
 *         |  atom
 *
 *   atom  →  id
 *         |  ( expr )
 *
 *   id    →  [a-z][a-z0-9_]*
 *
 * Abstract Syntax Tree node types:
 *   Var(name)          — variable reference
 *   Lam(param, body)   — λ-abstraction
 *   App(fn, arg)       — application
 *   Let(name, def, body) — let x = def in body
 *
 * Example parses:
 *   \x.x                       → Lam('x', Var('x'))
 *   let id = \x.x in id id     → Let('id', Lam(...), App(Var('id'), Var('id')))
 *   (\x.\y.x) a b              → App(App(Lam('x', Lam('y', Var('x'))), Var('a')), Var('b'))
 *
 * Usage:
 *   const g = new LambdaGrammar();
 *   const [ast] = g.parse('\\x.x');
 */

import { Grammar, rule } from '../src/index.mjs';
import type { Parser } from '../src/index.mjs';

/* ─── AST ────────────────────────────────────────────────────────────── */

/** Base class for all lambda-calculus terms. */
export abstract class Term {
    /** Pretty-print this term back to source form. */
    abstract print(): string;
}

/** Variable reference: `x` */
export class Var extends Term {
    constructor(readonly name: string) { super(); }
    override print(): string { return this.name; }
}

/** Lambda abstraction: `λparam.body` */
export class Lam extends Term {
    constructor(readonly param: string, readonly body: Term) { super(); }
    override print(): string { return `(λ${this.param}.${this.body.print()})`; }
}

/** Function application: `fn arg` */
export class App extends Term {
    constructor(readonly fn: Term, readonly arg: Term) { super(); }
    override print(): string { return `(${this.fn.print()} ${this.arg.print()})`; }
}

/** Let-binding: `let name = def in body` */
export class Let extends Term {
    constructor(readonly name: string, readonly def: Term, readonly body: Term) { super(); }
    override print(): string {
        return `(let ${this.name} = ${this.def.print()} in ${this.body.print()})`;
    }
}

/* ─── Grammar ────────────────────────────────────────────────────────── */

export class LambdaGrammar extends Grammar<{ expr: Term }> {
    override start(): Parser<Term> { return this.expr; }

    /* ── expr ────────────────────────────────────────────────────────── */

    @rule get expr(): Parser<Term> {
        return this.or(
            this.letExpr,
            this.lambda,
            this.app as Parser<Term>,
        );
    }

    @rule protected get letExpr(): Parser<Term> {
        return this.seq(
            this.kw('let'), this.ws1,
            this.ident, this.ws,
            this.char('='), this.ws,
            this.expr, this.ws1,
            this.kw('in'), this.ws1,
            this.expr,
        ).map(([, , name, , , , def, , , , body]) => new Let(name, def, body));
    }

    @rule protected get lambda(): Parser<Term> {
        return this.seq(
            this.lambdaHead,
            this.ident, this.ws,
            this.char('.'), this.ws,
            this.expr,
        ).map(([, param, , , , body]) => new Lam(param, body));
    }

    /** `λ` (U+03BB) or `\` as the lambda head character. */
    protected get lambdaHead(): Parser<string> {
        return this.or(this.char('λ'), this.char('\\'));
    }

    /* ── application (left-associative) ─────────────────────────────── */

    @rule protected get app(): Parser<Term> {
        return this.or(
            this.seq(this.app, this.ws1, this.atom).map(([fn, , arg]) => new App(fn, arg)),
            this.atom,
        );
    }

    /* ── atom ────────────────────────────────────────────────────────── */

    @rule protected get atom(): Parser<Term> {
        return this.or(
            this.seq(this.char('('), this.ws, this.expr, this.ws, this.char(')'))
                .map(([, , e]) => e),
            this.ident.map((name) => new Var(name)),
        );
    }

    /* ── identifiers & keywords ──────────────────────────────────────── */

    /**
     * Identifier: starts with a lowercase letter, followed by letters,
     * digits, or underscores. Keywords (`let`, `in`) are excluded.
     */
    @rule protected get ident(): Parser<string> {
        return this.seq(this.identFirst, this.identRest)
            .map(([h, t]) => h + t)
            .map((name) => {
                if (name === 'let' || name === 'in')
                    throw new Error(`"${name}" is a reserved keyword`);
                return name;
            });
    }

    protected get identFirst(): Parser<string> {
        return this.pred((c) => c >= 'a' && c <= 'z', '<letter>');
    }

    @rule protected get identRest(): Parser<string> {
        return this.or(
            this.seq(this.identChar, this.identRest).map(([c, cs]) => c + cs),
            this.epsilon(''),
        );
    }

    protected get identChar(): Parser<string> {
        return this.pred(
            (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_',
            '<id-char>',
        );
    }

    /** Match a fixed keyword string. */
    protected kw(word: string): Parser<string> {
        return this.literal(word);
    }

    /* ── whitespace ──────────────────────────────────────────────────── */

    protected get wsChar(): Parser<string> {
        return this.pred((c) => c === ' ' || c === '\t' || c === '\n' || c === '\r', '<ws>');
    }

    /** Zero or more whitespace characters. */
    @rule protected get ws(): Parser<string> {
        return this.or(
            this.seq(this.wsChar, this.ws).map(([c, cs]) => c + cs),
            this.epsilon(''),
        );
    }

    /** One or more whitespace characters. */
    @rule protected get ws1(): Parser<string> {
        return this.seq(this.wsChar, this.ws).map(([c, cs]) => c + cs);
    }
}
