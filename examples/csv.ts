/** RFC 4180 CSV grammar. */

import { char, epsilon, Grammar, or, pred, rule, seq } from "../src/index.ts";
import type { Parser } from "../src/index.ts";

export class CsvGrammar extends Grammar<{ file: string[][] }> {
  override start(): Parser<string[][]> {
    return this.file;
  }

  /* ── file ────────────────────────────────────────────────────────── */

  @rule
  get file(): Parser<string[][]> {
    return or(
      // one or more records separated by line endings, optional trailing CRLF
      seq(this.record, this.moreRecords, this.optLineEnd)
        .map(([first, rest]) => [first, ...rest]),
      // single record, no trailing newline
      this.record.map((r) => [r]),
    );
  }

  @rule
  protected get moreRecords(): Parser<string[][]> {
    return or(
      seq(this.lineEnd, this.record, this.moreRecords)
        .map(([, r, rest]) => [r, ...rest]),
      epsilon([] as string[][]),
    );
  }

  protected get optLineEnd(): Parser<string> {
    return or(this.lineEnd, epsilon(""));
  }

  protected get lineEnd(): Parser<string> {
    return or(
      seq(char("\r"), char("\n")).map(() => "\r\n"),
      char("\n"),
    );
  }

  /* ── record ──────────────────────────────────────────────────────── */

  @rule
  protected get record(): Parser<string[]> {
    return seq(this.field, this.moreFields)
      .map(([first, rest]) => [first, ...rest]);
  }

  @rule
  protected get moreFields(): Parser<string[]> {
    return or(
      seq(char(","), this.field, this.moreFields)
        .map(([, f, rest]) => [f, ...rest]),
      epsilon([] as string[]),
    );
  }

  /* ── field ───────────────────────────────────────────────────────── */

  @rule
  protected get field(): Parser<string> {
    return or(this.quotedField, this.unquotedField);
  }

  @rule
  protected get quotedField(): Parser<string> {
    return seq(char('"'), this.quotedChars, char('"'))
      .map(([, s]) => s);
  }

  @rule
  protected get quotedChars(): Parser<string> {
    return or(
      seq(this.quotedChar, this.quotedChars).map(([c, cs]) => c + cs),
      epsilon(""),
    );
  }

  protected get quotedChar(): Parser<string> {
    return or(
      // escaped double-quote: "" → "
      seq(char('"'), char('"')).map(() => '"'),
      // any character except a lone double-quote
      pred((c) => c !== '"', "<quoted-char>"),
    );
  }

  @rule
  protected get unquotedField(): Parser<string> {
    return or(
      seq(this.unquotedChar, this.unquotedField).map(([c, cs]) => c + cs),
      epsilon(""),
    );
  }

  protected get unquotedChar(): Parser<string> {
    return pred(
      (c) => c !== "," && c !== "\r" && c !== "\n" && c !== '"',
      "<unquoted-char>",
    );
  }
}
