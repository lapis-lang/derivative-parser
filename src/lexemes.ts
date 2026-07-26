/**
 * Common lexeme factories — shared building blocks for character-level grammars.
 * Pure functions returning `Parser`s, composable with the standalone combinators.
 */

import { pred, seq } from "./combinators.ts";
import { AltExp, DelayedExp, EpsilonExp, SeqExp } from "./zipper/zipper.ts";
import { Parser } from "./Parser.ts";

/* ─── Whitespace ─────────────────────────────────────────────────────── */

/** Zero-or-more whitespace (space, tab, newline, CR). */
export function ws(): Parser<string> {
  const wc = wsChar();
  const repExp: DelayedExp<string> = new DelayedExp<string>(() =>
    new AltExp([
      new SeqExp("_ws", [wc._exp, repExp], ([c, cs]) =>
        (c as string) + (cs as string)),
      new EpsilonExp(""),
    ])
  );
  return new Parser<string>(repExp);
}

/** One-or-more whitespace. */
export function ws1(): Parser<string> {
  return seq(wsChar(), ws()).map(([c, cs]) => c + cs);
}

/** A single whitespace character (space, tab, newline, CR). */
export function wsChar(): Parser<string> {
  return pred(
    (c) => c === " " || c === "\t" || c === "\n" || c === "\r",
    "<ws>",
  );
}

/* ─── Digits ──────────────────────────────────────────────────────────── */

/** A single decimal digit `[0-9]`. */
export function digit(): Parser<string> {
  return pred((c) => c >= "0" && c <= "9", "<digit>");
}

/** One or more decimal digits, joined into a string. */
export function digits(): Parser<string> {
  const d = digit();
  const repExp: DelayedExp<string> = new DelayedExp<string>(() =>
    new AltExp([
      new SeqExp("_digits", [d._exp, repExp], ([h, t]) =>
        (h as string) + (t as string)),
      d._exp,
    ])
  );
  return new Parser<string>(repExp);
}

/* ─── Identifiers ────────────────────────────────────────────────────── */

/**
 * Standard identifier: lowercase letter followed by letters/digits/`_`.
 * Accepts optional `first`/`rest` character predicates.
 */
export function ident(
  first: (c: string) => boolean = (c) => c >= "a" && c <= "z",
  rest: (c: string) => boolean = (c) =>
    (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_",
): Parser<string> {
  return seq(pred(first, "<id-first>"), identRest(rest))
    .map(([h, t]) => h + t);
}

/** The rest portion of an identifier (zero or more rest characters). */
export function identRest(
  charPred: (c: string) => boolean = (c) =>
    (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_",
): Parser<string> {
  const ch = identChar(charPred);
  const repExp: DelayedExp<string> = new DelayedExp<string>(() =>
    new AltExp([
      new SeqExp("_idrest", [ch._exp, repExp], ([c, cs]) =>
        (c as string) + (cs as string)),
      new EpsilonExp(""),
    ])
  );
  return new Parser<string>(repExp);
}

/** A single identifier character (rest position). */
export function identChar(
  charPred: (c: string) => boolean = (c) =>
    (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_",
): Parser<string> {
  return pred(charPred, "<id-char>");
}

/** The first character of an identifier (lowercase letter by default). */
export function identFirst(
  firstPred: (c: string) => boolean = (c) => c >= "a" && c <= "z",
): Parser<string> {
  return pred(firstPred, "<id-first>");
}
