import { type Checkpoint, Parser } from "./Parser.ts";
import { DelayedExp, type Span, type Tok, ZipperDriver } from "./zipper.ts";
import { buildDerivationTrees, type DerivationTree } from "./derivation.ts";
import { treeKey } from "./util/tree_key.ts";
import {
  _markProduction,
  assertInvariants,
  collectMetadata,
  type ContractMeta,
  type ContractMetadataReport,
  metaOn,
  wrapWithContracts,
} from "./contracts.ts";
import { collectRules, type FormattedInferenceRule } from "./rules.ts";
import { verifyMetatheory, type MetatheoryReport } from "./metatheory.ts";
import {
  GenerationError,
  Generator,
  type GeneratorOptions,
  type GeneratorResult,
} from "./generate.ts";
import { GrammarGenerator, type ValueGenerator } from "./property.ts";
import { unparse as defaultUnparse } from "./unparse.ts";
import {
  epsilon as epsilonFn,
  or as orFn,
  pred as predFn,
  seq as seqFn,
  sseq as sseqFn,
} from "./combinators.ts";

/** A shape interface maps production names to their parse-tree types. */
export type GrammarShape = Record<string, unknown>;

/**
 * A diagnostic value carried through the parse forest by {@link diagnostic}.
 * Used by `@rescue` handlers to report parse-failure reasons without raising
 * exceptions.
 */
export interface Diagnostic {
  /** Machine-readable reason category, e.g. `"type-mismatch"`. */
  reason: string;
  /** Human-readable detail. */
  message: string;
}

/**
 * Abstract base for executable, OO grammars. Subclass and define productions
 * as `@rule` getters/methods returning `Parser<...>`. Recursion (including
 * left-recursion) is handled by lazy `DelayedExp` nodes and the PwZ zipper
 * engine. See the README for the full introduction.
 */

export abstract class Grammar<S extends GrammarShape = GrammarShape> {
  /**
   * When contract checking is enabled, returns a `Proxy` enforcing
   * `@requires`/`@ensures`/`@invariant`. When disabled, no Proxy is created
   * (zero overhead).
   */
  constructor() {
    return wrapWithContracts(this) as unknown as Grammar<S>;
  }

  /** Per-instance cache so `@rule` getters return the same `Parser` per key. */
  private readonly _ruleCache = new WeakMap<object, Parser<unknown>>();

  /** Per-instance, per-method, per-arg-key cache for parameterised `@rule` methods. */
  private readonly _paramRuleCache = new WeakMap<
    object,
    Map<string, Parser<unknown>>
  >();

  /** Internal: shared lookup for `@rule` decorator wrappers (getter form). */
  _ruleSlot<T>(key: object, build: () => Parser<T>): Parser<T> {
    let hit = this._ruleCache.get(key);
    if (!hit) {
      const delayed = new DelayedExp(() => build()._exp);
      // Attach the production name (from the @rule getter's bound target) as
      // the Exp productionLabel, so the derivation sink can label
      // DerivationNodes. `key` is the getter function; its `name` property
      // holds the production name (set by the @rule decorator via the
      // decorator context). Deno/JS engines name getters "get x"; strip the
      // "get " prefix so the label is just "x".
      const prodLabel = (key as { name?: string }).name?.replace(/^get /, "");
      if (prodLabel) delayed.productionLabel = prodLabel;
      hit = new Parser<unknown>(delayed);
      this._ruleCache.set(key, hit);
    }
    return hit as Parser<T>;
  }

  /** Internal: shared lookup for `@rule` decorator wrappers (method form). */
  _paramRuleSlot<T>(
    key: object,
    argKey: string,
    build: () => Parser<T>,
  ): Parser<T> {
    let inner = this._paramRuleCache.get(key);
    if (!inner) {
      inner = new Map();
      this._paramRuleCache.set(key, inner);
    }
    let hit = inner.get(argKey);
    if (!hit) {
      const delayed = new DelayedExp(() => build()._exp);
      // Attach the production name (from the @rule method's bound target) as
      // the Exp productionLabel, so the derivation sink can label
      // DerivationNodes.
      const prodLabel = (key as { name?: string }).name;
      if (prodLabel) delayed.productionLabel = prodLabel;
      hit = new Parser<unknown>(delayed);
      inner.set(argKey, hit);
    }
    return hit as Parser<T>;
  }

  /** The grammar's entry production. Subclasses must override. */
  abstract start(): Parser<S[keyof S]>;

  /**
   * Aggregated contract metadata for this grammar class, walked across the
   * whole inheritance chain (most-derived first). Exposes both the
   * executable predicates and the declarative metadata for each
   * `@requires` / `@ensures` / `@invariant` / `@rule` contract.
   *
   * Because this is a *static* getter, the predicates in the report are
   * unbound — when invoking a predicate reflectively, pass the instance
   * as the first (`self`) argument.
   */
  static get metadata(): ContractMetadataReport {
    return collectMetadata(this);
  }

  /**
   * First-class inference rules for this grammar class, walked across the
   * whole inheritance chain. Groups `@requires`/`@ensures` contracts that
   * follow the `meta.rule` convention into {@link InferenceRule} objects
   * with premises and a conclusion. Grammars that don't use the convention
   * return an empty array — the inference-rule model is fully opt-in.
   *
   * Because this is a *static* getter, the predicates in the rules are
   * unbound — when invoking a predicate reflectively, pass the instance
   * as the first (`self`) argument.
   */
  static get rules(): FormattedInferenceRule[] {
    return collectRules(this);
  }

  /**
   * Verify the metatheory (Progress + Preservation) of this grammar class's
   * dynamic-semantics rules. Pure static analysis over the first-class
   * {@link InferenceRule} model — no unification, no term generation.
   *
   * Progress checks constructor coverage: every `@rule` production is
   * either a value-rule or covered by a step-rule. Preservation checks
   * type consistency: each step-rule's conclusion type matches a premise
   * type.
   *
   * For full Preservation cross-checking against the typing relation, call
   * `verifyMetatheory(evalClass, typeCheckClass)` directly (the static
   * getter only passes the dynamic class).
   *
   * See {@link ../metatheory.ts} for the full engine. Grammars that don't
   * follow the inference-rule convention (no `meta.rule` annotations) return
   * a vacuous report (Progress holds with no rules, Preservation holds with
   * no checks).
   *
   * @returns The combined metatheory report.
   */
  static get metatheory(): MetatheoryReport {
    return verifyMetatheory(this);
  }

  /* ---- sigspace ---- */

  /** The whitespace production used by {@link sseq}. Override to customise. */
  protected get ws(): Parser<string> {
    return orFn(
      seqFn(
        predFn(
          (c) => c === " " || c === "\t" || c === "\n" || c === "\r",
          "<ws>",
        ),
        this.ws,
      ).map(([c, cs]) => c + cs),
      epsilonFn(""),
    );
  }

  /** Sigspace sequence — like {@link seq} but auto-inserts {@link ws} between terms. */
  protected sseq<Ts extends readonly unknown[]>(
    ...parsers: { [K in keyof Ts]: Parser<Ts[K]> }
  ): Parser<Ts> {
    return sseqFn(
      this.ws,
      ...(parsers as Parser<unknown>[]),
    ) as unknown as Parser<Ts>;
  }

  /** Wrap a production body in a memoised lazy reference (legacy thunk form). Prefer `@rule`. */
  protected rule<T>(body: () => Parser<T>): Parser<T> {
    return this._ruleSlot(body, body);
  }

  /* ---- driver ---- */

  /** Tokenize `input` into one `Tok` per character (iterating by code point). */
  private _toTokens(input: string): Tok[] {
    const tokens: Tok[] = [];
    let offset = 0;
    for (const c of input) tokens.push({ tag: c, sym: c, offset: offset++ });
    return tokens;
  }

  /**
   * Tokenize the substring `input.slice(start, end)` into one `Tok` per
   * character, with `offset` set to the **absolute** position in `input`
   * (i.e. `start + i`), so a fresh driver's `posToOffset` maps directly to
   * absolute source offsets. This is the positional primitive that lets
   * {@link parseSegment} return spans already in absolute coordinates,
   * without callers compensating with an input-offset base.
   */
  private _toTokensAbsolute(input: string, start: number, end: number): Tok[] {
    const tokens: Tok[] = [];
    let offset = start;
    for (const c of input.slice(start, end)) {
      tokens.push({ tag: c, sym: c, offset: offset++ });
    }
    return tokens;
  }

  /** Parse the input and return the parse forest. Empty set ⇒ rejection. */
  parse(input: string): Set<S[keyof S]> {
    assertInvariants(this);
    return this._parseWith<S[keyof S]>(input, this.start());
  }

  /** Drive the zipper engine with an arbitrary start parser. */
  protected _parseWith<T>(input: string, start: Parser<T>): Set<T> {
    assertInvariants(this);
    return new ZipperDriver().parse<T>(start._exp, this._toTokens(input));
  }

  /** Pure recognition — true iff input is in the language. */
  recognize(input: string): boolean {
    assertInvariants(this);
    return new ZipperDriver().recognize(
      this.start()._exp,
      this._toTokens(input),
    );
  }

  /* ── Generation (top-down, the dual of parsing) ───────────────────── */
  //
  // Where parse() consumes tokens bottom-up, generate() walks the Exp tree
  // top-down, emitting tokens and computing semantic values. This is L-system
  // style expansion: starting from an initial production (axiom), the
  // generator expands non-terminals until terminals are reached. See the
  // README for the full discussion.

  /**
   * Generate a value top-down from the grammar's start production, emitting
   * a token stream and building a derivation tree. The dual of {@link parse}:
   * where parsing consumes tokens to build a value, generation walks the
   * grammar's `Exp` tree top-down, choosing branches and emitting tokens.
   *
   * Throws {@link GenerationError} if no derivation completes within the
   * depth/recursion budget.
   *
   * @param options Generation options (depth, recursion, seed, alphabet).
   * @returns The generated value, token stream, and derivation tree.
   */
  generate(options?: GeneratorOptions): GeneratorResult<S[keyof S]> {
    assertInvariants(this);
    return new Generator(options).generate(this.start());
  }

  /**
   * Build a {@link ValueGenerator} (with grammar-aware shrinking) rooted at
   * the grammar's start production. The native property-testing adapter —
   * pass to {@link forAll} to run property-based tests.
   *
   * @param options Generation options (depth, recursion, rng, alphabet).
   * @returns A `ValueGenerator<S[keyof S]>` with `sample` and `shrink`.
   */
  toGenerator(options?: GeneratorOptions): ValueGenerator<S[keyof S]> {
    assertInvariants(this);
    return new GrammarGenerator<S[keyof S], S>(
      this,
      () => this.start(),
      options,
    );
  }

  /* ── Unparsing (inverse parsing) ──────────────────────────────────── */
  //
  // Convert a DerivationTree back into source text. The default UnparsePass
  // reconstructs from spans (zero-config); grammar authors subclass
  // SemanticPass<string> for pretty-printing. See src/unparse.ts.

  /**
   * Unparse a {@link DerivationTree} to a source string using the default
   * {@link UnparsePass}. For pretty-printing, override with a
   * `SemanticPass<string>` subclass.
   *
   * @param tree The derivation tree to unparse.
   * @returns The reconstructed source string.
   */
  unparse(tree: DerivationTree): string {
    return defaultUnparse(tree);
  }

  /**
   * Generate a value top-down from a named `@rule` production, resolved
   * reflectively. Supports parameterised (method) productions by passing
   * `args`.
   *
   * @param ruleName  The `@rule` production name (getter or method).
   * @param args      Arguments for a parameterised `@rule` method. Empty for
   *                  a getter production.
   * @param options   Generation options.
   * @returns The generated value, token stream, and derivation tree.
   */
  generateFrom(
    ruleName: string,
    args: readonly unknown[] = [],
    options?: GeneratorOptions,
  ): GeneratorResult<unknown> {
    assertInvariants(this);
    const parser = this._resolveRule(ruleName, args);
    return new Generator(options).generate(parser);
  }

  /**
   * Resolve a `@rule` production by name reflectively, returning its
   * `Parser`. Walks the prototype chain for a `@rule`-decorated method/getter
   * with the given name. For a parameterised `@rule` method, calls it with
   * `args`. Non-`@rule` methods (e.g. `parse`, `recognize`) are rejected.
   *
   * @internal Exposed for the generator; not part of the stable public API.
   */
  protected _resolveRule(
    ruleName: string,
    args: readonly unknown[] = [],
  ): Parser<unknown> {
    // Check the contract metadata to verify `ruleName` is a `@rule` production.
    const meta = collectMetadata(this);
    const methodReport = meta.methods[ruleName];
    if (!methodReport?.isRule) {
      // Collect available @rule names for a helpful error message.
      const available = Object.entries(meta.methods)
        .filter(([, r]) => r.isRule)
        .map(([k]) => k);
      throw new GenerationError(
        `generateFrom: "${ruleName}" is not a @rule production on ${this.constructor.name}.` +
          (available.length > 0
            ? ` Available @rule productions: ${available.join(", ")}.`
            : " No @rule productions found."),
      );
    }
    // Walk the prototype chain for the property named `ruleName`.
    let proto: object | null = Object.getPrototypeOf(this);
    while (proto && proto !== Object.prototype) {
      const desc = Object.getOwnPropertyDescriptor(proto, ruleName);
      if (desc) {
        if (typeof desc.get === "function") {
          // Getter production — call on `this`.
          return desc.get.call(this) as Parser<unknown>;
        }
        if (typeof desc.value === "function") {
          // Method production — call with args.
          return (desc.value as (...a: unknown[]) => Parser<unknown>)
            .apply(this, args as unknown[]);
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    throw new GenerationError(
      `generateFrom: @rule production "${ruleName}" is registered in metadata but not found on the prototype chain of ${this.constructor.name}.`,
    );
  }

  /**
   * Parse `input` and return the retained derivation trees alongside the
   * parse forest. This is the opt-in tree-*producing* entry point:
   * it captures *which `@rule` production matched where, with child
   * relationships and source spans* as first-class {@link DerivationTree}s.
   *
   * The inline single-pass `parse()` path is unaffected — this method sets
   * a derivation sink on a fresh driver, so only `@rule` productions (whose
   * `Exp.productionLabel` is set by `@rule`) are recorded. The captured
   * records are post-processed into trees by completion-order nesting.
   *
   * For ambiguous grammars, multiple derivation trees may be produced (one
   * per top-level derivation); the caller selects which to use.
   */
  parseToTree(
    input: string,
  ): {
    readonly forest: Set<S[keyof S]>;
    readonly trees: readonly DerivationTree[];
  } {
    assertInvariants(this);
    const driver = new ZipperDriver();
    const { forest, records } = driver.parseWithDerivation<S[keyof S]>(
      this.start()._exp,
      this._toTokens(input),
    );
    const trees = buildDerivationTrees(records, input);
    return { forest, trees };
  }

  /**
   * Drive the zipper engine with derivation capture and an arbitrary start
   * parser. Returns the parse forest and the retained derivation trees.
   */
  protected _parseToTreeWith<T>(
    input: string,
    start: Parser<T>,
  ): { readonly forest: Set<T>; readonly trees: readonly DerivationTree[] } {
    assertInvariants(this);
    const driver = new ZipperDriver();
    const { forest, records } = driver.parseWithDerivation<T>(
      start._exp,
      this._toTokens(input),
    );
    const trees = buildDerivationTrees(records, input);
    return { forest, trees };
  }

  /**
   * Re-parse a substring of `input` under `start` — the higher-order attribute
   * combinator for one-pass evaluation.
   *
   * During a single parse pass, a semantic action may need to re-evaluate a
   * fragment of the input under a different inherited context (e.g. applying
   * a closure: re-evaluate the body under an extended environment). This
   * method spins up a fresh {@link ZipperDriver} over the substring
   * `input.slice(span.start, span.end)` rooted at `start`, and returns the
   * resulting parse forest. Per-pass memo isolation ensures the nested driver
   * does not leak state into the outer parse.
   *
   * Returns the full parse forest (a `Set<T>`); callers typically take the
   * first result for deterministic evaluation. If the substring is ambiguous,
   * only the first parse is used.
   *
   * This lets an evaluator be a single grammar class extending the abstract
   * grammar (like a type checker), with no intermediate AST — the
   * higher-order step (re-evaluating a closure body) re-parses the original
   * source substring under the extended environment.
   */
  protected _forward<T>(
    input: string,
    span: Span,
    start: Parser<T>,
  ): Set<T> {
    assertInvariants(this);
    const substring = input.slice(span.start, span.end);
    return new ZipperDriver().parse<T>(start._exp, this._toTokens(substring));
  }

  /* ── Positional / compositional parsing primitives ────────────────── */
  //
  // These leverage the derivative parser's self-containment: the state after
  // consuming `k` tokens recognises the suffix `[k, n)` without the prefix
  // `[0, k)`. `parseSegment` exposes that as a public primitive; `checkpointAt`
  // lets a grammar capture the inherited context at a boundary as a value.
  // See the README for the full motivation.

  /**
   * Parse the segment `input.slice(startOffset, endOffset)` under `start`,
   * returning the parse forest. Spans in semantic actions are reported in
   * **absolute** coordinates (relative to `input`), so callers need no
   * offset compensation.
   *
   * This generalises {@link _forward}: instead of re-tokenising a substring
   * from offset 0 (forcing callers to track an input-offset base), it
   * tokenises the segment with absolute offsets, so a fresh
   * {@link ZipperDriver}'s position map points straight into the original
   * source. Per-pass memo isolation keeps the nested driver independent of
   * any outer parse.
   *
   * @param input   The full source string.
   * @param startOffset  Absolute char offset where the segment begins.
   * @param start   The parser to drive over the segment (for an L-attributed
   *                segment, build this with the inherited context at
   *                `startOffset` baked in — e.g. via {@link checkpointAt}).
   * @param endOffset  Absolute char offset where the segment ends. Defaults
   *                   to `input.length`.
   */
  parseSegment<T>(
    input: string,
    startOffset: number,
    start: Parser<T>,
    endOffset: number = input.length,
  ): Set<T> {
    assertInvariants(this);
    if (
      startOffset < 0 || endOffset < startOffset || endOffset > input.length
    ) {
      throw new RangeError(
        `parseSegment: invalid segment [${startOffset}, ${endOffset}) for input of length ${input.length}`,
      );
    }
    const tokens = this._toTokensAbsolute(input, startOffset, endOffset);
    return new ZipperDriver().withInitialOffset(startOffset)
      .parse<T>(start._exp, tokens);
  }

  /**
   * Parse the segment `[checkpoint.offset, endOffset)` under the checkpoint's
   * start parser. Convenience form of {@link parseSegment} taking a
   * {@link Checkpoint} (whose `start` has the inherited context baked in).
   *
   * @param input      The full source string.
   * @param checkpoint  The checkpoint defining the segment's start position
   *                    and context-baked start parser.
   * @param endOffset  Absolute char offset where the segment ends. Defaults
   *                   to `input.length`.
   */
  parseSegmentFrom<T>(
    input: string,
    checkpoint: Checkpoint<T>,
    endOffset: number = input.length,
  ): Set<T> {
    return this.parseSegment(
      input,
      checkpoint.offset,
      checkpoint.start,
      endOffset,
    );
  }

  /**
   * Build a {@link Checkpoint} at `offset` — capture the inherited context at
   * a boundary as a value, so a segment starting there can be parsed
   * independently (and later composed).
   *
   * The default implementation throws: a grammar with no inherited context
   * has no meaningful checkpoint (its `start` parser is already
   * context-free). Grammars with inherited context (e.g. threading a
   * `TypeEnv` or `ValEnv`) override this to reconstruct the context at
   * `offset` and bake it into the returned checkpoint's `start` parser.
   *
   * A typical override runs a lightweight recognition pass over the prefix
   * `[0, offset)` to recover the context at the boundary, then returns
   * `{ offset, start: this.<prod>(recoveredCtx), kind: "L" }`. For
   * S-attributed sub-grammars (no inherited context), return
   * `kind: "S"` with the context-free start parser.
   *
   * @param input   The full source string.
   * @param offset  Absolute char offset of the boundary.
   */
  checkpointAt(_input: string, _offset: number): Checkpoint<unknown> {
    throw new Error(
      `${this.constructor.name}.checkpointAt: not supported — override in a grammar with inherited context to enable segment parsing.`,
    );
  }

  /* ── Segment composition ──────────────────────────────────────────── */
  //
  // Composition combines the results of adjacent segment parses across
  // boundaries. For S-attributed sub-grammars (no inherited context) segments
  // are independent and composition is trivial. For L-attributed segments
  // the prefix's synthesized values must be threaded into the next segment's
  // checkpoint — `composeSegmentsL` does this iteratively via a
  // grammar-supplied `nextCheckpoint` callback.

  /**
   * Compose the results of independently-parsed S-attributed segments.
   *
   * Each segment's parse forest is independent (no inherited context crosses
   * a boundary), so composition is the union of all segment forests. The
   * composed result equals what a one-shot parse of the whole input would
   * produce when the grammar is S-attributed over the split points.
   *
   * @param segmentForests  The parse forests returned by {@link parseSegment}
   *                        for each segment, in source order.
   * @returns The union of all segment forests.
   */
  composeSegmentsS<T>(segmentForests: readonly Set<T>[]): Set<T> {
    assertInvariants(this);
    const out = new Set<T>();
    for (const forest of segmentForests) for (const v of forest) out.add(v);
    return out;
  }

  /**
   * Compose adjacent L-attributed segments by threading synthesized values
   * from each segment into the next segment's checkpoint.
   *
   * Starting from `initialCheckpoint`, this parses segment 0
   * (`[initialCheckpoint.offset, ends[0])`), calls `nextCheckpoint` with
   * segment 0's results to build the checkpoint for segment 1, parses
   * segment 1 (`[cp₁.offset, ends[1])`), and so on. The final segment's
   * parse forest is the composed result — it carries the full result because
   * L-attributed context threads through every boundary.
   *
   * The `initialCheckpoint` must have `kind: "L"`; each checkpoint returned
   * by `nextCheckpoint` must also have `kind: "L"` and its `offset` must
   * equal `prevEnd` (where the previous segment ended).
   *
   * The `ends` array has one fewer element than the number of segments: the
   * last segment runs to `input.length`. Concretely, with `ends.length === k`
   * there are `k + 1` segments and `k + 1` checkpoints (the initial plus one
   * built per boundary).
   *
   * @param input             The full source string.
   * @param initialCheckpoint  Checkpoint for segment 0 (context baked in).
   * @param ends              End offsets of segments 0..k-1 (the last segment
   *                          runs to `input.length`).
   * @param nextCheckpoint    Called after each segment to build the next
   *                          checkpoint. Receives `(prevResults, prevEnd,
   *                          segmentIndex)`. `prevResults` is the just-parsed
   *                          segment's forest; `prevEnd` is where it ended;
   *                          `segmentIndex` is the 0-based index of the
   *                          segment just parsed. Must return a
   *                          {@link Checkpoint} whose `offset` is `prevEnd`.
   * @returns The final segment's parse forest.
   */
  composeSegmentsL<T>(
    input: string,
    initialCheckpoint: Checkpoint<T>,
    ends: readonly number[],
    nextCheckpoint: (
      prevResults: Set<T>,
      prevEnd: number,
      segmentIndex: number,
    ) => Checkpoint<T>,
  ): Set<T> {
    assertInvariants(this);
    if (initialCheckpoint.kind !== "L") {
      throw new TypeError(
        `composeSegmentsL: initialCheckpoint must be L-attributed (kind: "L"), got kind: "${initialCheckpoint.kind}"`,
      );
    }
    if (ends.length === 0) {
      // Single segment: parse [initialCheckpoint.offset, input.length).
      return this.parseSegmentFrom(input, initialCheckpoint);
    }
    let checkpoint = initialCheckpoint;
    let results: Set<T> = new Set<T>();
    for (let i = 0; i < ends.length; i++) {
      const end = ends[i]!;
      results = this.parseSegmentFrom(input, checkpoint, end);
      checkpoint = nextCheckpoint(results, end, i);
      // The next checkpoint must be L-attributed and start where this segment ended.
      if (checkpoint.kind !== "L") {
        throw new TypeError(
          `composeSegmentsL: nextCheckpoint for segment ${i} returned kind: "${checkpoint.kind}", expected "L"`,
        );
      }
      if (checkpoint.offset !== end) {
        throw new RangeError(
          `composeSegmentsL: nextCheckpoint for segment ${i} returned offset ${checkpoint.offset}, expected ${end}`,
        );
      }
    }
    // Final segment: parse [checkpoint.offset, input.length).
    results = this.parseSegmentFrom(input, checkpoint);
    return results;
  }

  /* ── Incremental memo reuse ────────────────────────────────────────── */
  //
  // After a small edit, re-parsing the whole input is wasteful when most of
  // the derivation is unchanged. The derivative's self-containment means
  // `Exp.m` memos from the prior pass are still valid for unchanged regions
  // — if the driver reuses the same `Pos` sentinels. `reparseIncremental`
  // feeds the unchanged prefix via `stepReplay` (memo hits), the edited
  // region via `step` (fresh `Pos`, re-derive), and the unchanged suffix via
  // `stepReplay` again — yielding O(affected region) re-parsing.

  /**
   * Re-parse `input` after an edit in the region `[editStart, editEnd)`,
   * reusing memoised derivations from `priorDriver` for the unchanged
   * prefix `[0, editStart)` and suffix `[editEnd, input.length)`.
   *
   * The `priorDriver` must be the live `ZipperDriver` from the prior parse
   * (its `posToOffset` map holds the `Pos` sentinels that `Exp.m` memos
   * reference). This method re-feeds the unchanged tokens via `stepReplay`
   * (reusing those `Pos` objects so memos hit), and the edited tokens via
   * `step` (fresh `Pos`, re-derive). The result equals a full re-parse but
   * re-derives only the affected region.
   *
   * @param input        The edited source string.
   * @param start        The grammar's root parser.
   * @param editStart    Absolute offset where the edit begins.
   * @param editEnd      Absolute offset where the edit ends.
   * @param priorDriver The live driver from the prior parse (its `posToOffset`
   *                     provides the `Pos` sentinels for memo reuse).
   * @returns The parse forest for the edited input.
   */
  reparseIncremental<T>(
    input: string,
    start: Parser<T>,
    editStart: number,
    editEnd: number,
    priorDriver: ZipperDriver,
  ): Set<T> {
    assertInvariants(this);
    if (editStart < 0 || editEnd < editStart || editEnd > input.length) {
      throw new RangeError(
        `reparseIncremental: invalid edit [${editStart}, ${editEnd}) for input of length ${input.length}`,
      );
    }
    const driver = priorDriver; // reuse the same driver so Pos sentinels match
    driver.init(start._exp, { keepMemoMap: true });
    const tokens = this._toTokens(input);
    for (const tok of tokens) {
      if (tok.offset < editStart || tok.offset >= editEnd) {
        driver.stepReplay(tok); // unchanged region — reuse Pos, memo hits
      } else {
        driver.step(tok); // edited region — fresh Pos, re-derive
      }
    }
    driver.flushEof();
    return driver.forest<T>();
  }

  /* ── Fixpoint composition (circular attribute flow, Approach D) ────── */
  //
  // Once segment parsing and composition exist, circular attribute flow
  // can be solved by iterative fixpoint composition: parse all
  // handler bodies under a placeholder σ₀, compute σ₁ = join of their
  // results, re-parse under σ₁, repeat until σₙ₊₁ = σₙ. This needs no
  // engine rework — only the segment primitives above — and is uniquely
  // parallelizable (segments are independent given contexts).

  /**
   * Iterate a fixpoint over circular attribute flow until convergence.
   *
   * Given an initial placeholder `sigma` (σ₀), repeatedly calls `parseBodies`
   * to parse all handler bodies under the current σ, then computes
   * `sigma' = join(sigma, joinAll(bodyResults))`. If `sigma' === sigma`
   * (via `eq`, default `Object.is`), the fixpoint is reached and `sigma'`
   * is returned. Otherwise, asserts monotonicity (`sigma ⊑ sigma'`, i.e.
   * `join(sigma, sigma') === sigma'`) and continues.
   *
   * Convergence is guaranteed for monotone `join` over a finite-height
   * domain (the lattice axiom). On a monotonicity violation — a malformed
   * grammar with a non-monotone `join`, or an infinite-height domain —
   * throws {@link MonotonicityViolationError}.
   *
   * @param sigma        The initial placeholder σ₀.
   * @param parseBodies  Called each iteration with the current σ; returns an
   *                     array of parse results (one per handler body). Each
   *                     result is fed to `join`.
   * @param join         The lattice join: `join(a, b)` must be idempotent,
   *                     commutative, associative, and monotone. Used both to
   *                     fold the body results and to check `sigma ⊑ sigma'`.
   * @param eq           Equality test for fixpoint detection. Defaults to
   *                     `Object.is`. Override for value-structured σ.
   * @param maxIterations  Optional cap on iterations (default: unlimited).
   *                     When set and exceeded, throws
   *                     {@link FixpointDivergenceError} — a safety net for
   *                     monotone-but-infinite-height domains (e.g.
   *                     Agda-style universe towers). Default off so it never
   *                     interferes with a correct slow-converging grammar.
   * @returns The converged σ.
   */
  parseToFixpoint<S>(
    sigma: S,
    parseBodies: (sigma: S) => readonly S[],
    join: (a: S, b: S) => S,
    eq: (a: S, b: S) => boolean = Object.is as (a: S, b: S) => boolean,
    maxIterations?: number,
  ): S {
    assertInvariants(this);
    let iteration = 0;
    while (true) {
      if (maxIterations !== undefined && iteration >= maxIterations) {
        throw new FixpointDivergenceError(
          `parseToFixpoint: exceeded maxIterations (${maxIterations}) without convergence — ` +
            `the domain may have infinite height (e.g. a universe tower).`,
        );
      }
      const bodyResults = parseBodies(sigma);
      // Fold-join all body results into a single σ_body.
      // The fold starts from σ so that σ_body = join(σ, r₁, r₂, …) — the
      // body results accumulated on top of the current context.
      let sigmaBody = sigma;
      for (const r of bodyResults) sigmaBody = join(sigmaBody, r);
      // σ_next = σ_body (already includes σ via the fold seed).
      const sigmaNext = sigmaBody;
      if (eq(sigmaNext, sigma)) return sigmaNext; // fixpoint reached
      // Monotonicity check: sigma ⊑ sigmaNext iff join(sigma, sigmaNext) === sigmaNext.
      if (!eq(join(sigma, sigmaNext), sigmaNext)) {
        throw new MonotonicityViolationError(
          `parseToFixpoint: monotonicity violated at iteration ${iteration} — ` +
            `join(σₙ, σₙ₊₁) ≠ σₙ₊₁. The grammar's join is non-monotone or the ` +
            `domain is misbehaving.`,
        );
      }
      sigma = sigmaNext;
      iteration++;
    }
  }
}

/**
 * Thrown by {@link Grammar.parseToFixpoint} when the monotonicity invariant
 * `σₙ ⊑ σₙ₊₁` is violated — i.e. `join(σₙ, σₙ₊₁) ≠ σₙ₊₁`. This indicates a
 * malformed grammar (non-monotone `join`) or a misbehaving domain, not a
 * correct slow-converging grammar.
 */
export class MonotonicityViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonotonicityViolationError";
  }
}

/**
 * Thrown by {@link Grammar.parseToFixpoint} when `maxIterations` is set and
 * exceeded without convergence. A safety net for monotone-but-infinite-height
 * domains (e.g. Agda-style universe towers `Type₀ : Type₁ : Type₂ : …`),
 * where a monotone chain ascends forever without violating the
 * monotonicity check. Default `maxIterations` is off so this never fires on
 * a correct grammar.
 */
export class FixpointDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixpointDivergenceError";
  }
}

/**
 * Wraps a production in a memoised lazy `DelayedExp` reference. Getter form:
 * `@rule get foo()` — memoised per instance. Method form: `@rule foo(arg)` —
 * memoised per `(instance, arg)`. See the README for override semantics.
 */

type RuleGetterCtx = ClassGetterDecoratorContext<Grammar, Parser<unknown>>;
// `any` is required here: `ClassMethodDecoratorContext` constrains the
// function type to `(...args: any) => any`, so `unknown[]`/`never[]` won't fit.
type RuleMethodCtx = ClassMethodDecoratorContext<
  Grammar,
  // deno-lint-ignore no-explicit-any
  (this: Grammar, ...args: any[]) => Parser<unknown>
>;

/** Decorator for a `@rule` **getter** — a non-parameterised production. */
export function rule<T>(
  target: (this: Grammar) => Parser<T>,
  ctx: RuleGetterCtx,
): (this: Grammar) => Parser<T>;
/** Decorator for a `@rule` **method** — a parameterised (context-sensitive) production. */
export function rule<T, A extends unknown[]>(
  target: (this: Grammar, ...args: A) => Parser<T>,
  ctx: RuleMethodCtx,
): (this: Grammar, ...args: A) => Parser<T>;
/** Factory form: `@rule(meta)` — attach declarative metadata to a getter or method. */
export function rule<T>(
  meta: ContractMeta,
): <A extends unknown[] = []>(
  target: (this: Grammar, ...args: A) => Parser<T>,
  ctx: RuleGetterCtx | RuleMethodCtx,
) => (this: Grammar, ...args: A) => Parser<T>;
export function rule(
  targetOrMeta:
    | ((this: Grammar, ...args: unknown[]) => Parser<unknown>)
    | ContractMeta,
  ctx?: RuleGetterCtx | RuleMethodCtx,
): unknown {
  // Factory form: `@rule(meta)` — called with the meta object first.
  // Return the actual decorator that receives the target + ctx.
  if (typeof targetOrMeta !== "function") {
    const meta = targetOrMeta;
    if (meta === null || typeof meta !== "object") {
      throw new Error(
        "@rule(meta) requires a ContractMeta object (Record<string, unknown>); " +
          `got ${meta === null ? "null" : typeof meta}`,
      );
    }
    return (target: RuleTarget, ctx: RuleGetterCtx | RuleMethodCtx) =>
      applyRule(target, ctx, meta);
  }
  // Bare form: `@rule` — called with the target + ctx directly.
  return applyRule(targetOrMeta, ctx!);
}

/** Internal alias for the rule target function type. */
type RuleTarget = (this: Grammar, ...args: unknown[]) => Parser<unknown>;

/** Shared implementation for both bare `@rule` and `@rule(meta)`. */
function applyRule(
  target: RuleTarget,
  ctx: RuleGetterCtx | RuleMethodCtx,
  meta?: ContractMeta,
): RuleTarget {
  // Register `@rule` metadata on the class's Symbol.metadata directly in
  // the decorator body so it is available statically (without instantiation)
  // and marks the feature as a production (`isRule: true` in the report).
  metaOn(ctx.metadata).ruleMeta[ctx.name] = meta;
  if (ctx.kind === "getter") {
    return _markProduction(function (this: Grammar): Parser<unknown> {
      return this._ruleSlot(target, () => target.call(this));
    });
  }
  if (ctx.kind === "method") {
    return _markProduction(
      function (this: Grammar, ...args: unknown[]): Parser<unknown> {
        return this._paramRuleSlot(
          target,
          treeKey(args),
          () => target.apply(this, args),
        );
      },
    );
  }
  throw new Error(`@rule cannot decorate a ${(ctx as { kind: string }).kind}`);
}
