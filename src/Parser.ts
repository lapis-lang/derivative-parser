/** Thin, type-safe wrapper around a PwZ `Exp` node. */

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

/**
 * The user-facing combinator type. Constructed by `Grammar` combinators and
 * the `@rule` decorator; users rarely call `new Parser(...)` directly.
 */
export class Parser<T> {
  /** @internal — exposes the underlying Exp to the Grammar driver. */
  readonly _exp: Exp;

  /** @internal — wrap a pre-existing `Exp`. Prefer the `Grammar` combinators. */
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
   * Monadic bind — the L-attributed grammar combinator. Parse `this`; for
   * each value `v`, call `fn(v)` to get the next parser. Result is `[v, w]`.
   * See the README for L-attributed grammar usage.
   */
  chain<U>(fn: (t: T) => Parser<U>): Parser<[T, U]> {
    return new Parser<[T, U]>(
      new ChainExp<T, U>(this._exp, (v) => fn(v as T)._exp),
    );
  }

  /** A* — Kleene star; parse trees are arrays `T[]`. */
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
