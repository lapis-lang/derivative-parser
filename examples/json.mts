/**
 * JSON grammar — parses a strict subset of JSON (RFC 8259).
 *
 * Supported:
 *   • null, true, false
 *   • numbers  (integer + optional fraction + optional exponent)
 *   • strings  (double-quoted, basic escape sequences)
 *   • arrays   [ value, … ]
 *   • objects  { "key": value, … }
 *
 * Returns native JS values: null, boolean, number, string,
 * unknown[], Record<string, unknown>.
 *
 * Usage:
 *   const g = new JsonGrammar();
 *   const results = g.parse('{"x":1,"y":[true,null]}');
 *   // results is a Set containing the parsed object
 */

import { Grammar, rule } from '../src/index.mjs';
import type { Parser } from '../src/index.mjs';

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

export class JsonGrammar extends Grammar<{ value: JsonValue }> {
    override start(): Parser<JsonValue> { return this.value; }

    /* ── top-level value ─────────────────────────────────────────────── */

    @rule get value(): Parser<JsonValue> {
        return this.or(
            this.jsonNull as Parser<JsonValue>,
            this.jsonBool as Parser<JsonValue>,
            this.jsonNumber as Parser<JsonValue>,
            this.jsonString as Parser<JsonValue>,
            this.jsonArray as Parser<JsonValue>,
            this.jsonObject as Parser<JsonValue>,
        );
    }

    /* ── literals ────────────────────────────────────────────────────── */

    @rule protected get jsonNull(): Parser<null> {
        return this.literal('null').map(() => null);
    }

    @rule protected get jsonBool(): Parser<boolean> {
        return this.or(
            this.literal('true').map(() => true as boolean),
            this.literal('false').map(() => false as boolean),
        );
    }

    /* ── number ──────────────────────────────────────────────────────── */

    @rule protected get jsonNumber(): Parser<number> {
        return this.seq(this.optMinus, this.intPart, this.optFrac, this.optExp)
            .map(([sign, int, frac, exp]) => Number(`${sign}${int}${frac}${exp}`));
    }

    protected get optMinus(): Parser<string> {
        return this.or(this.char('-'), this.epsilon(''));
    }

    @rule protected get intPart(): Parser<string> {
        return this.or(
            this.char('0'),
            this.seq(this.pred((c) => c >= '1' && c <= '9', '<1-9>'), this.digitStr)
                .map(([d, ds]) => d + ds),
        );
    }

    @rule protected get digitStr(): Parser<string> {
        return this.or(
            this.seq(this.digit, this.digitStr).map(([d, ds]) => d + ds),
            this.epsilon(''),
        );
    }

    protected get digit(): Parser<string> {
        return this.pred((c) => c >= '0' && c <= '9', '<digit>');
    }

    @rule protected get optFrac(): Parser<string> {
        return this.or(
            this.seq(this.char('.'), this.digit, this.digitStr)
                .map(([dot, d, ds]) => dot + d + ds),
            this.epsilon(''),
        );
    }

    @rule protected get optExp(): Parser<string> {
        return this.or(
            this.seq(
                this.pred((c) => c === 'e' || c === 'E', 'e|E'),
                this.or(this.char('+'), this.char('-'), this.epsilon('')),
                this.digit,
                this.digitStr,
            ).map(([e, sign, d, ds]) => e + sign + d + ds),
            this.epsilon(''),
        );
    }

    /* ── string ──────────────────────────────────────────────────────── */

    @rule protected get jsonString(): Parser<string> {
        return this.seq(this.char('"'), this.strChars, this.char('"'))
            .map(([, s]) => s);
    }

    @rule protected get strChars(): Parser<string> {
        return this.or(
            this.seq(this.strChar, this.strChars).map(([c, cs]) => c + cs),
            this.epsilon(''),
        );
    }

    @rule protected get strChar(): Parser<string> {
        return this.or(
            this.seq(this.char('\\'), this.escapeChar).map(([, c]) => c),
            this.pred((c) => c !== '"' && c !== '\\', '<str-char>'),
        );
    }

    protected get escapeChar(): Parser<string> {
        return this.or(
            this.char('"'),
            this.char('\\'),
            this.char('/'),
            this.char('b').map(() => '\b'),
            this.char('f').map(() => '\f'),
            this.char('n').map(() => '\n'),
            this.char('r').map(() => '\r'),
            this.char('t').map(() => '\t'),
        );
    }

    /* ── array ───────────────────────────────────────────────────────── */

    @rule protected get jsonArray(): Parser<JsonValue[]> {
        return this.or(
            this.seq(this.char('['), this.ws, this.char(']'))
                .map(() => [] as JsonValue[]),
            this.seq(this.char('['), this.ws, this.arrayItems, this.ws, this.char(']'))
                .map(([, , items]) => items),
        );
    }

    @rule protected get arrayItems(): Parser<JsonValue[]> {
        return this.or(
            this.seq(this.arrayItems, this.ws, this.char(','), this.ws, this.value)
                .map(([items, , , , v]) => [...items, v]),
            this.value.map((v) => [v]),
        );
    }

    /* ── object ──────────────────────────────────────────────────────── */

    @rule protected get jsonObject(): Parser<{ [key: string]: JsonValue }> {
        return this.or(
            this.seq(this.char('{'), this.ws, this.char('}'))
                .map(() => ({} as { [key: string]: JsonValue })),
            this.seq(this.char('{'), this.ws, this.objectMembers, this.ws, this.char('}'))
                .map(([, , members]) => members),
        );
    }

    @rule protected get objectMembers(): Parser<{ [key: string]: JsonValue }> {
        return this.or(
            this.seq(this.objectMembers, this.ws, this.char(','), this.ws, this.objectMember)
                .map(([obj, , , , [k, v]]) => ({ ...obj, [k]: v })),
            this.objectMember.map(([k, v]) => ({ [k]: v })),
        );
    }

    @rule protected get objectMember(): Parser<[string, JsonValue]> {
        return this.seq(this.jsonString, this.ws, this.char(':'), this.ws, this.value)
            .map(([k, , , , v]) => [k, v] as [string, JsonValue]);
    }

    /* ── whitespace ──────────────────────────────────────────────────── */

    @rule protected get ws(): Parser<string> {
        return this.or(
            this.seq(this.wsChar, this.ws).map(([c, cs]) => c + cs),
            this.epsilon(''),
        );
    }

    protected get wsChar(): Parser<string> {
        return this.pred(
            (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r',
            '<ws>',
        );
    }
}
