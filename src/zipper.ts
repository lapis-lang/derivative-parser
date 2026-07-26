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
  constructor(readonly startPos: Pos, readonly parents: Cxt[]) {}
}

/* ─── Exp hierarchy ──────────────────────────────────────────────────── */

/** In-focus grammar subexpression. Subclasses implement `descend` for the structural step. */
export abstract class Exp {
  /** Mutable memo: lazily updated as derivation reaches this node at new positions. */
  m: Mem | undefined = undefined;

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
      this.m = m;
      this.descend(driver, m);
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

/* ─── Tree tokens (for tree-consuming grammars) ──────────────────────── */

/**
 * A tree token: one node in a flattened tree-token stream consumed by
 * {@link TreeExp}. `tag` is the node's class name (matched by `TreeExp`),
 * `node` carries the original tree node, `arity` is the number of child
 * tokens, and `subtreeSize` is the total number of tokens in this node's
 * subtree (1 + all descendants). `offset` is the 0-based position in the
 * stream. `subtreeSize` lets {@link TreeExp} complete at the position
 * immediately after the matched subtree, mirroring how `TokExp` completes at
 * the next character position.
 */
export type TreeTok = {
  readonly tag: string;
  readonly node: unknown;
  readonly arity: number;
  readonly subtreeSize: number;
  readonly offset: number;
};

/**
 * Flatten a tree into a stream of {@link TreeTok}s in preorder, tagging each
 * node with its constructor/class name and recording its child count and
 * subtree size. The stream is consumed by {@link ZipperDriver.parseTree} /
 * {@link TreeExp}.
 *
 * `childrenOf` extracts a node's children by class name; supply a function
 * returning the node's child array.
 */
export function flattenTree(
  root: unknown,
  childrenOf: (node: unknown, tag: string) => readonly unknown[],
): TreeTok[] {
  const out: TreeTok[] = [];
  let offset = 0;
  const visit = (node: unknown): number => {
    const tag = node?.constructor?.name ?? "Object";
    const kids = childrenOf(node, tag);
    const myOffset = offset++;
    let size = 1;
    for (const k of kids) size += visit(k);
    out.push({
      tag,
      node,
      arity: kids.length,
      subtreeSize: size,
      offset: myOffset,
    });
    return size;
  };
  visit(root);
  // Tokens are pushed post-recurse (after children), so the array is in
  // postorder despite offsets being assigned preorder. Re-sort by offset to
  // restore preorder for positional matching by TreeExp.
  out.sort((a, b) => a.offset - b.offset);
  return out;
}

/**
 * Tree-schema match: matches a single tree node by class name and dispatches
 * to child sub-parsers by position. The semantic value is built from the
 * child values via `fn`.
 *
 * `tag` is the class name to match against the current tree token. `children`
 * are the sub-parsers for each child slot (positional). `fn` combines the
 * child values and the matched node into the production's semantic value.
 *
 * On `descend`, if the current tree token's `tag` matches and it has at least
 * `children.length` children, the first child parser is descended at the
 * position of the first child token. Each child completion advances to the
 * next child's position. When all children are done, the production completes
 * at the position **after the matched subtree** (computed from `subtreeSize`),
 * so the parent's next sibling sees the cursor past this whole subtree. This
 * mirrors how `TokExp` completes at the next character position.
 *
 * If `children.length` is less than the node's `arity`, the extra children
 * are skipped (the cursor advances past their subtrees) — this lets a
 * production match a node without consuming every child, as when a lambda
 * captures its body unevaluated.
 */
export class TreeExp extends Exp {
  constructor(
    readonly tag: string,
    readonly children: readonly Exp[],
    readonly fn: (node: unknown, childVals: unknown[]) => unknown = (
      _node,
      vs,
    ) => vs,
  ) {
    super();
  }
  /** Match the current tree token by class name and dispatch to child sub-parsers. */
  descend(driver: ZipperDriver, m: Mem): void {
    const tok = driver.currentTreeToken;
    if (tok === undefined || tok.tag !== this.tag) return;
    if (tok.arity < this.children.length) return;
    // Position after this entire subtree — where the production completes.
    const endOffset = tok.offset + tok.subtreeSize;
    if (this.children.length === 0) {
      // No children to parse: complete immediately at the post-subtree pos.
      driver.scheduleTreeCompletion(m, this.fn(tok.node, []), endOffset);
      return;
    }
    // Descend into the first child at the first child's token position.
    const [head, ...rest] = this.children;
    driver.descendTreeChild(
      head!,
      new TreeSeqCxt(m, this.fn, tok.node, [], rest, endOffset),
      tok.offset + 1,
    );
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
    // Delegate to the forced node, forwarding values upward through mem.
    this.force().goDown(driver, new AltCxt(m));
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

/**
 * Sequence context over tree-token children. Like {@link SeqCxt} but carries
 * the matched tree node (for `fn`) and the end offset (where the production
 * completes after all children). On each child completion, advances to the
 * next child's position; after the last child, completes at `endOffset`.
 */
class TreeSeqCxt extends Cxt {
  constructor(
    readonly m: Mem,
    readonly fn: (node: unknown, childVals: unknown[]) => unknown,
    readonly node: unknown,
    readonly revLeftVals: readonly unknown[],
    readonly right: readonly Exp[],
    readonly endOffset: number,
  ) {
    super();
  }
  goUp(driver: ZipperDriver, value: unknown): void {
    if (this.right.length === 0) {
      const vals = [...this.revLeftVals].reverse();
      vals.push(value);
      driver.scheduleTreeCompletion(
        this.m,
        this.fn(this.node, vals),
        this.endOffset,
      );
    } else {
      const [next, ...restRight] = this.right;
      // The just-completed child consumed its subtree; advance to the next
      // child's position, which is the current cursor offset (the completion
      // landed at the post-subtree offset of the just-completed child).
      driver.descendTreeChild(
        next!,
        new TreeSeqCxt(
          this.m,
          this.fn,
          this.node,
          [value, ...this.revLeftVals],
          restRight,
          this.endOffset,
        ),
        driver.treeCursorOffset,
      );
    }
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
  worklist: WorklistEntry[] = [];
  topValues: unknown[] = [];
  pos: Pos = freshPos();
  currentToken: Tok = T_EOF;
  /** When true, only track whether a value was produced (not all values). */
  recognizeOnly = false;
  /** Maps each Pos sentinel to its 0-based character offset in the source. */
  readonly posToOffset: Map<Pos, number> = new Map<Pos, number>();

  /* ── Tree-token stream state (for tree-consuming grammars) ────────── */
  //
  // Tree parsing uses a position-per-tree-token model mirroring character
  // parsing: each tree token gets a fresh `Pos` (recorded in `posToOffset`),
  // and `TreeExp` completions land at the position after the matched subtree.
  // `treeCursorOffset` is the 0-based index of the token currently under the
  // cursor; `currentTreeToken` is that token or `undefined` past the end.
  // Completions are scheduled at a target offset via `scheduleTreeCompletion`
  // and drained by `_runTreeSteps`, which processes one offset at a time.
  private treeTokens: readonly TreeTok[] = [];
  /** 0-based index of the tree token currently under the cursor. */
  treeCursorOffset = 0;
  /** The tree token currently under the cursor, or `undefined` past end. */
  currentTreeToken: TreeTok | undefined = undefined;
  /** Pending tree completions keyed by target offset. */
  private treePending: Map<number, { mem: Mem; value: unknown }[]> = new Map();

  /** Set the cursor at `offset`, minting a fresh `Pos` for memoisation. */
  private setTreeCursor(offset: number): void {
    this.treeCursorOffset = offset;
    const next = freshPos();
    this.posToOffset.set(next, offset);
    this.pos = next;
    this.currentTreeToken = this.treeTokens[offset];
  }

  /**
   * Schedule a completion of `mem` with `value` at the tree position
   * `targetOffset` (the position after the matched subtree). The completion
   * is drained by `_runTreeSteps` when the cursor reaches that offset.
   */
  scheduleTreeCompletion(mem: Mem, value: unknown, targetOffset: number): void {
    let bucket = this.treePending.get(targetOffset);
    if (!bucket) {
      bucket = [];
      this.treePending.set(targetOffset, bucket);
    }
    bucket.push({ mem, value });
  }

  /**
   * Descend into `child` parser at the tree position `offset`, setting the
   * cursor there so the child's `TreeExp` matches the correct token.
   */
  descendTreeChild(child: Exp, parent: Cxt, offset: number): void {
    this.setTreeCursor(offset);
    child.goDown(this, parent);
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
    this.posToOffset.set(next, token.offset + 1);
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
   * Parse a tree-token stream against the grammar rooted at `start`.
   *
   * The stream is consumed using a position-per-tree-token model that
   * mirrors character parsing: each tree token gets a fresh position, and
   * {@link TreeExp} completions land at the position after the matched
   * subtree (computed from `subtreeSize`). The driver drains pending
   * completions offset by offset, so memoisation and per-pass isolation work
   * exactly as for character streams. Returns the set of all semantic values
   * produced at the top.
   *
   * `childrenOf` extracts a node's children by class name; use
   * {@link flattenTree} to build the stream.
   */
  parseTree<T>(start: Exp, treeTokens: readonly TreeTok[]): Set<T> {
    this._initTree(start, treeTokens);
    this._runTreeSteps();
    return new Set(this.topValues as T[]);
  }

  /**
   * Drive the tree parse: process pending completions offset by offset.
   * The bootstrap seeds the root at offset 0; each `TreeExp` schedules
   * completions at the post-subtree offset via `scheduleTreeCompletion`.
   * Completions are always scheduled at strictly increasing offsets (a
   * subtree completes after all its children), so `treePending`'s insertion
   * order is ascending — we drain in insertion order without scanning for
   * the minimum, avoiding O(n²) on large trees.
   */
  private _runTreeSteps(): void {
    // The bootstrap worklist holds the seed; flush it at offset 0 to kick
    // off the root TreeExp match.
    this._flushTreeOffset(0);
    // Drain remaining pending offsets in insertion order (== ascending).
    while (this.treePending.size > 0) {
      const nextOffset = this.treePending.keys().next().value as number;
      this._flushTreeOffset(nextOffset);
    }
  }

  /**
   * Flush all pending completions scheduled at `offset`, setting the cursor
   * there. Does NOT reset `topValues` — top-level results accumulate across
   * offsets so that a grammar producing results at multiple positions isn't
   * silently lost. `topValues` is reset once in `_initTree`.
   */
  private _flushTreeOffset(offset: number): void {
    const bucket = this.treePending.get(offset);
    if (!bucket) return;
    this.treePending.delete(offset);
    this.setTreeCursor(offset);
    // Save the flush position: child descents (descendTreeChild) change
    // this.pos mid-loop, so restore it before each completeAt so every
    // completion in this bucket lands at this offset's position.
    const flushPos = this.pos;
    for (const { mem, value } of bucket) {
      this.pos = flushPos;
      this.currentTreeToken = this.treeTokens[offset];
      this.completeAt(mem, value);
    }
  }

  private _initTree(start: Exp, treeTokens: readonly TreeTok[]): void {
    this.topValues = [];
    this.recognizeOnly = false;
    this.posToOffset.clear();
    this.treeTokens = treeTokens;
    this.treeCursorOffset = 0;
    this.treePending = new Map();
    const initialPos = freshPos();
    this.posToOffset.set(initialPos, 0);
    this.pos = initialPos;
    this.currentTreeToken = treeTokens[0];
    this.currentToken = T_EOF;
    const mTop = new Mem(P_BOTTOM, [new TopCxt()]);
    const mSeq = new Mem(P_BOTTOM, [
      new SeqCxt(mTop, (vs) => vs[1]!, [], [start]),
    ]);
    // Seed: at offset 0, process the bootstrap sequence so `start` descends
    // and the root TreeExp matches the first tree token.
    this.treePending.set(0, [{ mem: mSeq, value: undefined }]);
  }

  /** Drain `tokens` through the engine, then flush with EOF. */
  private _runSteps(tokens: Iterable<Tok>): void {
    for (const t of tokens) this.step(t);
    // EOF flush: drain any final reductions to the top.
    this.step(T_EOF);
  }

  private _init(start: Exp): void {
    this.topValues = [];
    // Reset to full-forest mode so a reused driver doesn't leak the
    // recognize() suppression flag into a later parse().
    this.recognizeOnly = false;
    this.posToOffset.clear();
    const initialPos = freshPos();
    this.posToOffset.set(initialPos, 0);
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
