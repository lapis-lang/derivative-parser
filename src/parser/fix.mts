/**
 * Generic least-fixed-point machinery for monotone lattices over the
 * parser graph, plus the three concrete lattices we need:
 *
 *   • `parseNullLattice`   — bottom = ∅,    join = ∪      (parse-tree set)
 *   • `isEmptyLangLattice` — bottom = true, monotone ↓ false
 *   • `isOnlyNullLattice`  — bottom = true, monotone ↓ false
 *
 * `nullable` is *not* its own LFP — it's defined as `parseNull().size > 0`,
 * which removes the awkward entanglement of two simultaneous lattices and
 * makes cyclic-derive-of-`Cat` work cleanly via an eager `Epsilon` snapshot.
 *
 * Parse trees are deduplicated by a content key (see `treeKey`) so the
 * fix-point can detect convergence even when trees are arrays / objects
 * (`Set`'s native equality is identity-based and would never converge).
 *
 * The two boolean lattices are exactly the Might/Darais "Yacc is Dead"
 * formulation: bottom = `true`, monotone non-increasing (a cycle alone
 * can't disprove the property; only structural evidence can). With
 * `isOnlyNull` we can collapse an entire recursive sub-grammar that has
 * settled to only-ε behaviour into a flat ε node — see `compact()` in
 * Parser.mts.
 */

import type { Parser } from './Parser.mjs';

/* ─── Slots & lattice protocol ───────────────────────────────────────── */

export interface FixSlot<V> {
    val: V;
    settled: boolean;
}

interface FixRun {
    changed: boolean;
    visited: Set<Parser<unknown>>;
}

/**
 * A monotone lattice over the parser graph.
 *
 * Each lattice is an *instance* (typically a singleton) that owns:
 *   • the per-node slot accessor (`slot`) that says where on `Parser`
 *     to keep this lattice's memoised value (slots stored as direct
 *     fields keep the hot path allocation-free);
 *   • the per-iteration update (`compute`);
 *   • the convergence check (`equal`);
 *   • the *active run* state used by `solve` for re-entry detection.
 *
 * `solve(p)` runs the lattice to a fixed point starting at `p` and
 * returns the resulting value. It is re-entrant: the *outer* call drives
 * convergence; recursive *inner* calls during a single sweep update
 * slots and report changes upward.
 */
export abstract class Lattice<V> {
    /** @internal — exposed for diagnostics; identifies the lattice in errors. */
    abstract readonly name: string;

    /** Lazily allocate (and return) the per-node slot for this lattice. */
    abstract slot(p: Parser<unknown>): FixSlot<V>;
    /** Per-iteration update — uses children's current slot values. */
    abstract compute(p: Parser<unknown>): V;
    /** Convergence check between two consecutive iterates. */
    abstract equal(a: V, b: V): boolean;

    private _activeRun: FixRun | undefined;

    /**
     * Run this lattice to a fixed point starting at `p`, returning
     * `slot(p).val`. Idempotent for already-settled subgraphs.
     */
    solve(p: Parser<unknown>): V {
        const slot = this.slot(p);
        if (slot.settled) return slot.val;

        const run = this._activeRun;
        if (run) {
            if (run.visited.has(p)) return slot.val;
            run.visited.add(p);
            const next = this.compute(p);
            if (!this.equal(next, slot.val)) {
                slot.val = next;
                run.changed = true;
            }
            return next;
        }

        const newRun: FixRun = { changed: false, visited: new Set() };
        this._activeRun = newRun;
        try {
            let safety = 0;
            do {
                newRun.changed = false;
                newRun.visited.clear();
                this.solve(p);
                if (++safety > 10_000) throw new Error(`${this.name} fix-point did not converge`);
            } while (newRun.changed);
            for (const n of newRun.visited) this.slot(n).settled = true;
            return slot.val;
        } finally {
            this._activeRun = undefined;
        }
    }
}

/* ─── Concrete lattices ──────────────────────────────────────────────── */

function sameKeys(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const k of a.keys()) if (!b.has(k)) return false;
    return true;
}

const EMPTY_MAP: ReadonlyMap<string, unknown> = new Map();

class ParseNullLattice extends Lattice<ReadonlyMap<string, unknown>> {
    readonly name = 'parseNull';
    slot(p: Parser<unknown>): FixSlot<ReadonlyMap<string, unknown>> {
        let s = p._parseNullSlot;
        if (!s) { s = { val: EMPTY_MAP, settled: false }; p._parseNullSlot = s; }
        return s;
    }
    compute(p: Parser<unknown>): ReadonlyMap<string, unknown> {
        return p.computeParseNull() as ReadonlyMap<string, unknown>;
    }
    equal = sameKeys;
}

class IsEmptyLangLattice extends Lattice<boolean> {
    readonly name = 'isEmptyLang';
    slot(p: Parser<unknown>): FixSlot<boolean> {
        let s = p._emptySlot;
        if (!s) { s = { val: true, settled: false }; p._emptySlot = s; }
        return s;
    }
    compute(p: Parser<unknown>): boolean { return p.computeIsEmptyLang(); }
    equal(a: boolean, b: boolean): boolean { return a === b; }
}

class IsOnlyNullLattice extends Lattice<boolean> {
    readonly name = 'isOnlyNull';
    slot(p: Parser<unknown>): FixSlot<boolean> {
        let s = p._onlyNullSlot;
        if (!s) { s = { val: true, settled: false }; p._onlyNullSlot = s; }
        return s;
    }
    compute(p: Parser<unknown>): boolean { return p.computeIsOnlyNull(); }
    equal(a: boolean, b: boolean): boolean { return a === b; }
}

export const parseNullLattice: Lattice<ReadonlyMap<string, unknown>> = new ParseNullLattice();
export const isEmptyLangLattice: Lattice<boolean> = new IsEmptyLangLattice();
export const isOnlyNullLattice: Lattice<boolean> = new IsOnlyNullLattice();

/* ─── Public, typed entry points ─────────────────────────────────────── */

export function parseNullEntries<T>(p: Parser<T>): ReadonlyMap<string, T> {
    return parseNullLattice.solve(p as Parser<unknown>) as ReadonlyMap<string, T>;
}

/* ─── Tree keying ────────────────────────────────────────────────────── */

/**
 * Build a stable content-based key for a parse tree value.
 *
 * Falls back to a "<unkeyable@N>" key for non-JSON-serialisable values,
 * which means the LFP may not converge for grammars producing such trees;
 * documented limitation, easy to override per-grammar in a later iteration.
 */
let _unkeyableCounter = 0;
export function treeKey(v: unknown): string {
    try {
        const s = JSON.stringify(v);
        if (s !== undefined) return s;
    } catch { /* fall through */ }
    return `<unkeyable@${++_unkeyableCounter}>`;
}

/** Add a parse-tree value to a content-keyed map under its content key. */
export function addTree<T>(out: Map<string, T>, v: T): void {
    out.set(treeKey(v), v);
}
