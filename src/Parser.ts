/**
 * Thin, type-safe wrapper around a PwZ `Exp` node.
 *
 * `Parser<T>` is the user-facing type for all combinators. It carries the
 * underlying `Exp` (from `src/zipper/zipper.mts`) and exposes the fluent
 * algebra that `Grammar` uses to build grammars. No derivative machinery,
 * no Pool — those concerns now live entirely in the zipper engine.
 */

import {
  AltExp,
  ChainExp,
  DelayedExp,
  EmptyExp,
  EpsilonExp,
  type Exp,
  RedExp,
  SeqExp,
  type Span,
} from "./zipper/zipper.ts";

export class Parser<T> {
  /** @internal — exposes the underlying Exp to the Grammar driver. */
  readonly _exp: Exp;

  constructor(exp: Exp) {
    this._exp = exp;
  }

  /* ---- semantic action ---- */

  /** Apply `fn` to every parse tree this parser produces.
   *
   * `fn` receives the parse-tree value and a `Span` describing the
   * half-open `[start, end)` character offsets in the source string.
   */
  map<U>(fn: (t: T, span: Span) => U): Parser<U> {
    return new Parser<U>(new RedExp<T, U>(this._exp, fn));
  }

  /* ---- combinators ---- */

  /** A ∪ B — succeed if either branch succeeds. */
  or<U>(other: Parser<U>): Parser<T | U> {
    const left = this._exp;
    const right = other._exp;
    if (left instanceof AltExp && right instanceof AltExp) {
      return new Parser<T | U>(
        new AltExp([...left.children, ...right.children]),
      );
    }
    if (left instanceof AltExp) {
      return new Parser<T | U>(new AltExp([...left.children, right]));
    }
    if (right instanceof AltExp) {
      return new Parser<T | U>(new AltExp([left, ...right.children]));
    }
    return new Parser<T | U>(new AltExp([left, right]));
  }

  /** A ○ B — sequence; parse trees are pairs `[T, U]`. */
  then<U>(other: Parser<U>): Parser<[T, U]> {
    return new Parser<[T, U]>(
      new SeqExp("_seq", [this._exp, other._exp], ([a, b]) => [a, b] as [T, U]),
    );
  }

  /**
   * Monadic bind — the L-attributed grammar combinator.
   *
   * Parse `this`; for each value `v` produced, call `fn(v)` to obtain the
   * next parser and parse it.  The result is the pair `[v, w]` where `w` is
   * the second parser's result.
   *
   * Unlike `then`, the second parser is constructed *after* the first has
   * been parsed, so it can depend on the first's *synthesised* value.  This
   * enables one-pass context threading (L-attributed grammars): a left
   * sibling's result determines the right sibling's inherited context.
   *
   *   this.type.chain(ty => this.expr(Γ.extend(name, ty)))
   *
   * **Note**: the second parser is not memoised at the `Exp` level (it is
   * constructed fresh per parse-tree of `first`).  If it is a `@rule` method
   * call, the `@rule` per-argument cache still applies.
   */
  chain<U>(fn: (t: T) => Parser<U>): Parser<[T, U]> {
    return new Parser<[T, U]>(
      new ChainExp<T, U>(this._exp, (v) => fn(v as T)._exp),
    );
  }

  /**
   * A* — Kleene star; parse trees are arrays `T[]`.
   *
   * Implemented as a cyclic `DelayedExp`:
   *   rep = ε([]) | seq([A, rep], ([h, t]) => [h, ...t])
   */
  many(): Parser<T[]> {
    const inner = this._exp;
    const repExp: DelayedExp<T[]> = new DelayedExp<T[]>(() =>
      new AltExp([
        new EpsilonExp<T[]>([]),
        new SeqExp(
          "_rep",
          [inner, repExp],
          ([h, t]) => [h as T, ...(t as T[])],
        ),
      ])
    );
    return new Parser<T[]>(repExp);
  }

  /** A? — optional; parse trees are `T | undefined`. */
  opt(): Parser<T | undefined> {
    return this.or(new Parser<undefined>(new EpsilonExp<undefined>(undefined)));
  }
}

/** Build a `Parser` wrapping a pre-existing `Exp` (escape hatch for Grammar internals). */
export function parserOf<T>(exp: Exp): Parser<T> {
  return new Parser<T>(exp);
}

/** The empty parser `∅` — fails on all inputs. */
export function emptyParser<T = never>(): Parser<T> {
  return new Parser<T>(new EmptyExp());
}
