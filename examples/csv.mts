/**
 * CSV grammar — parses RFC 4180 comma-separated values.
 *
 * Grammar:
 *   file    → record (CRLF record)* CRLF?
 *   record  → field (',' field)*
 *   field   → quoted | unquoted
 *   quoted  → '"' (any char except '"' | '""')* '"'
 *   unquoted → (any char except ',' CR LF)*
 *
 * Returns a two-dimensional array: string[][].
 * Quoted fields have their surrounding quotes removed and doubled
 * double-quotes ("") collapsed to a single (").
 *
 * Usage:
 *   const g = new CsvGrammar();
 *   const [result] = g.parse('name,age\r\nAlice,30\r\nBob,25');
 *   // [['name','age'],['Alice','30'],['Bob','25']]
 */

import { Grammar, rule } from '../src/index.mjs';
import type { Parser } from '../src/index.mjs';

export class CsvGrammar extends Grammar<{ file: string[][] }> {
    override start(): Parser<string[][]> { return this.file; }

    /* ── file ────────────────────────────────────────────────────────── */

    @rule get file(): Parser<string[][]> {
        return this.or(
            // one or more records separated by line endings, optional trailing CRLF
            this.seq(this.record, this.moreRecords, this.optLineEnd)
                .map(([first, rest]) => [first, ...rest]),
            // single record, no trailing newline
            this.record.map((r) => [r]),
        );
    }

    @rule protected get moreRecords(): Parser<string[][]> {
        return this.or(
            this.seq(this.lineEnd, this.record, this.moreRecords)
                .map(([, r, rest]) => [r, ...rest]),
            this.epsilon([] as string[][]),
        );
    }

    protected get optLineEnd(): Parser<string> {
        return this.or(this.lineEnd, this.epsilon(''));
    }

    protected get lineEnd(): Parser<string> {
        return this.or(
            this.seq(this.char('\r'), this.char('\n')).map(() => '\r\n'),
            this.char('\n'),
        );
    }

    /* ── record ──────────────────────────────────────────────────────── */

    @rule protected get record(): Parser<string[]> {
        return this.seq(this.field, this.moreFields)
            .map(([first, rest]) => [first, ...rest]);
    }

    @rule protected get moreFields(): Parser<string[]> {
        return this.or(
            this.seq(this.char(','), this.field, this.moreFields)
                .map(([, f, rest]) => [f, ...rest]),
            this.epsilon([] as string[]),
        );
    }

    /* ── field ───────────────────────────────────────────────────────── */

    @rule protected get field(): Parser<string> {
        return this.or(this.quotedField, this.unquotedField);
    }

    @rule protected get quotedField(): Parser<string> {
        return this.seq(this.char('"'), this.quotedChars, this.char('"'))
            .map(([, s]) => s);
    }

    @rule protected get quotedChars(): Parser<string> {
        return this.or(
            this.seq(this.quotedChar, this.quotedChars).map(([c, cs]) => c + cs),
            this.epsilon(''),
        );
    }

    protected get quotedChar(): Parser<string> {
        return this.or(
            // escaped double-quote: "" → "
            this.seq(this.char('"'), this.char('"')).map(() => '"'),
            // any character except a lone double-quote
            this.pred((c) => c !== '"', '<quoted-char>'),
        );
    }

    @rule protected get unquotedField(): Parser<string> {
        return this.or(
            this.seq(this.unquotedChar, this.unquotedField).map(([c, cs]) => c + cs),
            this.epsilon(''),
        );
    }

    protected get unquotedChar(): Parser<string> {
        return this.pred(
            (c) => c !== ',' && c !== '\r' && c !== '\n' && c !== '"',
            '<unquoted-char>',
        );
    }
}
