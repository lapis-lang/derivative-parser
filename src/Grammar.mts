/**
 * `Grammar` — abstract base for executable, OO grammars.
 *
 * Subclass and define productions as `@rule` getters (or methods) returning
 * `Parser<...>`. Recursion — including left-recursion — is handled by lazy
 * `DelayedExp` nodes and the PwZ zipper engine.
 *
 *   class BalancedParens extends Grammar<{ s: string }> {
 *     start() { return this.s; }
 *     @rule get s(): Parser<string> {
 *       return this.or(
 *         this.seq(this.char('('), this.s, this.char(')'), this.s)
 *             .map(() => 'ok'),
 *         this.epsilon('ok'),
 *       );
 *     }
 *   }
 *
 * The optional shape parameter `S` maps production names to their parse-tree
 * types — see `examples/` for the Magi/Bracha-style abstract grammar +
 * concrete subclass pattern.
 */

import { Parser } from './Parser.mjs';
import {
    AltExp,
    DelayedExp,
    EpsilonExp,
    EmptyExp,
    PredTokExp,
    SeqExp,
    TokExp,
    ZipperDriver,
    type Tok,
} from './zipper/zipper.mjs';
import { treeKey } from './parser/fix.mjs';

/** A shape interface maps production names to their parse-tree types. */
export type GrammarShape = Record<string, unknown>;

export abstract class Grammar<S extends GrammarShape = GrammarShape> {
    /**
     * Per-instance cache so `rule(body)` and `@rule get foo()` return the
     * same `Parser` (backed by a `DelayedExp`) per key.
     */
    private readonly _ruleCache = new WeakMap<object, Parser<unknown>>();

    /**
     * Per-instance, per-method, per-arg-key cache for parameterised
     * `@rule` methods (Pratt-style productions, etc.).
     */
    private readonly _paramRuleCache = new WeakMap<object, Map<string, Parser<unknown>>>();

    /** Internal: shared lookup for `@rule` decorator wrappers (getter form). */
    _ruleSlot<T>(key: object, build: () => Parser<T>): Parser<T> {
        let hit = this._ruleCache.get(key);
        if (!hit) {
            hit = new Parser<unknown>(new DelayedExp(() => build()._exp));
            this._ruleCache.set(key, hit);
        }
        return hit as Parser<T>;
    }

    /** Internal: shared lookup for `@rule` decorator wrappers (method form). */
    _paramRuleSlot<T>(key: object, argKey: string, build: () => Parser<T>): Parser<T> {
        let inner = this._paramRuleCache.get(key);
        if (!inner) { inner = new Map(); this._paramRuleCache.set(key, inner); }
        let hit = inner.get(argKey);
        if (!hit) {
            hit = new Parser<unknown>(new DelayedExp(() => build()._exp));
            inner.set(argKey, hit);
        }
        return hit as Parser<T>;
    }

    /** The grammar's entry production. Subclasses must override. */
    abstract start(): Parser<S[keyof S]>;

    /* ---- combinator helpers ---- */

    /** A literal character. */
    protected char(c: string): Parser<string> {
        return new Parser<string>(new TokExp({ tag: c, sym: c }));
    }

    /** A character matching a predicate. */
    protected pred(p: (c: string) => boolean, label = '<pred>'): Parser<string> {
        return new Parser<string>(new PredTokExp(p, label));
    }

    /** A literal multi-character string, returning the string itself. */
    protected literal(s: string): Parser<string> {
        if (s.length === 0) return this.epsilon('');
        const chars = [...s];
        const seq = new SeqExp(
            `_lit_${s}`,
            chars.map((c) => new TokExp({ tag: c, sym: c })),
            () => s,
        );
        return new Parser<string>(seq);
    }

    /** ∅ — failing parser. */
    protected empty(): Parser<never> { return new Parser<never>(new EmptyExp()); }

    /** ε — always succeeds, contributing `value` to the parse forest. */
    protected epsilon<T>(value: T): Parser<T> {
        return new Parser<T>(new EpsilonExp<T>(value));
    }

    /** Variadic alternation. */
    protected or<T>(...parsers: Parser<T>[]): Parser<T> {
        if (parsers.length === 0) return this.empty() as unknown as Parser<T>;
        if (parsers.length === 1) return parsers[0]!;
        return new Parser<T>(new AltExp(parsers.map((p) => p._exp)));
    }

    /** Variadic sequence; returns a tuple of children's parse trees. */
    protected seq<Ts extends readonly unknown[]>(
        ...parsers: { [K in keyof Ts]: Parser<Ts[K]> }
    ): Parser<Ts> {
        if (parsers.length === 0) {
            return this.epsilon([] as unknown as Ts);
        }
        const exps = (parsers as Parser<unknown>[]).map((p) => p._exp);
        return new Parser<Ts>(new SeqExp('_seq', exps, (vs) => vs as unknown as Ts));
    }

    /**
     * Wrap a production body in a memoised lazy reference (legacy thunk form).
     * Prefer the `@rule` decorator for new code.
     */
    protected rule<T>(body: () => Parser<T>): Parser<T> {
        return this._ruleSlot(body, body);
    }

    /* ---- driver ---- */

    private _toTokens(input: Iterable<string>): Tok[] {
        const tokens: Tok[] = [];
        for (const c of input) tokens.push({ tag: c, sym: c });
        return tokens;
    }

    /**
     * Parse the input and return the set of all parse trees (the parse forest).
     * Empty set ⇒ rejection.
     */
    parse(input: Iterable<string>): Set<S[keyof S]> {
        return new ZipperDriver().parse<S[keyof S]>(
            this.start()._exp,
            this._toTokens(input),
        );
    }

    /** Pure recognition — true iff input is in the language. */
    recognize(input: Iterable<string>): boolean {
        return new ZipperDriver().recognize(
            this.start()._exp,
            this._toTokens(input),
        );
    }
}

/* ─── @rule decorator (TS5 stage-3) ──────────────────────────────────────
 *
 * A more ergonomic alternative to the stored-arrow `rule(body)` pattern.
 * Inspired by Bracha's `RunnableGrammar` / `ExecutableGrammar` (Magi),
 * but implemented with native decorators rather than mirrors / proxies.
 *
 *   class Math extends Grammar<{ expr: number; ... }> {
 *     @rule get expr(): Parser<number> {
 *       return this.or(
 *         this.seq(this.expr, this.char('+'), this.term)
 *             .map(([l, , r]) => l + r),
 *         this.term,
 *       );
 *     }
 *     start() { return this.expr; }
 *   }
 *
 * **Getter form**: referenced as `this.expr` (not `this.expr()`). Decorator wraps
 *   the getter so each instance always returns the same `Parser` (backed by a
 *   `DelayedExp`), cached per `(this, getter)`, making the grammar graph
 *   properly recursive without manual thunks.
 *
 * **Method form** (Pratt-style, parameterised productions):
 *
 *   @rule expr(min: number): Parser<...> { ... }
 *
 *   Cache key is `(this, method, treeKey([min]))`. Each (instance, method,
 *   arg-tuple) triple gets its own `DelayedExp` slot.
 *
 * Subclass override semantics: a subclass `@rule override get expr() { ... }`
 *   defines a *new* getter function, so it occupies a different cache slot
 *   from the parent's. Calling `super.expr` from inside the override
 *   accesses the parent's (decorated) getter and hits the parent's slot.
 */

type RuleGetterCtx = ClassGetterDecoratorContext<Grammar, Parser<unknown>>;
type RuleMethodCtx = ClassMethodDecoratorContext<
    Grammar,
    (this: Grammar, ...args: any[]) => Parser<unknown>
>;

export function rule<T>(
    target: (this: Grammar) => Parser<T>,
    ctx: RuleGetterCtx,
): (this: Grammar) => Parser<T>;
export function rule<T, A extends unknown[]>(
    target: (this: Grammar, ...args: A) => Parser<T>,
    ctx: RuleMethodCtx,
): (this: Grammar, ...args: A) => Parser<T>;
export function rule(
    target: (this: Grammar, ...args: unknown[]) => Parser<unknown>,
    ctx: RuleGetterCtx | RuleMethodCtx,
): (this: Grammar, ...args: unknown[]) => Parser<unknown> {
    if (ctx.kind === 'getter') {
        return function (this: Grammar): Parser<unknown> {
            return this._ruleSlot(target, () => target.call(this));
        };
    }
    if (ctx.kind === 'method') {
        return function (this: Grammar, ...args: unknown[]): Parser<unknown> {
            return this._paramRuleSlot(target, treeKey(args), () => target.apply(this, args));
        };
    }
    throw new Error(`@rule cannot decorate a ${(ctx as { kind: string }).kind}`);
}

