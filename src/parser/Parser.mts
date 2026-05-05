/**
 * Abstract base class for every node in the language algebra.
 *
 * `nullable` is derived from `parseNull` (nullable iff parseNull non-empty),
 * which avoids the entanglement of two simultaneous LFPs. See `fix.mts`.
 */

import {
    type FixSlot,
    isEmptyLangLattice,
    isOnlyNullLattice,
    parseNullEntries,
} from './fix.mjs';
import type { Pool } from './Pool.mjs';

export abstract class Parser<T> {
    constructor(readonly pool: Pool) { }

    /* ---- LFP slots (one per lattice in fix.mts) ---- */
    /** @internal */ _parseNullSlot: FixSlot<ReadonlyMap<string, unknown>> | undefined;
    /** @internal */ _emptySlot: FixSlot<boolean> | undefined;
    /** @internal */ _onlyNullSlot: FixSlot<boolean> | undefined;

    /* ---- Other memo caches ---- */
    /** @internal */ _deriveCache = new Map<string, Parser<unknown>>();
    /** @internal */ _compactCache: Parser<T> | undefined = undefined;
    /** @internal */ _compacting = false;

    /* ---- subclass-supplied semantics ---- */
    abstract computeParseNull(): Map<string, T>;
    abstract computeDerive(c: string): Parser<unknown>;
    abstract computeCompact(): Parser<T>;
    /** Coinductive: starts at `true`, falls to `false` only on structural evidence. */
    abstract computeIsEmptyLang(): boolean;
    /** Coinductive: starts at `true`, falls to `false` only on structural evidence. */
    abstract computeIsOnlyNull(): boolean;

    /* ---- Smart-constructor dispatch (Pool delegates here) ──────────────
     *
     * `Pool.cat` / `Pool.red` are pure factories — they call into these
     * virtual hooks, letting each node decide its own algebraic identity:
     *
     *   • `Empty`  : ∅ ○ L = L ○ ∅ = ∅ ; Red(∅, _) = ∅
     *   • `Epsilon`: ε(s) ○ B = Red(B, b ↦ [s,b])  (left-pair flatten)
     *                A ○ ε(t) = Red(A, a ↦ [a,t])  (right-pair flatten)
     *                Red(ε(s), f) = ε({f(s) | s ∈ s})
     *   • `Red`    : Red(Red(L,g), f) = Red(L, f∘g)         (fusion)
     *
     * Default cascade for `cat`: `a.catLeftOf(b)` first asks `b` (so the
     * right side gets a chance via `b.catRightOf(a)`), and if neither side
     * has a strategy the pool's plain interner is used.
     */

    /** Build `this ○ right`, with `this` choosing the strategy first. */
    catLeftOf<U>(right: Parser<U>, pool: Pool): Parser<[T, U]> {
        return right.catRightOf(this, pool);
    }

    /** Build `left ○ this`, with `this` choosing the strategy. Default: generic intern. */
    catRightOf<U>(left: Parser<U>, pool: Pool): Parser<[U, T]> {
        return pool._internCat(left, this);
    }

    /** Build `Red(this, fn)`, with `this` choosing the strategy. Default: generic intern. */
    reduceWith<U>(fn: (t: T) => U, pool: Pool): Parser<U> {
        return pool._internRed(this, fn);
    }

    /* ---- public memoised accessors ---- */
    parseNull(): Set<T> {
        return new Set(parseNullEntries(this).values());
    }

    /** @internal — direct keyed access for internal compute methods. */
    parseNullEntries(): ReadonlyMap<string, T> {
        return parseNullEntries(this);
    }

    get nullable(): boolean {
        return parseNullEntries(this).size > 0;
    }

    /** True iff this parser recognises *no* strings (≡ ∅). LFP-computed. */
    isEmptyLang(): boolean { return isEmptyLangLattice.solve(this as Parser<unknown>); }

    /** True iff this parser recognises only ε (≡ p ⊆ {ε}). LFP-computed. */
    isOnlyNull(): boolean { return isOnlyNullLattice.solve(this as Parser<unknown>); }

    derive(c: string): Parser<unknown> {
        let r = this._deriveCache.get(c);
        if (!r) {
            // Wrap in a Delayed so cyclic derives don't recurse infinitely;
            // the actual derivative is computed only when the result is touched.
            r = this.pool.delay(() => this.computeDerive(c));
            this._deriveCache.set(c, r);
        }
        return r;
    }

    compact(): Parser<T> {
        if (this._compactCache) return this._compactCache;
        if (this._compacting) return this; // break cycles; replaced on next pass
        this._compacting = true;
        // Might/Darais compaction short-circuits — these are the rules that
        // collapse recursive sub-grammars into ∅ or ε once they've settled.
        let r: Parser<T>;
        if (this.isEmptyLang()) {
            r = this.pool.empty as unknown as Parser<T>;
        } else if (this.isOnlyNull()) {
            r = this.pool.epsilonEntries(parseNullEntries(this)) as Parser<T>;
        } else {
            r = this.computeCompact();
        }
        this._compacting = false;
        this._compactCache = r;
        return r;
    }

    /* ─── Fluent algebra ───────────────────────────────────────────────── */

    /** Alternation: `A.or(B)` ≡ A ∪ B. */
    or<U>(other: Parser<U>): Parser<T | U> {
        return this.pool.alt(this, other);
    }

    /** Concatenation: `A.then(B)` ≡ A ○ B; parse trees are pairs `[A, B]`. */
    then<U>(other: Parser<U>): Parser<[T, U]> {
        return this.pool.cat(this, other);
    }

    /** Semantic action / reduction. */
    map<U>(fn: (t: T) => U): Parser<U> {
        return this.pool.red(this, fn);
    }

    /** Kleene star: `A.many()` ≡ A*; parse trees are arrays. */
    many(): Parser<T[]> {
        return this.pool.rep(this);
    }

    /** Optional: `A.opt()` ≡ A ∪ ε; parse trees are `T | undefined`. */
    opt(): Parser<T | undefined> {
        return this.pool.alt(this, this.pool.epsilon<undefined>(new Set([undefined])));
    }
}

/**
 * Convenience base for terminal nodes (`Empty`, `Epsilon`, `Token`).
 *
 * Leaves are already-compact and never spawn cyclic derivatives, so:
 *   • `computeCompact` returns `this`
 *   • `derive` is overridden to bypass the `Delayed` wrapping done by
 *     `Parser.derive` — cheaper, and safe because there's no cycle.
 *
 * Subclasses must still implement `computeParseNull`, `computeDerive`,
 * `computeIsEmptyLang`, and `computeIsOnlyNull`.
 */
export abstract class LeafParser<T> extends Parser<T> {
    computeCompact(): Parser<T> { return this; }
    override derive(c: string): Parser<unknown> { return this.computeDerive(c); }
}
