/**
 * Concrete `Parser` nodes implementing the language algebra.
 *
 * Naming follows Might/Darais "Yacc is Dead":
 *   ∅       → Empty
 *   ε       → Epsilon (carries a set of parse trees)
 *   c       → Token   (predicate over a single character)
 *   A ∪ B   → Alt
 *   A ○ B   → Cat
 *   A*      → Rep
 *   f(A)    → Red     (semantic-action / reduction wrapper)
 *
 * `Delayed` is the lazy-thunk node used both for forward references inside
 * a `Grammar` (so productions can reference themselves) and for derive
 * results (so cyclic derives don't recurse infinitely).
 */

import { LeafParser, Parser } from './Parser.mjs';
import { addTree } from './fix.mjs';
import type { Pool } from './Pool.mjs';

/* ─── ∅ — recognises nothing ─────────────────────────────────────────── */
export class Empty extends LeafParser<never> {
    computeParseNull(): Map<string, never> { return new Map<string, never>(); }
    computeDerive(_c: string): Parser<never> { return this.pool.empty; }
    computeIsEmptyLang(): boolean { return true; }
    computeIsOnlyNull(): boolean { return true; }   // ∅ ⊆ {ε} vacuously

    /* ∅ absorbs both sides of concatenation and any reduction. */
    override catLeftOf<U>(_right: Parser<U>, pool: Pool): Parser<[never, U]> {
        return pool.empty as unknown as Parser<[never, U]>;
    }
    override catRightOf<U>(_left: Parser<U>, pool: Pool): Parser<[U, never]> {
        return pool.empty as unknown as Parser<[U, never]>;
    }
    override reduceWith<U>(_fn: (t: never) => U, pool: Pool): Parser<U> {
        return pool.empty as unknown as Parser<U>;
    }
}

/* ─── ε — recognises only the empty string, carrying parse trees ─────── */
export class Epsilon<T> extends LeafParser<T> {
    constructor(pool: Pool, readonly entries: ReadonlyMap<string, T>) { super(pool); }
    computeParseNull(): Map<string, T> { return new Map(this.entries); }
    computeDerive(_c: string): Parser<never> { return this.pool.empty; }
    computeIsEmptyLang(): boolean { return false; }
    computeIsOnlyNull(): boolean { return true; }

    /** ε(s) ○ B → Red(B, b ↦ [s, b])  — Might/Darais ε-prefix flattening. */
    override catLeftOf<U>(right: Parser<U>, pool: Pool): Parser<[T, U]> {
        if ((right as unknown) === pool.empty) return pool.empty as unknown as Parser<[T, U]>;
        const witness = this.entries.values().next().value as T;
        return pool._internPairLeft<T, U>(right, witness);
    }
    /** A ○ ε(t) → Red(A, a ↦ [a, t]). */
    override catRightOf<U>(left: Parser<U>, pool: Pool): Parser<[U, T]> {
        if ((left as unknown) === pool.empty) return pool.empty as unknown as Parser<[U, T]>;
        const witness = this.entries.values().next().value as T;
        return pool._internPairRight<U, T>(left, witness);
    }
    /** Red(ε(s), f) → ε({f(s) | s ∈ s}). */
    override reduceWith<U>(fn: (t: T) => U, pool: Pool): Parser<U> {
        const out = new Map<string, U>();
        for (const t of this.entries.values()) addTree(out, fn(t));
        return pool.epsilonEntries(out);
    }
}

/* ─── c — single-character predicate ─────────────────────────────────── */
export class Token extends LeafParser<string> {
    constructor(pool: Pool, readonly predicate: (c: string) => boolean, readonly label: string) { super(pool); }
    computeParseNull(): Map<string, string> { return new Map(); }
    computeDerive(c: string): Parser<string> {
        return this.predicate(c) ? this.pool.epsilon(new Set([c])) : this.pool.empty;
    }
    computeIsEmptyLang(): boolean { return false; }
    computeIsOnlyNull(): boolean { return false; }
}

/* ─── A ∪ B ──────────────────────────────────────────────────────────── */
export class Alt<A, B> extends Parser<A | B> {
    constructor(pool: Pool, readonly left: Parser<A>, readonly right: Parser<B>) { super(pool); }
    computeParseNull(): Map<string, A | B> {
        const out = new Map<string, A | B>();
        for (const [k, v] of this.left.parseNullEntries()) out.set(k, v);
        for (const [k, v] of this.right.parseNullEntries()) out.set(k, v);
        return out;
    }
    computeDerive(c: string): Parser<unknown> {
        return this.pool.alt(this.left.derive(c), this.right.derive(c));
    }
    computeCompact(): Parser<A | B> {
        // pool.alt handles ∅∪L, L∪∅, L∪L, and ε∪ε fusion eagerly.
        return this.pool.alt(this.left.compact(), this.right.compact()) as Parser<A | B>;
    }
    computeIsEmptyLang(): boolean {
        return this.left.isEmptyLang() && this.right.isEmptyLang();
    }
    computeIsOnlyNull(): boolean {
        return this.left.isOnlyNull() && this.right.isOnlyNull();
    }
}

/* ─── A ○ B — sequence; parse trees are pairs ─────────────────────────── */
export class Cat<A, B> extends Parser<[A, B]> {
    constructor(pool: Pool, readonly left: Parser<A>, readonly right: Parser<B>) { super(pool); }
    computeParseNull(): Map<string, [A, B]> {
        const out = new Map<string, [A, B]>();
        const ls = this.left.parseNullEntries();
        const rs = this.right.parseNullEntries();
        if (ls.size === 0 || rs.size === 0) return out;
        for (const a of ls.values())
            for (const b of rs.values())
                addTree(out, [a, b] as [A, B]);
        return out;
    }
    /**
     * d(c, Cat(A, B)) =
     *   d(c,A) ○ B                              if A is not nullable
     *   d(c,A) ○ B  ∪  ε(parseNull(A)) ○ d(c,B) if A is nullable
     *
     * Gating the second branch on `nullable` (Might/Darais) avoids
     * doubling the graph on every derive when the left side can't complete.
     *
     * We use an *eager* `Epsilon` snapshot of `parseNull(A)` (Might's exact
     * formulation): the snapshot is content-keyed and shared across
     * derivatives via the Pool.
     */
    computeDerive(c: string): Parser<unknown> {
        const dl = this.pool.cat(this.left.derive(c) as Parser<A>, this.right);
        if (!this.left.nullable) return dl;
        const snapshot = this.pool.epsilonEntries(this.left.parseNullEntries()) as Parser<A>;
        const dr = this.pool.cat(snapshot, this.right.derive(c) as Parser<B>);
        return this.pool.alt(dl, dr);
    }
    computeCompact(): Parser<[A, B]> {
        // pool.cat handles ∅○L, L○∅, ε○L → Red, L○ε → Red eagerly.
        return this.pool.cat(this.left.compact(), this.right.compact()) as Parser<[A, B]>;
    }
    computeIsEmptyLang(): boolean {
        return this.left.isEmptyLang() || this.right.isEmptyLang();
    }
    computeIsOnlyNull(): boolean {
        return this.left.isOnlyNull() && this.right.isOnlyNull();
    }
}

/* ─── A* — Kleene star; parse trees are arrays ───────────────────────── */
export class Rep<T> extends Parser<T[]> {
    constructor(pool: Pool, readonly inner: Parser<T>) { super(pool); }
    computeParseNull(): Map<string, T[]> {
        const out = new Map<string, T[]>();
        addTree(out, []);
        return out;
    }
    computeDerive(c: string): Parser<unknown> {
        // d(c, A*) = d(c, A) ○ A* , flattened to a list via Red
        const di = this.inner.derive(c) as Parser<T>;
        const cat = this.pool.cat(di, this);
        return this.pool.red(cat, ([head, tail]: [T, T[]]) => [head, ...tail]);
    }
    computeCompact(): Parser<T[]> {
        // pool.rep handles ∅* → ε([]) eagerly.
        return this.pool.rep(this.inner.compact()) as Parser<T[]>;
    }
    computeIsEmptyLang(): boolean { return false; } // A* always recognises ε
    computeIsOnlyNull(): boolean {
        // A* is only-ε iff A is empty (∅* = ε) or A itself only-ε (ε* = ε)
        return this.inner.isEmptyLang() || this.inner.isOnlyNull();
    }
}

/* ─── Red — semantic-action wrapper ──────────────────────────────────── */
export class Red<A, B> extends Parser<B> {
    constructor(pool: Pool, readonly inner: Parser<A>, readonly fn: (a: A) => B) { super(pool); }
    computeParseNull(): Map<string, B> {
        const out = new Map<string, B>();
        for (const a of this.inner.parseNullEntries().values())
            addTree(out, this.fn(a));
        return out;
    }
    computeDerive(c: string): Parser<unknown> {
        return this.pool.red(this.inner.derive(c) as Parser<A>, this.fn);
    }
    computeCompact(): Parser<B> {
        // pool.red handles Red(∅,_), Red(ε,f), and Red∘Red fusion eagerly.
        return this.pool.red(this.inner.compact(), this.fn);
    }
    computeIsEmptyLang(): boolean { return this.inner.isEmptyLang(); }
    computeIsOnlyNull(): boolean { return this.inner.isOnlyNull(); }

    /** Red(Red(L, g), f) → Red(L, f∘g) — Might/Darais reduction fusion. */
    override reduceWith<U>(fn: (b: B) => U, pool: Pool): Parser<U> {
        const g = this.fn;
        return (this.inner as Parser<unknown>).reduceWith(
            (x: unknown) => fn(g(x as A)),
            pool,
        ) as Parser<U>;
    }
}

/* ─── Lazy thunk — used for forward refs and derive results ──────────── */
export class Delayed<T> extends Parser<T> {
    private _forced: Parser<T> | undefined;

    constructor(pool: Pool, private readonly thunk: () => Parser<unknown>) { super(pool); }

    force(): Parser<T> {
        if (!this._forced) this._forced = this.thunk() as Parser<T>;
        return this._forced;
    }

    /* Delayed is fully transparent — delegate, don't maintain its own LFP. */
    override get nullable(): boolean { return this.force().nullable; }
    override parseNull(): Set<T> { return this.force().parseNull(); }
    override parseNullEntries(): ReadonlyMap<string, T> { return this.force().parseNullEntries(); }
    override derive(c: string): Parser<unknown> { return this.force().derive(c); }
    override compact(): Parser<T> { return this.force().compact(); }
    override isEmptyLang(): boolean { return this.force().isEmptyLang(); }
    override isOnlyNull(): boolean { return this.force().isOnlyNull(); }

    /* Required by abstract base, but unreachable thanks to the overrides. */
    computeParseNull(): Map<string, T> { return new Map(this.force().parseNullEntries()); }
    computeDerive(c: string): Parser<unknown> { return this.force().derive(c); }
    computeCompact(): Parser<T> { return this.force().compact(); }
    computeIsEmptyLang(): boolean { return this.force().isEmptyLang(); }
    computeIsOnlyNull(): boolean { return this.force().isOnlyNull(); }
}

