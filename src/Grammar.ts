import { Parser } from "./Parser.ts";
import {
  DelayedExp,
  type Span,
  type Tok,
  type TreeTok,
  ZipperDriver,
} from "./zipper/zipper.ts";
import { treeKey } from "./util/tree_key.ts";
import {
  _markProduction,
  assertInvariants,
  wrapWithContracts,
} from "./contracts.ts";
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
      hit = new Parser<unknown>(new DelayedExp(() => build()._exp));
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
      hit = new Parser<unknown>(new DelayedExp(() => build()._exp));
      inner.set(argKey, hit);
    }
    return hit as Parser<T>;
  }

  /** The grammar's entry production. Subclasses must override. */
  abstract start(): Parser<S[keyof S]>;

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

  /**
   * Parse a tree-token stream (a flattened tree) against the grammar rooted at
   * {@link start}. This is the entry point for **tree-consuming grammars** —
   * a grammar pass whose input is an already-built tree (e.g. an AST or a
   * derivation tree) rather than source text. Combined with overridden
   * semantic actions in a subclass, this lets a second pass (such as
   * evaluation) be expressed as a grammar subclass instead of a separate
   * recursive function.
   *
   * `treeTokens` is a preorder flattening of the tree; use {@link flattenTree}
   * with a `childrenOf` extractor to build it. Per-pass memo isolation is
   * handled by the driver, so the same grammar instance may be used across
   * multiple `parse`/`parseTree` calls without stale-state leakage.
   */
  parseTree(treeTokens: readonly TreeTok[]): Set<S[keyof S]> {
    assertInvariants(this);
    return new ZipperDriver().parseTree<S[keyof S]>(
      this.start()._exp,
      treeTokens,
    );
  }

  /** Drive the zipper engine over a tree-token stream with an arbitrary start parser. */
  protected _parseTreeWith<T>(
    treeTokens: readonly TreeTok[],
    start: Parser<T>,
  ): Set<T> {
    assertInvariants(this);
    return new ZipperDriver().parseTree<T>(start._exp, treeTokens);
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
export function rule(
  target: (this: Grammar, ...args: unknown[]) => Parser<unknown>,
  ctx: RuleGetterCtx | RuleMethodCtx,
): (this: Grammar, ...args: unknown[]) => Parser<unknown> {
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
