/**
 * Top-down, grammar-driven program generation — the dual of parsing.
 *
 * Where {@link ZipperDriver} consumes tokens bottom-up to build parse trees,
 * the generator walks the `Exp` tree **top-down**, emitting tokens and
 * computing semantic values. This is L-system style expansion: starting from
 * an initial production (axiom), the generator expands non-terminals until
 * terminals are reached, producing a value, a token stream, and a
 * {@link DerivationTree}.
 *
 * The generator is the structural foundation for:
 * - **Property-Based Testing** — generate random well-formed terms
 *   (see {@link ../property.ts} for the `forAll` runner).
 * - **Metatheory Verification** (#38) — synthesize well-typed terms for
 *   Progress/Preservation counterexample search.
 * - **Unparsing** — generate then pretty-print (see {@link ../unparse.ts}).
 *
 * @module
 */

import type { Parser } from "./Parser.ts";
import {
  AltExp,
  ChainExp,
  DelayedExp,
  EmptyExp,
  EpsilonExp,
  type Exp,
  PredTokExp,
  RedExp,
  SeqExp,
  type Tok,
  TokExp,
} from "./zipper.ts";
import { DerivationNode, DerivationTree } from "./derivation.ts";

/* ======================================================================
 *  RNG — a tiny, seedable PRNG (xorshift128)
 * ====================================================================== */

/**
 * A seedable pseudo-random number generator. xorshift128 — fast, full-period,
 * good statistical quality for generation purposes. Not cryptographic.
 *
 * Seed reproducibility: two `RNG`s created with the same seed produce the
 * same sequence, so a failing property test can be replayed exactly.
 */
export class RNG {
  private state: [number, number, number, number];
  constructor(seed: number) {
    // Spread the seed across the 4 state words (avoid all-zero state).
    const s = seed | 0 || 1;
    this.state = [s, s ^ 0x6d2b79f5, (s << 13) ^ 0xdeadbeef, s ^ 0x9e3779b9];
    // Warm up — mix the state to avoid short initial cycles.
    for (let i = 0; i < 20; i++) this.next();
  }
  /** Next unsigned 32-bit integer. */
  next(): number {
    let [x, y, z, w] = this.state;
    const t = x ^ (x << 11);
    x = y;
    y = z;
    z = w;
    w = w ^ (w >>> 19) ^ (t ^ (t >>> 8));
    this.state = [x, y, z, w];
    return w >>> 0;
  }
  /** Float in `[0, 1)`. */
  float(): number {
    return this.next() / 0x100000000;
  }
  /** Integer in `[0, n)`. */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }
  /** Pick a random element from a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }
  /** Boolean with probability `p` of being `true` (default 0.5). */
  bool(p = 0.5): boolean {
    return this.float() < p;
  }
}

/* ======================================================================
 *  Options & result
 * ====================================================================== */

/** Default character alphabet for `PredTokExp` sampling. */
export const DEFAULT_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ \t";

/** Branch selection strategy for `AltExp` branch ordering. */
export type BranchStrategy =
  /**
   * Depth-first: try recursive (non-terminal) branches first, terminals last.
   * Produces deterministic L-system expansion — the recursive branch is
   * preferred until the depth/recursion budget is exhausted, then the
   * terminal base case is used. This is the default, matching the L-system
   * use case and the needs of metatheory verification (#38), which requires
   * systematic enumeration of well-typed terms.
   */
  | "depth-first"
  /**
   * Breadth-first: try terminal (base-case) branches first, recursive
   * branches last. Produces the minimal derivation — the simplest possible
   * term at each choice point. The dual of depth-first: where depth-first
   * expands maximally, breadth-first expands minimally.
   */
  | "breadth-first"
  /**
   * Random: shuffle branches so the search explores in random order.
   * Produces diverse samples for property-based testing — each seed yields
   * a different derivation. Use this when you want varied random generation
   * rather than deterministic expansion.
   */
  | "random";

/** Shared defaults for `GeneratorOptions`. */
export const defaultGeneratorOptions = (): Required<GeneratorOptions> => ({
  maxDepth: 6,
  maxRecursion: 2,
  seed: 0,
  alphabet: DEFAULT_ALPHABET,
  maxBacktracks: 50,
  maxSteps: 10000,
  branchStrategy: "depth-first",
  maxShrinkCandidates: 20,
  shrinkAttempts: 3,
});

/** Options controlling top-down generation. */
export interface GeneratorOptions {
  /** Maximum derivation depth (number of `DelayedExp`/`AltExp` descents). Default: `6`. */
  maxDepth?: number;
  /**
   * Maximum number of times a single recursive `DelayedExp` may be re-entered
   * on the current generation path. Prevents infinite expansion of recursive
   * productions. Default: `2`.
   */
  maxRecursion?: number;
  /** The random seed for reproducible generation. Same seed → same output. Default: `0`. */
  seed?: number;
  /**
   * The character alphabet for sampling `PredTokExp` terminals. The generator
   * picks characters from this string that satisfy the predicate. Default:
   * alphanumeric + whitespace.
   */
  alphabet?: string;
  /**
   * Maximum number of backtracks before giving up on a branch. Generation is
   * a search; when a branch leads to `EmptyExp` or exceeds depth, the
   * generator backtracks and tries another `AltExp` branch. Default: `50`.
   */
  maxBacktracks?: number;
  /**
   * Maximum total number of `Exp`-walk steps before aborting. A safety net
   * against infinite loops in grammars with unbounded recursive lexemes
   * (e.g. `digits()` creates a fresh `DelayedExp` per call, so per-node
   * recursion tracking alone can't cap it). Default: `10000`.
   */
  maxSteps?: number;
  /**
   * Branch selection strategy for `AltExp` branch ordering. Default:
   * `"depth-first"` (recursive branches first, terminals last — deterministic
   * L-system expansion). Use `"random"` for diverse property-based testing
   * samples.
   */
  branchStrategy?: BranchStrategy;
  /**
   * Maximum number of shrink candidates to generate per `shrink()` call.
   * The shrinker tries `maxDepth * shrinkAttempts` generations and stops
   * early once this many unique candidates are found. Default: `20`.
   */
  maxShrinkCandidates?: number;
  /**
   * Number of seeds to try per depth level during shrinking. Default: `3`.
   */
  shrinkAttempts?: number;
}

/** The result of a successful generation. */
export interface GeneratorResult<T> {
  /** The generated semantic value (the parse-tree value the production yields). */
  value: T;
  /** The token stream emitted by the generation (the source text as tokens). */
  tokens: Tok[];
  /** The retained derivation tree (which productions matched where). */
  tree: DerivationTree;
}

/* ======================================================================
 *  Generation context
 * ====================================================================== */

/** Internal state carried through a top-down generation walk. */
interface GenState {
  readonly rng: RNG;
  readonly alphabet: string;
  /** Remaining depth budget. When this hits 0, only terminals/epsilon are allowed. */
  depth: number;
  /** Map from `DelayedExp` → number of times re-entered on the current path. */
  readonly recursionCounts: Map<DelayedExp, number>;
  /** Emitted tokens so far (in order). */
  readonly tokens: Tok[];
  /** Cumulative character offset — the length of the source string so far. */
  charOffset: number;
  /** Cache of `PredTokExp` → matching alphabet chars, keyed by exp identity. */
  readonly predCache: Map<PredTokExp, string[]>;
  /** Derivation records (label, span, value, seq) for building the tree. */
  readonly records: {
    label: string;
    start: number;
    end: number;
    value: unknown;
    seq: number;
  }[];
  /** Monotonic seq counter for derivation records. */
  seq: number;
  /** Backtracks remaining. */
  backtracks: number;
  /** Total walk steps taken (safety cap). */
  steps: number;
}

/* ======================================================================
 *  Generation failure
 * ====================================================================== */

/** Thrown when generation cannot complete within the given budget. */
export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

/** Sentinel thrown internally to trigger a backtrack (caught by `AltExp`). */
class Backtrack extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "Backtrack";
  }
}

/* ======================================================================
 *  The generator
 * ====================================================================== */

/**
 * Top-down generator — walks an `Exp` tree, emitting tokens and computing
 * semantic values. The dual of the bottom-up {@link ZipperDriver}.
 *
 * Generation is a **search**: at an `AltExp`, a branch is chosen (random or
 * type-directed). If a branch leads to `EmptyExp` or exceeds the depth/
 * recursion budget, a {@link Backtrack} is thrown and the next branch is
 * tried. If all branches are exhausted, the backtrack propagates to the
 * enclosing `AltExp` (or fails the whole generation if at the top level).
 */
export class Generator {
  private readonly opts: Required<GeneratorOptions>;

  constructor(options: GeneratorOptions = {}) {
    this.opts = { ...defaultGeneratorOptions(), ...options };
  }

  /**
   * Generate a value from `start`, emitting tokens and building a derivation
   * tree. Throws {@link GenerationError} if no derivation completes within
   * the budget.
   */
  generate<T>(start: Parser<T>): GeneratorResult<T> {
    const state: GenState = {
      rng: new RNG(this.opts.seed),
      alphabet: this.opts.alphabet,
      depth: this.opts.maxDepth,
      recursionCounts: new Map(),
      tokens: [],
      charOffset: 0,
      predCache: new Map(),
      records: [],
      seq: 0,
      backtracks: this.opts.maxBacktracks,
      steps: 0,
    };
    let value: T;
    try {
      value = this.walk(start._exp, state) as T;
    } catch (e) {
      // Convert any uncaught Backtrack (the internal sentinel) into a
      // GenerationError with a helpful message. Backtrack should never
      // escape walkAlt (it catches all branches), but it can propagate
      // from the top-level if the start production itself is infeasible.
      if (e instanceof Backtrack) {
        throw new GenerationError(
          `generation failed: ${e.reason}. ` +
            `Try increasing maxDepth (currently ${this.opts.maxDepth}), ` +
            `maxRecursion (currently ${this.opts.maxRecursion}), or ` +
            `maxBacktracks (currently ${this.opts.maxBacktracks}).`,
        );
      }
      throw e;
    }
    const tree = this.buildTree(state);
    return { value, tokens: state.tokens, tree };
  }

  /* ── Exp walker ──────────────────────────────────────────────────── */

  private walk(exp: Exp, state: GenState): unknown {
    // Step cap — prevents infinite loops in grammars with unbounded recursive
    // lexemes (e.g. `digits()` creates a fresh DelayedExp per call).
    if (++state.steps > this.opts.maxSteps) {
      throw new GenerationError(
        `maxSteps (${this.opts.maxSteps}) exceeded — the grammar may have unbounded recursion at this depth.`,
      );
    }
    // Terminal: exact token match — emit the token.
    if (exp instanceof TokExp) {
      const tok = exp.tok;
      const offset = state.tokens.length;
      state.tokens.push({ tag: tok.tag, sym: tok.sym, offset });
      state.charOffset += tok.sym.length;
      return tok.tag;
    }

    // Terminal: predicate-based — sample a char from the alphabet.
    if (exp instanceof PredTokExp) {
      let candidates = state.predCache.get(exp);
      if (candidates === undefined) {
        candidates = [...state.alphabet].filter(exp.pred);
        state.predCache.set(exp, candidates);
      }
      if (candidates.length === 0) {
        throw new Backtrack(`no alphabet char satisfies ${exp.label}`);
      }
      const c = state.rng.pick(candidates);
      const offset = state.tokens.length;
      state.tokens.push({ tag: c, sym: c, offset });
      state.charOffset += c.length;
      return c;
    }

    // Epsilon — succeed with the value, no tokens.
    if (exp instanceof EpsilonExp) {
      return exp.value;
    }

    // Empty — fail (backtrack).
    if (exp instanceof EmptyExp) {
      throw new Backtrack("EmptyExp — generation failed");
    }

    // Alternation — pick a branch (random, with depth/recursion filtering).
    if (exp instanceof AltExp) {
      return this.walkAlt(exp, state);
    }

    // Sequence — generate each child in order, apply fn.
    if (exp instanceof SeqExp) {
      return this.walkSeq(exp, state);
    }

    // RedExp — generate inner, apply semantic action with synthetic span.
    if (exp instanceof RedExp) {
      const start = state.charOffset;
      const inner = this.walk(exp.inner, state);
      const end = state.charOffset;
      return exp.fn(inner as never, { start, end } as never);
    }

    // DelayedExp — force, track recursion, label derivation node.
    if (exp instanceof DelayedExp) {
      return this.walkDelayed(exp, state);
    }

    // ChainExp — generate first, call fn(value) to get next Exp, generate it.
    if (exp instanceof ChainExp) {
      return this.walkChain(exp, state);
    }

    throw new GenerationError(
      `walk: unknown Exp subtype ${exp.constructor.name}`,
    );
  }

  /* ── AltExp: branch selection with backtracking ─────────────────── */

  private walkAlt(exp: AltExp, state: GenState): unknown {
    // Filter branches by feasibility (depth & recursion budget).
    const feasible = exp.children.filter((c) => this.isFeasible(c, state));
    const candidates = feasible.length > 0 ? feasible : exp.children;
    // Order branches by the selected strategy.
    const order = this.opts.branchStrategy === "random"
      ? this.shuffleIndices(candidates.length, state.rng)
      : this.orderBranches(candidates, this.opts.branchStrategy);

    let lastReason: string | null = null;
    for (const idx of order) {
      const child = candidates[idx]!;
      // Snapshot for backtrack.
      const snap = this.snapshot(state);
      try {
        return this.walk(child, state);
      } catch (e) {
        if (e instanceof Backtrack) {
          lastReason = e.reason;
          this.restore(state, snap);
          if (state.backtracks-- <= 0) {
            throw new Backtrack(
              `maxBacktracks exhausted in AltExp: ${e.reason}`,
            );
          }
          continue;
        }
        throw e;
      }
    }
    throw new Backtrack(
      `all ${candidates.length} branches failed in AltExp${
        lastReason ? ` (last: ${lastReason})` : ""
      }`,
    );
  }

  /* ── SeqExp: ordered children ────────────────────────────────────── */

  private walkSeq(exp: SeqExp, state: GenState): unknown {
    // Fold over children left-to-right, collecting generated values.
    return exp.fn(exp.children.map((c) => this.walk(c, state)));
  }

  /* ── DelayedExp: force, recursion-track, derivation label ────────── */

  private walkDelayed(exp: DelayedExp, state: GenState): unknown {
    // Recursion budget check.
    const count = state.recursionCounts.get(exp) ?? 0;
    if (count >= this.opts.maxRecursion) {
      throw new Backtrack(
        `recursion limit (${this.opts.maxRecursion}) reached for production${
          exp.productionLabel ? ` "${exp.productionLabel}"` : ""
        }`,
      );
    }
    state.recursionCounts.set(exp, count + 1);
    state.depth--;

    const start = state.charOffset;
    const label = exp.productionLabel ?? "";
    let value: unknown;
    try {
      value = this.walk(exp.force(), state);
    } finally {
      state.depth++;
      state.recursionCounts.set(exp, count); // restore on unwind
    }
    const end = state.charOffset;

    // Record a derivation node if this is a labeled production.
    if (label) {
      state.records.push({
        label,
        start,
        end,
        value,
        seq: state.seq++,
      });
    }
    return value;
  }

  /* ── ChainExp: L-attributed bind ─────────────────────────────────── */

  private walkChain(exp: ChainExp, state: GenState): unknown {
    const firstVal = this.walk(exp.first, state);
    let second: Exp;
    try {
      second = exp.fn(firstVal as never);
    } catch {
      throw new Backtrack("chain fn threw — branch infeasible");
    }
    const secondVal = this.walk(second, state);
    return [firstVal, secondVal];
  }

  /* ── Feasibility check ───────────────────────────────────────────── */

  /**
   * Quick check whether `exp` can be generated without exceeding the depth
   * or recursion budget. Conservative: returns `true` if unsure.
   */
  private isFeasible(exp: Exp, state: GenState): boolean {
    if (state.depth <= 0) {
      // Only allow terminals and epsilon at depth 0.
      return (
        exp instanceof TokExp || exp instanceof PredTokExp ||
        exp instanceof EpsilonExp ||
        (exp instanceof DelayedExp && this.isTerminalProduction(exp))
      );
    }
    if (exp instanceof DelayedExp) {
      const count = state.recursionCounts.get(exp) ?? 0;
      if (count >= this.opts.maxRecursion) return false;
    }
    return true;
  }

  /** Does a `DelayedExp` force to a terminal-only production (no recursion)? */
  private isTerminalProduction(exp: DelayedExp): boolean {
    return this.isTerminalExp(exp.force(), new Set<DelayedExp>([exp]));
  }

  /** Is `exp` a terminal/epsilon (no further non-terminal expansion)? */
  private isTerminalExp(exp: Exp, visited?: Set<DelayedExp>): boolean {
    if (
      exp instanceof TokExp || exp instanceof PredTokExp ||
      exp instanceof EpsilonExp || exp instanceof EmptyExp
    ) {
      return true;
    }
    if (exp instanceof RedExp) {
      return this.isTerminalExp(exp.inner, visited);
    }
    if (exp instanceof DelayedExp) {
      const seen = visited ?? new Set<DelayedExp>();
      if (seen.has(exp)) return false; // recursive — not terminal
      seen.add(exp);
      return this.isTerminalExp(exp.force(), seen);
    }
    if (exp instanceof SeqExp) {
      return exp.children.every((c) => this.isTerminalExp(c, visited));
    }
    if (exp instanceof AltExp) {
      return exp.children.some((c) => this.isTerminalExp(c, visited));
    }
    return false;
  }

  /* ── Snapshot/restore for backtracking ───────────────────────────── */

  private snapshot(state: GenState): {
    tokens: number;
    records: number;
    seq: number;
    depth: number;
    recursionCounts: Map<DelayedExp, number>;
    steps: number;
    charOffset: number;
  } {
    return {
      tokens: state.tokens.length,
      records: state.records.length,
      seq: state.seq,
      depth: state.depth,
      recursionCounts: new Map(state.recursionCounts),
      steps: state.steps,
      charOffset: state.charOffset,
    };
  }

  private restore(
    state: GenState,
    snap: ReturnType<typeof this.snapshot>,
  ): void {
    state.tokens.length = snap.tokens;
    state.records.length = snap.records;
    state.seq = snap.seq;
    state.depth = snap.depth;
    state.charOffset = snap.charOffset;
    // NOTE: state.steps is intentionally NOT restored — it is a monotonic
    // safety cap against infinite loops, not a search-state variable.
    state.recursionCounts.clear();
    for (const [k, v] of snap.recursionCounts) state.recursionCounts.set(k, v);
  }

  /* ── Shuffle ─────────────────────────────────────────────────────── */

  /** Fisher-Yates shuffle returning indices `[0..n)` in random order. */
  private shuffleIndices(n: number, rng: RNG): number[] {
    const arr = Array.from({ length: n }, (_, i) => i);
    arr.forEach((_, i) => {
      if (i > 0) {
        const j = rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
    });
    return arr;
  }

  /* ── Deterministic branch ordering ──────────────────────────────── */

  /**
   * Order branch indices by the selected deterministic strategy:
   *
   * - `"depth-first"`: recursive (non-terminal) branches first, terminals
   *   last. Produces maximal L-system expansion.
   * - `"breadth-first"`: terminal (base-case) branches first, recursive
   *   branches last. Produces the minimal derivation — the simplest possible
   *   term at each choice point.
   *
   * Ties preserve original order (stable sort).
   */
  private orderBranches(
    candidates: readonly Exp[],
    strategy: "depth-first" | "breadth-first",
  ): number[] {
    const indices = Array.from({ length: candidates.length }, (_, i) => i);
    const terminalFirst = strategy === "breadth-first";
    return indices.sort((a, b) => {
      const aTerminal = this.isTerminalExp(candidates[a]!, new Set());
      const bTerminal = this.isTerminalExp(candidates[b]!, new Set());
      if (aTerminal === bTerminal) return 0;
      // depth-first: non-terminal first (aTerminal ? 1 : -1)
      // breadth-first: terminal first (aTerminal ? -1 : 1)
      return terminalFirst ? (aTerminal ? -1 : 1) : (aTerminal ? 1 : -1);
    });
  }

  /* ── Derivation tree construction ────────────────────────────────── */

  /** Pop children from the stack whose span is contained in `r`'s span. */
  private static popChildren(
    stack: DerivationNode[],
    r: { start: number; end: number; seq: number },
  ): DerivationNode[] {
    const children: DerivationNode[] = [];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (
        top.span.start >= r.start && top.span.end <= r.end &&
        (top.span.start > r.start || top.span.end < r.end || top.seq < r.seq)
      ) {
        children.push(stack.pop()!);
      } else break;
    }
    return children;
  }

  private buildTree(state: GenState): DerivationTree {
    const source = state.tokens.map((t) => t.sym).join("");
    const synthetic = () =>
      new DerivationTree(
        new DerivationNode(
          "<generated>",
          { start: 0, end: state.charOffset },
          [],
          undefined,
          0,
        ),
        source,
      );
    if (state.records.length === 0) return synthetic();

    // Fold over sorted records, nesting by span containment (same algorithm
    // as derivation.ts: children popped from the stack are those whose span
    // is contained in the current record's span).
    //
    // Zero-length (epsilon) production records are filtered out, consistent
    // with `buildDerivationTrees` in derivation.ts. Epsilon productions
    // complete at the same position they start (span `[n, n)`), so they
    // don't contribute meaningful structure to the derivation tree. If a
    // grammar needs zero-length nodes preserved, the raw records are
    // available on `GenState.records` before this filtering step.
    //
    // The generator produces a single derivation (it picks one branch at each
    // AltExp), so there is exactly one root. If multiple roots exist
    // (ambiguous grammar), the first is taken — consistent with the
    // generator's single-derivation output.
    const stack = state.records
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.seq - b.seq)
      .reduce((stack, r) => {
        const children = Generator.popChildren(stack, r).reverse();
        return [
          ...stack,
          new DerivationNode(
            r.label,
            { start: r.start, end: r.end },
            children,
            r.value,
            r.seq,
          ),
        ];
      }, [] as DerivationNode[]);

    const root = stack[0] ?? synthetic().root;
    return new DerivationTree(root, source);
  }
}
