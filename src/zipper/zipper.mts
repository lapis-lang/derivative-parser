/**
 * Parsing with Zippers (Darragh & Adams, ICFP 2020) — TypeScript port
 * extended with full semantic-action support.
 *
 * The algorithm replaces Brzozowski's per-token global derivative with a
 * worklist of *zippers* — each zipper is `(Exp, Mem, value)`, where the
 * `Exp` is the "in-focus" subexpression, `Mem` records start/end positions
 * plus the list of parent contexts, and `value` carries the semantic result
 * accumulated so far. Sharing is achieved by physical equality on `Pos`
 * (a fresh allocation per token position): if a node has already been
 * visited at the current position, we just thread a new parent context into
 * its existing memo rather than re-traversing its sub-grammar.
 *
 * OO structure:
 *
 *   Exp   ─┬─ TokExp         Cxt   ─┬─ TopCxt
 *          ├─ PredTokExp             ├─ SeqCxt
 *          ├─ SeqExp                 ├─ AltCxt
 *          ├─ AltExp                 └─ RedCxt
 *          ├─ EpsilonExp
 *          ├─ EmptyExp
 *          ├─ RedExp
 *          └─ DelayedExp
 *
 * Each `Exp` subclass implements `descend(driver, m)`; each `Cxt` subclass
 * implements `goUp(driver, e, value)`. The driver holds all mutable
 * derivation state (`worklist`, `topValues`, `pos`, `currentToken`),
 * making the engine re-entrant by construction.
 */

/* ─── Position sentinel ──────────────────────────────────────────────── */

/** A parsing-step identity. Allocated per token position; compared with `===`. */
export type Pos = { readonly _pos: true };

function freshPos(): Pos { return { _pos: true } as Pos; }

/** Sentinel "no position" — used as the default `endPos` of a never-completed Mem. */
const P_BOTTOM: Pos = freshPos();

/* ─── Tokens ─────────────────────────────────────────────────────────── */

/**
 * Tokens are `(tag, sym)`. `tag` is a string used for equality
 * (a single character in our test setup); `sym` is a human-readable label.
 */
export type Tok = { readonly tag: string; readonly sym: string };

const T_EOF: Tok = { tag: '\u0000<EOF>', sym: '<EOF>' };
const S_BOTTOM = '<s_bottom>';

/* ─── Mem ────────────────────────────────────────────────────────────── */

/**
 * Per-(node, position) memo. Mutable on purpose — the algorithm threads
 * parent contexts and accumulated semantic values back into a single shared
 * `Mem` so grammar nodes visited multiple times at the same position are
 * folded.
 *
 * `endPos === P_BOTTOM` means "not yet completed at any position".
 * `values` collects all semantic results that have been propagated through
 * this memo at the current position (one per parse tree).
 */
export class Mem {
    endPos: Pos = P_BOTTOM;
    values: unknown[] = [];
    constructor(readonly startPos: Pos, readonly parents: Cxt[]) { }
}

/* ─── Exp hierarchy ──────────────────────────────────────────────────── */

/**
 * In-focus grammar subexpression. Subclasses implement `descend` to do
 * the structural step.
 */
export abstract class Exp {
    /**
     * Mutable memo: lazily updated as derivation reaches this node at new
     * positions. `undefined` means "never visited" — handled by `goDown`.
     */
    m: Mem | undefined = undefined;

    /**
     * Descend into this Exp under context `parent`.
     *
     * If we've already visited this node at the current position, thread
     * `parent` into the existing memo (and propagate any already-accumulated
     * values upward). Otherwise allocate a fresh memo and dispatch via
     * `descend`.
     */
    goDown(driver: ZipperDriver, parent: Cxt): void {
        const m0 = this.m;
        if (m0 && m0.startPos === driver.pos) {
            m0.parents.push(parent);
            // Re-flow all values that have already been produced at this position.
            if (m0.endPos === driver.pos) {
                for (const v of m0.values) parent.goUp(driver, v);
            }
        } else {
            const m = new Mem(driver.pos, [parent]);
            this.m = m;
            this.descend(driver, m);
        }
    }

    /** Structural derivation step. Subclass-specific. */
    abstract descend(driver: ZipperDriver, m: Mem): void;
}

/* ─── Terminal nodes ─────────────────────────────────────────────────── */

/** Exact single-token match. Semantic value = the matched tag string. */
export class TokExp extends Exp {
    constructor(readonly tok: Tok) { super(); }
    descend(driver: ZipperDriver, m: Mem): void {
        if (driver.currentToken.tag === this.tok.tag) {
            driver.worklist.push({ mem: m, value: driver.currentToken.tag });
        }
    }
}

/** Predicate-based single-token match. Semantic value = the matched tag string. */
export class PredTokExp extends Exp {
    constructor(
        readonly pred: (tag: string) => boolean,
        readonly label: string,
    ) { super(); }
    descend(driver: ZipperDriver, m: Mem): void {
        if (this.pred(driver.currentToken.tag)) {
            driver.worklist.push({ mem: m, value: driver.currentToken.tag });
        }
    }
}

/* ─── Structural nodes ───────────────────────────────────────────────── */

/**
 * N-ary sequence with a semantic function.
 * `fn` receives an array of child values (in order) and returns the combined value.
 */
export class SeqExp extends Exp {
    constructor(
        readonly sym: string,
        readonly children: readonly Exp[],
        readonly fn: (vals: unknown[]) => unknown = (vs) => vs,
    ) { super(); }

    descend(driver: ZipperDriver, m: Mem): void {
        if (this.children.length === 0) {
            driver.completeAt(m, this.fn([]));
        } else {
            const [head, ...rest] = this.children;
            const m2 = new Mem(m.startPos, [new AltCxt(m)]);
            head!.goDown(driver, new SeqCxt(m2, this.fn, [], rest));
        }
    }
}

/** N-ary alternation. `children` is mutable so cyclic grammars can patch it. */
export class AltExp extends Exp {
    constructor(readonly children: Exp[]) { super(); }
    descend(driver: ZipperDriver, m: Mem): void {
        for (const c of this.children) c.goDown(driver, new AltCxt(m));
    }
}

/** ε — always succeeds with a given semantic value. */
export class EpsilonExp<T = unknown> extends Exp {
    constructor(readonly value: T) { super(); }
    descend(driver: ZipperDriver, m: Mem): void {
        driver.completeAt(m, this.value);
    }
}

/** ∅ — never succeeds. */
export class EmptyExp extends Exp {
    descend(_driver: ZipperDriver, _m: Mem): void { /* no-op */ }
}

/** Semantic-action wrapper: applies `fn` to each incoming value. */
export class RedExp<A = unknown, B = unknown> extends Exp {
    constructor(
        readonly inner: Exp,
        readonly fn: (a: A) => B,
    ) { super(); }
    descend(driver: ZipperDriver, m: Mem): void {
        this.inner.goDown(driver, new RedCxt(m, this.fn as (a: unknown) => unknown));
    }
}

/**
 * Lazy / forward-reference node — forces its thunk on first descend.
 * Required for `@rule` memoisation and cyclic `many()` grammars.
 */
export class DelayedExp<T = unknown> extends Exp {
    private _forced: Exp | undefined;
    constructor(private readonly thunk: () => Exp) { super(); }

    force(): Exp {
        if (!this._forced) this._forced = this.thunk();
        return this._forced;
    }

    descend(driver: ZipperDriver, m: Mem): void {
        // Delegate straight to the forced node, passing an AltCxt to forward
        // values upward through mem.
        this.force().goDown(driver, new AltCxt(m));
    }
}

/* ─── Cxt hierarchy ──────────────────────────────────────────────────── */

/** Parent context — knows how to propagate a completed value upward. */
export abstract class Cxt {
    abstract goUp(driver: ZipperDriver, value: unknown): void;
}

/** Outermost: completed values are recognised parses. */
export class TopCxt extends Cxt {
    goUp(driver: ZipperDriver, value: unknown): void {
        driver.topValues.push(value);
    }
}

/** Inside an n-ary sequence: `revLeft` already done (reversed), `right` pending. */
export class SeqCxt extends Cxt {
    constructor(
        readonly m: Mem,
        readonly fn: (vals: unknown[]) => unknown,
        readonly revLeftVals: readonly unknown[],
        readonly right: readonly Exp[],
    ) { super(); }

    goUp(driver: ZipperDriver, value: unknown): void {
        if (this.right.length === 0) {
            // All right-children consumed — compute semantic value.
            const vals = [...this.revLeftVals].reverse();
            vals.push(value);
            driver.completeAt(this.m, this.fn(vals));
        } else {
            // Move value to the left-done list, dive into the next right child.
            const [next, ...restRight] = this.right;
            next!.goDown(
                driver,
                new SeqCxt(this.m, this.fn, [value, ...this.revLeftVals], restRight),
            );
        }
    }
}

/**
 * Inside an alternation — passes values straight through to the parent mem.
 * Used both by `AltExp` and `DelayedExp`.
 */
export class AltCxt extends Cxt {
    constructor(readonly m: Mem) { super(); }
    goUp(driver: ZipperDriver, value: unknown): void {
        driver.completeAt(this.m, value);
    }
}

/** Applies a semantic function to an incoming value, then flows upward. */
export class RedCxt extends Cxt {
    constructor(
        readonly m: Mem,
        readonly fn: (a: unknown) => unknown,
    ) { super(); }
    goUp(driver: ZipperDriver, value: unknown): void {
        driver.completeAt(this.m, this.fn(value));
    }
}

/* ─── Driver ─────────────────────────────────────────────────────────── */

/** A pending (Mem, value) pair to be propagated up at the next position. */
type WorklistEntry = { readonly mem: Mem; readonly value: unknown };

/**
 * Owns all per-parse mutable state. A fresh driver per `parse`/`recognize`
 * call makes the engine re-entrant. The grammar itself is shared (its `Mem`
 * slots get rewritten each call — two concurrent parses on one grammar would
 * race).
 */
export class ZipperDriver {
    worklist: WorklistEntry[] = [];
    topValues: unknown[] = [];
    pos: Pos = freshPos();
    currentToken: Tok = T_EOF;
    /** When true, only track whether a value was produced (not all values). */
    recognizeOnly = false;

    /**
     * Mark `mem` complete with `value` at the current position; flow upward.
     * Multiple completions at the same position (different parse trees) are
     * all propagated — this enables full parse forests.
     *
     * In recognizeOnly mode, once a memo has been completed at the current
     * position, additional (semantically distinct) values are suppressed to
     * avoid exponential blowup on ambiguous grammars.
     */
    completeAt(mem: Mem, value: unknown): void {
        if (this.recognizeOnly && mem.endPos === this.pos) return; // already completed
        mem.endPos = this.pos;
        mem.values.push(value);
        for (const c of mem.parents) c.goUp(this, value);
    }

    /** Consume one token, advancing the worklist by one position. */
    step(token: Tok): void {
        this.currentToken = token;
        const w = this.worklist;
        this.worklist = [];
        this.topValues = [];
        for (const { mem, value } of w) this.completeAt(mem, value);
        this.pos = freshPos();
    }

    /**
     * Recognise `tokens` against the grammar rooted at `start`.
     * Returns `true` iff there is at least one parse.
     *
     * Runs in polynomial time by suppressing duplicate completions at the
     * same position — safe because recognition only needs to know whether
     * a value exists, not all values.
     */
    recognize(start: Exp, tokens: Iterable<Tok>): boolean {
        this.recognizeOnly = true;
        return this.parse(start, tokens).size > 0;
    }

    /**
     * Parse `tokens` against the grammar rooted at `start`.
     * Returns the set of all semantic values (parse forest).
     */
    parse<T>(start: Exp, tokens: Iterable<Tok>): Set<T> {
        this._init(start);
        for (const t of tokens) this.step(t);
        // EOF flush: drain any final reductions to the top.
        this.step(T_EOF);
        return new Set(this.topValues as T[]);
    }

    private _init(start: Exp): void {
        this.topValues = [];
        this.pos = freshPos();
        this.currentToken = T_EOF;
        // Bootstrap: create a top-level Mem whose parent will collect the result,
        // and a SeqCxt that, when the first step() fires, will descend into `start`.
        //
        // The seed completion at P_BOTTOM carries a dummy value (undefined).
        // SeqCxt.goUp sees right=[start] and calls start.goDown, accumulating
        // the dummy as revLeftVals[0].  When start completes with value `v`,
        // SeqCxt.goUp calls fn([undefined, v]) — so we must extract index 1.
        const mTop = new Mem(P_BOTTOM, [new TopCxt()]);
        const mSeq = new Mem(P_BOTTOM, [new SeqCxt(mTop, (vs) => vs[1]!, [], [start])]);
        this.worklist = [{ mem: mSeq, value: undefined }];
    }
}

/**
 * Stand-alone recognition entry point — convenience wrapper around
 * a fresh `ZipperDriver`.
 */
export function recognize(tokens: Iterable<Tok>, start: Exp): boolean {
    return new ZipperDriver().recognize(start, tokens);
}
