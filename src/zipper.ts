/**
 * Parsing with Zippers (Darragh & Adams, ICFP 2020) — TypeScript port with
 * semantic-action support. See the README for the algorithm overview.
 */

/* ─── Position sentinel ──────────────────────────────────────────────── */

/** A parsing-step identity. Allocated per token position; compared with `===`. */
export type Pos = { readonly _pos: true };

function freshPos(): Pos {
  return { _pos: true } as Pos;
}

/** Sentinel "no position" — used as the default `endPos` of a never-completed Mem. */
const P_BOTTOM: Pos = freshPos();

/* ─── Tokens ─────────────────────────────────────────────────────────── */

/** A token: `tag` for equality, `sym` for display, `offset` for position. Pattern tokens use `offset: -1`. */
export type Tok = {
  readonly tag: string;
  readonly sym: string;
  readonly offset: number;
};

/** Half-open character span `[start, end)` in the source string. */
export type Span = { readonly start: number; readonly end: number };

const T_EOF: Tok = { tag: "\u0000<EOF>", sym: "<EOF>", offset: -1 };

/* ─── Mem ────────────────────────────────────────────────────────────── */

/** Per-(node, position) memo. Mutable — threads parent contexts and accumulated values. `endPos === P_BOTTOM` means not yet completed. */
export class Mem {
  endPos: Pos = P_BOTTOM;
  values: unknown[] = [];
  /** The `Exp` that owns this memo (set in `goDown`). Used by the derivation sink to look up the production label. */
  exp: Exp | undefined = undefined;
  constructor(readonly startPos: Pos, readonly parents: Cxt[]) {}
}

/* ─── Exp hierarchy ──────────────────────────────────────────────────── */

/** In-focus grammar subexpression. Subclasses implement `descend` for the structural step. */
export abstract class Exp {
  /** Mutable memo: lazily updated as derivation reaches this node at new positions. */
  m: Mem | undefined = undefined;

  /**
   * Optional production label — the `@rule` production name (from `ctx.name`
   * in the `@rule` decorator). Set by `Grammar._ruleSlot`/`_paramRuleSlot`
   * when wrapping a production body in a `DelayedExp`. Only `@rule`
   * productions carry a label; combinators (`AltExp`/`SeqExp`/etc.) leave it
   * `undefined`. Used by the derivation sink to label `DerivationNode`s.
   */
  productionLabel: string | undefined = undefined;

  /**
   * Descend into this Exp under context `parent`. Threads `parent` into
   * existing memo if already visited at this position.
   *
   * **Per-pass memo isolation:** `Exp.m` persists on the grammar node across
   * `parse()`/`recognize()` calls, but each `ZipperDriver` mints fresh `Pos`
   * sentinels and clears `posToOffset` per run. A memo whose `startPos` is not
   * in the current driver's offset map is a stale leftover from a prior pass;
   * it is discarded so the second pass re-derives from scratch. This is the
   * prerequisite for running the engine over the same grammar more than once
   * (multi-pass attribute grammars).
   */
  goDown(driver: ZipperDriver, parent: Cxt): void {
    const m0 = this.m;
    if (m0 && m0.startPos === driver.pos) {
      m0.parents.push(parent);
      // Re-flow all values that have already been produced at this position.
      if (m0.endPos === driver.pos) {
        for (const v of m0.values) parent.goUp(driver, v);
      }
    } else if (m0 && !driver.posToOffset.has(m0.startPos)) {
      // Stale memo from a prior pass — discard and re-derive.
      const m = new Mem(driver.pos, [parent]);
      m.exp = this;
      this.m = m;
      this.descend(driver, m);
    } else {
      const m = new Mem(driver.pos, [parent]);
      m.exp = this;
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
  constructor(readonly tok: Tok) {
    super();
  }
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
  ) {
    super();
  }
  descend(driver: ZipperDriver, m: Mem): void {
    if (this.pred(driver.currentToken.tag)) {
      driver.worklist.push({ mem: m, value: driver.currentToken.tag });
    }
  }
}

/* ─── Structural nodes ───────────────────────────────────────────────── */

/** N-ary sequence with a semantic function. `fn` receives child values in order and returns the combined value. */
export class SeqExp extends Exp {
  constructor(
    readonly sym: string,
    readonly children: readonly Exp[],
    readonly fn: (vals: unknown[]) => unknown = (vs) => vs,
  ) {
    super();
  }

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
  constructor(readonly children: Exp[]) {
    super();
  }
  descend(driver: ZipperDriver, m: Mem): void {
    for (const c of this.children) c.goDown(driver, new AltCxt(m));
  }
}

/** ε — always succeeds with a given semantic value. */
export class EpsilonExp<T = unknown> extends Exp {
  constructor(readonly value: T) {
    super();
  }
  descend(driver: ZipperDriver, m: Mem): void {
    driver.completeAt(m, this.value);
  }
}

/** ∅ — never succeeds. */
export class EmptyExp extends Exp {
  descend(_driver: ZipperDriver, _m: Mem): void {/* no-op */}
}

/** Semantic-action wrapper: applies `fn` to each incoming value. */
export class RedExp<A = unknown, B = unknown> extends Exp {
  constructor(
    readonly inner: Exp,
    readonly fn: (a: A, span: Span) => B,
  ) {
    super();
  }
  descend(driver: ZipperDriver, m: Mem): void {
    this.inner.goDown(
      driver,
      new RedCxt(m, this.fn as (a: unknown, span: Span) => unknown),
    );
  }
}

/** Lazy / forward-reference node — forces its thunk on first descend. Required for `@rule` memoisation and cyclic `many()` grammars. */
export class DelayedExp<T = unknown> extends Exp {
  private _forced: Exp | undefined;
  constructor(private readonly thunk: () => Exp) {
    super();
  }

  force(): Exp {
    if (!this._forced) this._forced = this.thunk();
    return this._forced;
  }

  descend(driver: ZipperDriver, m: Mem): void {
    // Descend the forced body directly under this DelayedExp's own Mem,
    // bypassing the body's goDown memo. This prevents the shared forced
    // body's Mem from accumulating parents across different DelayedExp
    // instances (issue #28): when a @rule getter (e.g., ws) is called at
    // the same position from different call sites, each call site's
    // DelayedExp descends the body independently — the body's goDown
    // re-entry would otherwise re-flow values to the new DelayedExp's Mem,
    // producing duplicate parse results.
    //
    // Left-recursion growth is preserved: when the body references the
    // SAME DelayedExp (via the @rule cache or cyclic many()), that
    // DelayedExp's goDown handles re-entry at the same position
    // (re-flowing seed values). The body's goDown memo is not needed for
    // growth — it operates at the DelayedExp level.
    this.force().descend(driver, m);
  }
}

/**
 * Monadic bind — the L-attributed grammar combinator. Parses `first`, then
 * for each value `v`, calls `fn(v)` to get the second parser. See the README
 * for L-attributed grammar usage.
 */
export class ChainExp<A = unknown, B = unknown> extends Exp {
  constructor(
    readonly first: Exp,
    readonly fn: (a: A) => Exp,
  ) {
    super();
  }

  descend(driver: ZipperDriver, m: Mem): void {
    this.first.goDown(driver, new ChainCxt(m, this.fn as (a: unknown) => Exp));
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
  ) {
    super();
  }

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

/** Inside an alternation — passes values straight through to the parent mem. Used by `AltExp` and `DelayedExp`. */
export class AltCxt extends Cxt {
  constructor(readonly m: Mem) {
    super();
  }
  goUp(driver: ZipperDriver, value: unknown): void {
    driver.completeAt(this.m, value);
  }
}

/** Monadic-bind context: receives `first`'s value, calls `fn` to build the second parser, then flows the pair `[firstVal, secondVal]` upward. */
export class ChainCxt extends Cxt {
  constructor(
    readonly m: Mem,
    readonly fn: (a: unknown) => Exp,
  ) {
    super();
  }

  goUp(driver: ZipperDriver, value: unknown): void {
    // Guard against non-Parser returns from chain callbacks.
    let second: Exp;
    try {
      second = this.fn(value);
    } catch {
      return;
    }
    second.goDown(driver, new ChainSecondCxt(this.m, value));
  }
}

/** Second half of `chain`: receives the second parser's value, emits the pair. */
export class ChainSecondCxt extends Cxt {
  constructor(
    readonly m: Mem,
    readonly firstVal: unknown,
  ) {
    super();
  }
  goUp(driver: ZipperDriver, value: unknown): void {
    driver.completeAt(this.m, [this.firstVal, value]);
  }
}

/** Applies a semantic function to an incoming value, then flows upward. */
export class RedCxt extends Cxt {
  constructor(
    readonly m: Mem,
    readonly fn: (a: unknown, span: Span) => unknown,
  ) {
    super();
  }
  goUp(driver: ZipperDriver, value: unknown): void {
    const start = driver.posToOffset.get(this.m.startPos) ?? 0;
    const end = driver.posToOffset.get(driver.pos) ?? start;
    // Apply the semantic action to the completed value.
    let result: unknown;
    try {
      result = this.fn(value, { start, end });
    } catch {
      return;
    }
    driver.completeAt(this.m, result);
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
  /** Pending (Mem, value) pairs to propagate upward at the next position. */
  worklist: WorklistEntry[] = [];
  /** Completed top-level parse values (the parse forest); reset each pass. */
  topValues: unknown[] = [];
  /** Current position sentinel; minted fresh per token step. */
  pos: Pos = freshPos();
  /** The token currently under the cursor, or `T_EOF` before/after the stream. */
  currentToken: Tok = T_EOF;
  /** When true, only track whether a value was produced (not all values). */
  recognizeOnly = false;
  /**
   * Optional derivation sink: when set, `completeAt` records a
   * `{ label, span, value }` record for each `@rule` production completion
   * (those whose owning `Exp` has a `productionLabel`). `undefined` by
   * default → the common `parse()` path pays zero capture overhead (a single
   * branch on `undefined`). Set by `Grammar.parseToTree` (via
   * `parseWithDerivation`) to materialise the derivation.
   *
   * A `seq` number (completion order) is assigned by `parseWithDerivation`
   * when collecting records. Since the engine completes children before
   * parents (bottom-up), a parent's `seq` is always greater than its
   * children's. This lets `buildDerivationTrees` reconstruct the true
   * hierarchy even when multiple productions complete at the same span
   * (e.g. passthrough productions `expr → term → factor`).
   */
  derivationSink:
    | ((
      record: {
        readonly label: string;
        readonly span: Span;
        readonly value?: unknown;
      },
    ) => void)
    | undefined = undefined;
  /** Maps each Pos sentinel to its 0-based character offset in the source. */
  readonly posToOffset: Map<Pos, number> = new Map<Pos, number>();
  /** Reverse lookup: offset → Pos. Maintained alongside {@link posToOffset} for O(1) {@link stepReplay}. */
  readonly offsetToPosMap: Map<number, Pos> = new Map<number, Pos>();
  /**
   * Base offset of the initial position. Defaults to 0; set to a non-zero
   * value (e.g. via {@link withInitialOffset}) when parsing a segment of a
   * larger source so that `posToOffset` — and hence spans in semantic
   * actions — map directly to absolute source coordinates.
   */
  initialOffset = 0;

  /**
   * Set the base offset of the initial position and return `this` for
   * chaining. Use when parsing a segment of a larger source so spans land
   * in absolute coordinates. Must be called before `parse`/`recognize`.
   */
  withInitialOffset(offset: number): this {
    this.initialOffset = offset;
    return this;
  }

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
    // Derivation capture: record a DerivationRecord for @rule productions.
    // Only Exp nodes with a `productionLabel` (set by @rule via
    // _ruleSlot/_paramRuleSlot) are recorded; combinators contribute
    // spans/children only. The sink is undefined on the default parse()
    // path, so this is a no-op branch. A sequence number is assigned to
    // each record to preserve completion order for hierarchy reconstruction.
    const sink = this.derivationSink;
    if (
      sink !== undefined && mem.exp !== undefined &&
      mem.exp.productionLabel !== undefined
    ) {
      const start = this.posToOffset.get(mem.startPos) ?? 0;
      const end = this.posToOffset.get(this.pos) ?? start;
      sink({ label: mem.exp.productionLabel, span: { start, end }, value });
    }
    for (const c of mem.parents) c.goUp(this, value);
  }

  /** Consume one token, advancing the worklist by one position. */
  step(token: Tok): void {
    this.currentToken = token;
    const w = this.worklist;
    this.worklist = [];
    this.topValues = [];
    for (const { mem, value } of w) this.completeAt(mem, value);
    const next = freshPos();
    const offset = token.offset + 1;
    this.posToOffset.set(next, offset);
    this.offsetToPosMap.set(offset, next);
    this.pos = next;
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
    this._init(start);
    this.recognizeOnly = true; // suppress duplicate completions for polynomial time
    this._runSteps(tokens);
    return this.topValues.length > 0;
  }

  /**
   * Parse `tokens` against the grammar rooted at `start`.
   * Returns the set of all semantic values (parse forest).
   */
  parse<T>(start: Exp, tokens: Iterable<Tok>): Set<T> {
    this._init(start);
    this._runSteps(tokens);
    return new Set(this.topValues as T[]);
  }

  /**
   * Parse `tokens` while capturing the derivation as a list of
   * {@link DerivationRecord}s (one per `@rule` production completion).
   * Returns the parse forest and the captured records.
   *
   * The sink is set before parsing and cleared after, so the default
   * `parse()`/`recognize()` paths are unaffected. Only `@rule` productions
   * (whose `Exp.productionLabel` is set) are recorded; combinators contribute
   * spans/children only.
   */
  parseWithDerivation<T>(
    start: Exp,
    tokens: Iterable<Tok>,
  ): {
    readonly forest: Set<T>;
    readonly records: readonly {
      readonly label: string;
      readonly span: Span;
      readonly value?: unknown;
      readonly seq: number;
    }[];
  } {
    let seq = 0;
    const records: {
      label: string;
      span: Span;
      value?: unknown;
      seq: number;
    }[] = [];
    this.derivationSink = (r) => records.push({ ...r, seq: seq++ });
    this._init(start);
    this._runSteps(tokens);
    this.derivationSink = undefined;
    return { forest: new Set(this.topValues as T[]), records };
  }

  /** Drain `tokens` through the engine, then flush with EOF. */
  private _runSteps(tokens: Iterable<Tok>): void {
    for (const t of tokens) this.step(t);
    // EOF flush: drain any final reductions to the top.
    this.step(T_EOF);
  }

  /**
   * Initialise the driver for a stepwise parse rooted at `start`.
   *
   * This is the entry point for the **token-stream API** — the
   * derivative-as-continuation primitive. After `init`, call {@link step}
   * once per token (feeding input as it arrives), then {@link flushEof} to
   * drain final reductions, then {@link forest} to read the results. The
   * live driver is the resumable continuation: pause when input is
   * exhausted, resume when more arrives — no snapshot needed.
   *
   * @param start  The grammar's root `Exp` to drive.
   * @param options  Optional configuration.
   * @param options.keepMemoMap  When `true`, preserve the existing
   *   `posToOffset`/`offsetToPosMap` so {@link stepReplay} can reuse prior-pass
   *   `Pos` sentinels for memo hits. Used by {@link Grammar.reparseIncremental}.
   *   Default `false` (clears the maps for a fresh pass).
   */
  init(start: Exp, options?: { readonly keepMemoMap?: boolean }): void {
    this._init(start, options?.keepMemoMap ?? false);
  }

  /**
   * Flush the engine with an EOF token, draining any final reductions to
   * the top. Call after the last {@link step} to complete the parse.
   */
  flushEof(): void {
    this.step(T_EOF);
  }

  /**
   * Return the parse forest accumulated so far. Each call returns a fresh
   * snapshot `Set` of the values produced at the top. For a stepwise parse,
   * call after {@link flushEof} for the final result, or mid-stream for
   * partial results.
   */
  forest<T>(): Set<T> {
    return new Set(this.topValues as T[]);
  }

  /* ── Incremental memo reuse ──────────────────────────────────────── */
  //
  // The derivative's self-containment means re-parsing an unchanged prefix
  // reaches the same `Exp` nodes at the same positions — so `Exp.m` memos
  // from the prior pass are still valid. The key to reusing them: the memo
  // hit test is `m0.startPos === driver.pos` (object identity of `Pos`). A
  // fresh `step` mints a new `Pos`, breaking the match. `stepReplay` instead
  // looks up the existing `Pos` for the token's offset (if present) and
  // reuses it, so prior-pass memos hit. Only the edited region (new offsets)
  // mints fresh `Pos`.

  /**
   * Consume one token, reusing the existing `Pos` for `token.offset` if the
   * driver has already visited that offset in a prior pass. This lets
   * `Exp.m` memos from the prior pass hit on the unchanged prefix, so only
   * the edited region is re-derived — O(affected region) re-parsing.
   *
   * Use this instead of {@link step} when re-parsing after a small edit:
   * feed the unchanged prefix tokens via `stepReplay` (memo hits), then feed
   * the edited-region tokens via {@link step} (fresh `Pos`, re-derive), then
   * the unchanged suffix via `stepReplay` again.
   */
  stepReplay(token: Tok): void {
    this.currentToken = token;
    const w = this.worklist;
    this.worklist = [];
    this.topValues = [];
    for (const { mem, value } of w) this.completeAt(mem, value);
    // Reuse the existing Pos for this offset if present; else mint fresh.
    const offset = token.offset + 1;
    const existing = this.offsetToPosMap.get(offset);
    if (existing) {
      this.pos = existing;
    } else {
      const next = freshPos();
      this.posToOffset.set(next, offset);
      this.offsetToPosMap.set(offset, next);
      this.pos = next;
    }
  }

  private _init(start: Exp, keepMemoMap = false): void {
    this.topValues = [];
    // Reset to full-forest mode so a reused driver doesn't leak the
    // recognize() suppression flag into a later parse().
    this.recognizeOnly = false;
    if (!keepMemoMap) {
      this.posToOffset.clear();
      this.offsetToPosMap.clear();
    }
    const initialPos = freshPos();
    this.posToOffset.set(initialPos, this.initialOffset);
    this.offsetToPosMap.set(this.initialOffset, initialPos);
    this.pos = initialPos;
    this.currentToken = T_EOF;
    // Bootstrap: a top-level Mem collects the result; a SeqCxt descends into
    // `start` on the first step(). The seed dummy value lands at index 0, so
    // fn extracts index 1.
    const mTop = new Mem(P_BOTTOM, [new TopCxt()]);
    const mSeq = new Mem(P_BOTTOM, [
      new SeqCxt(mTop, (vs) => vs[1]!, [], [start]),
    ]);
    this.worklist = [{ mem: mSeq, value: undefined }];
  }
}

/** Stand-alone recognition entry point — convenience wrapper around a fresh `ZipperDriver`. */
export function recognize(tokens: Iterable<Tok>, start: Exp): boolean {
  return new ZipperDriver().recognize(start, tokens);
}
