/**
 * Hash-consing factory for `Parser` nodes.
 *
 * Every `Parser` constructor is exposed only via this Pool — direct `new`
 * calls are reserved for the Pool itself. The Pool guarantees that
 * structurally-equal nodes share identity (`===`), which is what makes
 * per-node memo caches effective and compaction aggressive.
 *
 * The Pool is *per `Grammar` instance*, not global, so each grammar gets its
 * own interning namespace.
 */

import { Parser } from './Parser.mjs';
import { addTree, treeKey } from './fix.mjs';
import { Alt, Cat, Delayed, Empty, Epsilon, Red, Rep, Token } from './nodes.mjs';

export class Pool {
    /** Singleton ∅ for this pool. */
    readonly empty: Parser<never>;

    private readonly _epsilonByKey = new Map<string, Epsilon<unknown>>();
    private readonly _alt = new WeakMap<Parser<unknown>, WeakMap<Parser<unknown>, Alt<unknown, unknown>>>();
    private readonly _cat = new WeakMap<Parser<unknown>, WeakMap<Parser<unknown>, Cat<unknown, unknown>>>();
    private readonly _red = new WeakMap<Parser<unknown>, WeakMap<Function, Red<unknown, unknown>>>();
    /** Canonical interning for "pair with constant witness on the left/right" Reds
     *  produced by Cat-Eps absorption. Keyed by (witnessKey, child) so two
     *  semantically-identical absorbed Cats share identity (otherwise two fresh
     *  closures defeat `_red`'s interning — Might's "lack of sharing" issue). */
    private readonly _pairLeft = new WeakMap<Parser<unknown>, Map<string, Red<unknown, unknown>>>();
    private readonly _pairRight = new WeakMap<Parser<unknown>, Map<string, Red<unknown, unknown>>>();
    private readonly _rep = new WeakMap<Parser<unknown>, Rep<unknown>>();
    private readonly _token = new WeakMap<Function, Token>();
    private readonly _char = new Map<string, Parser<string>>();

    constructor() {
        this.empty = new Empty(this);
    }

    /**
     * `Epsilon` carries a set of parse trees. `epsilon(∅) === pool.empty`
     * (an ε with no parse trees is observationally indistinguishable from ∅
     * for parse-forest purposes).
     */
    epsilon<T>(trees: ReadonlySet<T>): Parser<T> {
        if (trees.size === 0) return this.empty as unknown as Parser<T>;
        const entries = new Map<string, T>();
        for (const t of trees) addTree(entries, t);
        return this.epsilonEntries(entries);
    }

    /** Internal entry-keyed variant (preserves dedupe done by caller). */
    epsilonEntries<T>(entries: ReadonlyMap<string, T>): Parser<T> {
        if (entries.size === 0) return this.empty as unknown as Parser<T>;
        const keys = [...entries.keys()].sort().join('|');
        const hit = this._epsilonByKey.get(keys);
        if (hit) return hit as Parser<T>;
        const node = new Epsilon<T>(this, entries);
        this._epsilonByKey.set(keys, node as Epsilon<unknown>);
        return node;
    }

    token(predicate: (c: string) => boolean, label = '<pred>'): Parser<string> {
        let hit = this._token.get(predicate);
        if (!hit) {
            hit = new Token(this, predicate, label);
            this._token.set(predicate, hit);
        }
        return hit;
    }

    /** Match exactly one literal character. */
    char(ch: string): Parser<string> {
        let hit = this._char.get(ch);
        if (!hit) {
            const pred = (c: string) => c === ch;
            hit = new Token(this, pred, JSON.stringify(ch));
            this._char.set(ch, hit);
        }
        return hit;
    }

    /**
     * Smart constructor for alternation:
     *   ∅ ∪ L → L,  L ∪ ∅ → L,  L ∪ L → L
     *   ε(s) ∪ ε(t) → ε(s ∪ t)
     * (Spiewak: same idea as `override def ~ = this` on the empty parser.)
     */
    alt<A, B>(a: Parser<A>, b: Parser<B>): Parser<A | B> {
        if ((a as unknown) === (b as unknown)) return a as Parser<A | B>;
        if ((a as unknown) === this.empty) return b as Parser<A | B>;
        if ((b as unknown) === this.empty) return a as Parser<A | B>;
        // Eager ε∪ε fusion— the only structural rewrite Pool can do without traversal.
        if (a instanceof Epsilon && b instanceof Epsilon) {
            const merged = new Map<string, A | B>();
            for (const [k, v] of a.entries) merged.set(k, v as A | B);
            for (const [k, v] of b.entries) merged.set(k, v as A | B);
            return this.epsilonEntries(merged);
        }
        const A = a as Parser<unknown>, B = b as Parser<unknown>;
        let inner = this._alt.get(A);
        if (!inner) { inner = new WeakMap(); this._alt.set(A, inner); }
        let hit = inner.get(B);
        if (!hit) { hit = new Alt(this, A, B); inner.set(B, hit); }
        return hit as Parser<A | B>;
    }

    /**
     * Smart constructor for concatenation. Dispatch is delegated to the
     * operand nodes via `Parser.catLeftOf` / `Parser.catRightOf`; this
     * factory only does the plain interning fallback.
     */
    cat<A, B>(a: Parser<A>, b: Parser<B>): Parser<[A, B]> {
        return a.catLeftOf(b, this);
    }

    /** Generic Cat interning — called from the virtual cascade fallback. */
    _internCat<A, B>(a: Parser<A>, b: Parser<B>): Parser<[A, B]> {
        const A = a as Parser<unknown>, B = b as Parser<unknown>;
        let inner = this._cat.get(A);
        if (!inner) { inner = new WeakMap(); this._cat.set(A, inner); }
        let hit = inner.get(B);
        if (!hit) { hit = new Cat(this, A, B); inner.set(B, hit); }
        return hit as unknown as Parser<[A, B]>;
    }

    /** Canonical `Red(child, x ↦ [witness, x])` — left-side ε-prefix flatten. */
    _internPairLeft<W, X>(child: Parser<X>, witness: W): Parser<[W, X]> {
        const C = child as Parser<unknown>;
        let inner = this._pairLeft.get(C);
        if (!inner) { inner = new Map(); this._pairLeft.set(C, inner); }
        const key = treeKey(witness);
        let hit = inner.get(key);
        if (!hit) {
            hit = new Red(this, C, (x: unknown) => [witness, x] as [W, X]);
            inner.set(key, hit);
        }
        return hit as unknown as Parser<[W, X]>;
    }

    /** Canonical `Red(child, x ↦ [x, witness])` — right-side ε-suffix flatten. */
    _internPairRight<X, W>(child: Parser<X>, witness: W): Parser<[X, W]> {
        const C = child as Parser<unknown>;
        let inner = this._pairRight.get(C);
        if (!inner) { inner = new Map(); this._pairRight.set(C, inner); }
        const key = treeKey(witness);
        let hit = inner.get(key);
        if (!hit) {
            hit = new Red(this, C, (x: unknown) => [x, witness] as [X, W]);
            inner.set(key, hit);
        }
        return hit as unknown as Parser<[X, W]>;
    }

    rep<T>(p: Parser<T>): Parser<T[]> {
        if ((p as unknown) === this.empty) {
            const out = new Map<string, T[]>();
            addTree(out, []);
            return this.epsilonEntries(out) as Parser<T[]>;
        }
        const P = p as Parser<unknown>;
        let hit = this._rep.get(P);
        if (!hit) { hit = new Rep(this, P); this._rep.set(P, hit); }
        return hit as unknown as Parser<T[]>;
    }

    /**
     * Smart constructor for reduction. Dispatch is delegated to the
     * operand node via `Parser.reduceWith`; this factory only does the
     * plain interning fallback.
     */
    red<A, B>(p: Parser<A>, fn: (a: A) => B): Parser<B> {
        return p.reduceWith(fn, this);
    }

    /** Generic Red interning — called from the virtual cascade fallback. */
    _internRed<A, B>(p: Parser<A>, fn: (a: A) => B): Parser<B> {
        const P = p as Parser<unknown>;
        let inner = this._red.get(P);
        if (!inner) { inner = new WeakMap(); this._red.set(P, inner); }
        let hit = inner.get(fn);
        if (!hit) { hit = new Red(this, P, fn as (x: unknown) => unknown); inner.set(fn, hit); }
        return hit as unknown as Parser<B>;
    }

    delay<T>(thunk: () => Parser<unknown>): Parser<T> {
        return new Delayed<T>(this, thunk);
    }
}
