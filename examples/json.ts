/** Full JSON grammar. See the README for usage. */

import {
  char,
  epsilon,
  Grammar,
  literal,
  or,
  pred,
  rule,
  seq,
} from "../src/index.ts";
import type { Parser } from "../src/index.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class JsonGrammar extends Grammar<{ value: JsonValue }> {
  override start(): Parser<JsonValue> {
    return this.value;
  }

  /* ── top-level value ─────────────────────────────────────────────── */

  @rule
  get value(): Parser<JsonValue> {
    return or(
      this.jsonNull as Parser<JsonValue>,
      this.jsonBool as Parser<JsonValue>,
      this.jsonNumber as Parser<JsonValue>,
      this.jsonString as Parser<JsonValue>,
      this.jsonArray as Parser<JsonValue>,
      this.jsonObject as Parser<JsonValue>,
    );
  }

  /* ── literals ────────────────────────────────────────────────────── */

  @rule
  protected get jsonNull(): Parser<null> {
    return literal("null").map(() => null);
  }

  @rule
  protected get jsonBool(): Parser<boolean> {
    return or(
      literal("true").map(() => true as boolean),
      literal("false").map(() => false as boolean),
    );
  }

  /* ── number ──────────────────────────────────────────────────────── */

  @rule
  protected get jsonNumber(): Parser<number> {
    return seq(this.optMinus, this.intPart, this.optFrac, this.optExp)
      .map(([sign, int, frac, exp]) => Number(`${sign}${int}${frac}${exp}`));
  }

  protected get optMinus(): Parser<string> {
    return or(char("-"), epsilon(""));
  }

  @rule
  protected get intPart(): Parser<string> {
    return or(
      char("0"),
      seq(pred((c) => c >= "1" && c <= "9", "<1-9>"), this.digitStr)
        .map(([d, ds]) => d + ds),
    );
  }

  @rule
  protected get digitStr(): Parser<string> {
    return or(
      seq(this.digit, this.digitStr).map(([d, ds]) => d + ds),
      epsilon(""),
    );
  }

  protected get digit(): Parser<string> {
    return pred((c) => c >= "0" && c <= "9", "<digit>");
  }

  @rule
  protected get optFrac(): Parser<string> {
    return or(
      seq(char("."), this.digit, this.digitStr)
        .map(([dot, d, ds]) => dot + d + ds),
      epsilon(""),
    );
  }

  @rule
  protected get optExp(): Parser<string> {
    return or(
      seq(
        pred((c) => c === "e" || c === "E", "e|E"),
        or(char("+"), char("-"), epsilon("")),
        this.digit,
        this.digitStr,
      ).map(([e, sign, d, ds]) => e + sign + d + ds),
      epsilon(""),
    );
  }

  /* ── string ──────────────────────────────────────────────────────── */

  @rule
  protected get jsonString(): Parser<string> {
    return seq(char('"'), this.strChars, char('"'))
      .map(([, s]) => s);
  }

  @rule
  protected get strChars(): Parser<string> {
    return or(
      seq(this.strChar, this.strChars).map(([c, cs]) => c + cs),
      epsilon(""),
    );
  }

  @rule
  protected get strChar(): Parser<string> {
    return or(
      seq(char("\\"), this.escapeChar).map(([, c]) => c),
      pred((c) => c !== '"' && c !== "\\", "<str-char>"),
    );
  }

  protected get escapeChar(): Parser<string> {
    return or(
      char('"'),
      char("\\"),
      char("/"),
      char("b").map(() => "\b"),
      char("f").map(() => "\f"),
      char("n").map(() => "\n"),
      char("r").map(() => "\r"),
      char("t").map(() => "\t"),
    );
  }

  /* ── array ───────────────────────────────────────────────────────── */

  @rule
  protected get jsonArray(): Parser<JsonValue[]> {
    return or(
      this.sseq(char("["), char("]"))
        .map(() => [] as JsonValue[]),
      this.sseq(
        char("["),
        this.arrayItems,
        char("]"),
      )
        .map(([, items]) => items),
    );
  }

  @rule
  protected get arrayItems(): Parser<JsonValue[]> {
    return or(
      this.sseq(this.arrayItems, char(","), this.value)
        .map(([items, , v]) => [...items, v]),
      this.value.map((v) => [v]),
    );
  }

  /* ── object ──────────────────────────────────────────────────────── */

  @rule
  protected get jsonObject(): Parser<{ [key: string]: JsonValue }> {
    return or(
      this.sseq(char("{"), char("}"))
        .map(() => ({} as { [key: string]: JsonValue })),
      this.sseq(
        char("{"),
        this.objectMembers,
        char("}"),
      )
        .map(([, members]) => members),
    );
  }

  @rule
  protected get objectMembers(): Parser<{ [key: string]: JsonValue }> {
    return or(
      this.sseq(
        this.objectMembers,
        char(","),
        this.objectMember,
      )
        .map(([obj, , [k, v]]) => ({ ...obj, [k]: v })),
      this.objectMember.map(([k, v]) => ({ [k]: v })),
    );
  }

  @rule
  protected get objectMember(): Parser<[string, JsonValue]> {
    return this.sseq(
      this.jsonString,
      char(":"),
      this.value,
    )
      .map(([k, , v]) => [k, v] as [string, JsonValue]);
  }

  /* ── whitespace ──────────────────────────────────────────────────── */

  @rule
  protected override get ws(): Parser<string> {
    return or(
      seq(this.wsChar, this.ws).map(([c, cs]) => c + cs),
      epsilon(""),
    );
  }

  protected get wsChar(): Parser<string> {
    return pred(
      (c) => c === " " || c === "\t" || c === "\n" || c === "\r",
      "<ws>",
    );
  }
}
