/**
 * Unit tests for the language algebra (Empty, Epsilon, Token, Alt, Seq, Rep, Red).
 * Exercises these through the Grammar combinators + ZipperDriver so we test
 * the observable semantics rather than internals.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Grammar, rule } from '../src/index.mjs';
import type { Parser } from '../src/index.mjs';

/* ─── Helpers ────────────────────────────────────────────────────────── */

/** Thin grammar that just wraps a combinator for single-shot tests. */
class G extends Grammar<{ r: unknown }> {
    constructor(private readonly p: Parser<unknown>) { super(); }
    start(): Parser<unknown> { return this.p; }
}

function parse(p: Parser<unknown>, input: string): unknown[] {
    return [...new G(p).parse(input)];
}
function accepts(p: Parser<unknown>, input: string): boolean {
    return new G(p).recognize(input);
}

/* ─── Combinator helpers accessible outside Grammar ─────────────────── */

/* We need an instance to access the protected helpers; use a throwaway. */
const _ = new class extends Grammar<{ r: unknown }> {
    start(): Parser<unknown> { throw new Error('unused'); }
    char(c: string) { return super.char(c); }
    pred(p: (c: string) => boolean, l?: string) { return super.pred(p, l); }
    epsilon<T>(v: T) { return super.epsilon(v); }
    empty() { return super.empty(); }
    or<T>(...ps: Parser<T>[]) { return super.or(...ps); }
    seq<Ts extends readonly unknown[]>(...ps: { [K in keyof Ts]: Parser<Ts[K]> }) {
        return super.seq<Ts>(...ps);
    }
    literal(s: string) { return super.literal(s); }
}();

/* ─── Empty ──────────────────────────────────────────────────────────── */

describe('Empty', () => {
    const empty = _.empty();

    it('rejects everything', () => {
        assert.equal(accepts(empty, ''), false);
        assert.equal(accepts(empty, 'a'), false);
    });
    it('produces no parse trees on ""', () => {
        assert.deepEqual(parse(empty, ''), []);
    });
});

/* ─── Epsilon ────────────────────────────────────────────────────────── */

describe('Epsilon', () => {
    const eps = _.epsilon(42);

    it('accepts ε', () => assert.equal(accepts(eps, ''), true));
    it('rejects non-empty input', () => assert.equal(accepts(eps, 'a'), false));
    it('returns its value on ε', () => {
        assert.deepEqual(parse(eps, ''), [42]);
    });
});

/* ─── Token / char ───────────────────────────────────────────────────── */

describe('char / Token', () => {
    const a = _.char('a');

    it('rejects ε', () => assert.equal(accepts(a, ''), false));
    it('accepts the matching character', () => {
        assert.equal(accepts(a, 'a'), true);
        assert.deepEqual(parse(a, 'a'), ['a']);
    });
    it('rejects other characters', () => assert.equal(accepts(a, 'b'), false));
});

/* ─── pred / PredTok ─────────────────────────────────────────────────── */

describe('pred', () => {
    const digit = _.pred((c) => c >= '0' && c <= '9', '<digit>');

    it('accepts a digit', () => assert.equal(accepts(digit, '5'), true));
    it('rejects a non-digit', () => assert.equal(accepts(digit, 'a'), false));
    it('returns the matched character', () => {
        assert.deepEqual(parse(digit, '7'), ['7']);
    });
});

/* ─── Alt (A ∪ B) ────────────────────────────────────────────────────── */

describe('Alt (A ∪ B)', () => {
    const aOrB = _.or(_.char('a'), _.char('b'));

    it('accepts either branch', () => {
        assert.equal(accepts(aOrB, 'a'), true);
        assert.equal(accepts(aOrB, 'b'), true);
    });
    it('rejects non-matching input', () => assert.equal(accepts(aOrB, 'c'), false));
    it('parse-forest contains both branch results when both nullable', () => {
        const e1 = _.epsilon(1);
        const e2 = _.epsilon(2);
        assert.deepEqual(parse(_.or(e1, e2), '').sort(), [1, 2]);
    });
});

/* ─── Seq (A ○ B) ────────────────────────────────────────────────────── */

describe('Seq (A ○ B)', () => {
    const ab = _.seq(_.char('a'), _.char('b'));

    it('accepts the exact concatenation', () => {
        assert.equal(accepts(ab, 'ab'), true);
        assert.deepEqual(parse(ab, 'ab'), [['a', 'b']]);
    });
    it('rejects partial input', () => assert.equal(accepts(ab, 'a'), false));
    it('rejects reversed input', () => assert.equal(accepts(ab, 'ba'), false));
});

/* ─── Rep (A*) ───────────────────────────────────────────────────────── */

describe('Rep (A*)', () => {
    const aStar = _.char('a').many();

    it('accepts ε (empty match = [])', () => {
        assert.equal(accepts(aStar, ''), true);
        assert.deepEqual(parse(aStar, ''), [[]]);
    });
    it('accepts one token', () => {
        assert.deepEqual(parse(aStar, 'a'), [['a']]);
    });
    it('accepts multiple tokens', () => {
        assert.deepEqual(parse(aStar, 'aa'), [['a', 'a']]);
    });
    it('rejects non-matching tokens', () => assert.equal(accepts(aStar, 'b'), false));
});

/* ─── map / Red ──────────────────────────────────────────────────────── */

describe('map (semantic action)', () => {
    const num = _.char('1').map((c) => parseInt(c, 10));

    it('applies the function to parse trees', () => {
        assert.deepEqual(parse(num, '1'), [1]);
    });
    it('rejects non-matching input', () => assert.equal(accepts(num, '2'), false));
});

/* ─── literal ────────────────────────────────────────────────────────── */

describe('literal', () => {
    const hello = _.literal('hello');

    it('accepts the exact string', () => {
        assert.equal(accepts(hello, 'hello'), true);
        assert.deepEqual(parse(hello, 'hello'), ['hello']);
    });
    it('rejects a prefix', () => assert.equal(accepts(hello, 'hell'), false));
    it('rejects a superset', () => assert.equal(accepts(hello, 'helloo'), false));
});

/* ─── opt ────────────────────────────────────────────────────────────── */

describe('opt (A?)', () => {
    const mA = _.char('a').opt();

    it('accepts ε (value = undefined)', () => {
        assert.equal(accepts(mA, ''), true);
        assert.deepEqual(parse(mA, ''), [undefined]);
    });
    it('accepts the token', () => {
        assert.deepEqual(parse(mA, 'a'), ['a']);
    });
});


