import { Parser } from "./Parser.ts";
import {
  AltExp,
  DelayedExp,
  EmptyExp,
  EpsilonExp,
  PredTokExp,
  SeqExp,
  type Tok,
  TokExp,
  ZipperDriver,
} from "./zipper/zipper.ts";
import { treeKey } from "./util/tree_key.ts";
import {
  _markProduction,
  assertInvariants,
  wrapWithContracts,
} from "./contracts.ts";

/** A shape interface maps production names to their parse-tree types. */
export type GrammarShape = Record<string, unknown>;

/**
 * A diagnostic value carried through the parse forest by {@link diagnostic}.
 * Collected by {@link Grammar.parseWithDiagnostics} to report parse-failure
 * reasons (e.g. from `@rescue` handlers) without raising exceptions.
 */
export interface Diagnostic {
  /** Machine-readable reason category, e.g. `"type-mismatch"`. */
  reason: string;
  /** Human-readable detail. */
  message: string;
}

/**
 * `Grammar` — abstract base for executable, OO grammars.
 *
 * Subclass and define productions as `@rule` getters (or methods) returning
 * `Parser<...>`. Recursion — including left-recursion — is handled by lazy
 * `DelayedExp` nodes and the PwZ zipper engine.
 *
 *   class BalancedParens extends Grammar<{ s: string }> {
 *     start() { return this.s; }
 *     @rule get s(): Parser<string> {
 *       return this.or(
 *         this.seq(this.char('('), this.s, this.char(')'), this.s)
 *             .map(() => 'ok'),
 *         this.epsilon('ok'),
 *       );
 *     }
 *   }
 *
 * The optional shape parameter `S` maps production names to their parse-tree
 * types — see `examples/` for the Bracha-style abstract grammar +
 * concrete subclass pattern.
 */

export abstract class Grammar<S extends GrammarShape = GrammarShape> {
  /**
   * Constructs the grammar and, when contract checking is enabled, returns
   * a `Proxy` that enforces `@requires` / `@ensures` / `@invariant` on
   * every semantic-action call (see `src/contracts.ts`). The Proxy is
   * transparent to `@rule` memoization: the `WeakMap` caches key on the
   * unwrapped target, which the Proxy forwards to. When `checkedMode` is
   * disabled, no Proxy is created (zero overhead).
   *
   * This replaces the reference library's `Contracted` base class + `.new()`
   * factory: `new Grammar()` returns the Proxy directly, with no separate
   * instantiation protocol.
   */
  constructor() {
    return wrapWithContracts(this) as unknown as Grammar<S>;
  }

  /**
   * Per-instance cache so `rule(body)` and `@rule get foo()` return the
   * same `Parser` (backed by a `DelayedExp`) per key.
   */
  private readonly _ruleCache = new WeakMap<object, Parser<unknown>>();

  /**
   * Per-instance, per-method, per-arg-key cache for parameterised
   * `@rule` methods (context-sensitive productions, etc.).
   */
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

  /* ---- combinator helpers ---- */

  /** A literal character. */
  protected char(c: string): Parser<string> {
    return new Parser<string>(new TokExp({ tag: c, sym: c, offset: -1 }));
  }

  /** A character matching a predicate. */
  protected pred(p: (c: string) => boolean, label = "<pred>"): Parser<string> {
    return new Parser<string>(new PredTokExp(p, label));
  }

  /** A literal multi-character string, returning the string itself. */
  protected literal(s: string): Parser<string> {
    if (s.length === 0) return this.epsilon("");
    const chars = [...s];
    const seq = new SeqExp(
      `_lit_${s}`,
      chars.map((c) => new TokExp({ tag: c, sym: c, offset: -1 })),
      () => s,
    );
    return new Parser<string>(seq);
  }

  /** ∅ — failing parser. */
  protected empty(): Parser<never> {
    return new Parser<never>(new EmptyExp());
  }

  /** ε — always succeeds, contributing `value` to the parse forest. */
  protected epsilon<T>(value: T): Parser<T> {
    return new Parser<T>(new EpsilonExp<T>(value));
  }

  /**
   * A diagnostic-bearing ε — always succeeds, contributing a {@link Diagnostic}
   * value to the parse forest. Used inside `@rescue` handlers to report why
   * a branch failed without raising an exception. Diagnostics are collected
   * by {@link parseWithDiagnostics}.
   */
  protected diagnostic(message: string, reason = "error"): Parser<Diagnostic> {
    return this.epsilon({ reason, message });
  }

  /** Variadic alternation. */
  protected or<T>(...parsers: Parser<T>[]): Parser<T> {
    if (parsers.length === 0) return this.empty() as unknown as Parser<T>;
    if (parsers.length === 1) return parsers[0]!;
    return new Parser<T>(new AltExp(parsers.map((p) => p._exp)));
  }

  /** Variadic sequence; returns a tuple of children's parse trees. */
  protected seq<Ts extends readonly unknown[]>(
    ...parsers: { [K in keyof Ts]: Parser<Ts[K]> }
  ): Parser<Ts> {
    if (parsers.length === 0) {
      return this.epsilon([] as unknown as Ts);
    }
    const exps = (parsers as Parser<unknown>[]).map((p) => p._exp);
    return new Parser<Ts>(
      new SeqExp("_seq", exps, (vs) => vs as unknown as Ts),
    );
  }

  /**
   * Monadic bind — the L-attributed grammar combinator.  See `Parser.chain`
   * for details.  Provided as a `Grammar` helper for consistency with
   * `seq`/`or`.
   *
   * Parse `first`; for each value `v`, call `fn(v)` to obtain the next parser
   * and parse it.  The result is the pair `[v, w]`.  This enables one-pass
   * context threading where a left sibling's *synthesised* value determines
   * the right sibling's *inherited* context.
   */
  protected chain<T, U>(
    first: Parser<T>,
    fn: (t: T) => Parser<U>,
  ): Parser<[T, U]> {
    return first.chain(fn);
  }

  /**
   * Wrap a production body in a memoised lazy reference (legacy thunk form).
   * Prefer the `@rule` decorator for new code.
   */
  protected rule<T>(body: () => Parser<T>): Parser<T> {
    return this._ruleSlot(body, body);
  }

  /* ---- driver ---- */

  /**
   * Tokenize `input` into one `Tok` per character (iterating by code point,
   * so astral characters are kept whole rather than split into surrogates).
   */
  private _toTokens(input: string): Tok[] {
    const tokens: Tok[] = [];
    let offset = 0;
    for (const c of input) tokens.push({ tag: c, sym: c, offset: offset++ });
    return tokens;
  }

  /**
   * Parse the input and return the set of all parse trees (the parse forest).
   * Empty set ⇒ rejection.
   *
   * If the grammar class declares `@invariant` contracts, they are checked
   * before parsing begins (a well-formedness gate).
   */
  parse(input: string): Set<S[keyof S]> {
    assertInvariants(this);
    return this._parseWith<S[keyof S]>(input, this.start());
  }

  /**
   * Drive the zipper engine with an arbitrary start parser — useful for
   * grammars whose entry production is parameterised (e.g. by an inherited
   * environment).  Subclasses call this from a custom `parseWith(...)` method.
   *
   * If the grammar class declares `@invariant` contracts, they are checked
   * before parsing begins.
   */
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
}

/**
 * `@rule` — decorator that wraps a grammar production in a memoised lazy
 * reference, the ergonomic alternative to the stored-arrow `rule(body)`
 * pattern. Inspired by Bracha's `RunnableGrammar` / `ExecutableGrammar`,
 * but implemented with native (TS5 stage-3) decorators rather than mirrors /
 * proxies.
 *
 *   class Math extends Grammar<{ expr: number; ... }> {
 *     @rule get expr(): Parser<number> {
 *       return this.or(
 *         this.seq(this.expr, this.char('+'), this.term)
 *             .map(([l, , r]) => l + r),
 *         this.term,
 *       );
 *     }
 *     start() { return this.expr; }
 *   }
 *
 * **Getter form**: referenced as `this.expr` (not `this.expr()`). The
 * decorator wraps the getter so each instance always returns the same
 * `Parser` (backed by a `DelayedExp`), cached per `(this, getter)`, making
 * the grammar graph properly recursive without manual thunks.
 *
 * **Method form** (parameterised productions):
 *
 *   @rule expr(min: number): Parser<...> { ... }
 *
 *   Cache key is `(this, method, treeKey([min]))`. Each (instance, method,
 *   arg-tuple) triple gets its own `DelayedExp` slot.
 *
 * Subclass override semantics: a subclass `@rule override get expr() { ... }`
 *   defines a *new* getter function, so it occupies a different cache slot
 *   from the parent's. Calling `super.expr` from inside the override
 *   accesses the parent's (decorated) getter and hits the parent's slot.
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
