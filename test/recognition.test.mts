/**
 * Recognition tests on canonical (left-)recursive grammars.
 * Demonstrates that derivative parsing terminates on cyclic grammars via the
 * lazy `@rule` reference + LFP nullable.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Grammar, rule } from '../src/index.mjs';
import type { Parser } from '../src/index.mjs';

/* ─── Balanced parens (right-recursive form) ─────────────────────────── */
//   S = '(' S ')' S | ε
class BalancedParens extends Grammar<{ s: string }> {
    start(): Parser<string> { return this.s; }

    @rule get s(): Parser<string> {
        return this.or(
            this.seq(this.char('('), this.s, this.char(')'), this.s).map(() => 'ok'),
            this.epsilon('ok'),
        );
    }
}

describe('Balanced parens (right-recursive)', () => {
    const g = new BalancedParens();

    it('accepts ε', () => assert.equal(g.recognize(''), true));
    it('accepts ()', () => assert.equal(g.recognize('()'), true));
    it('accepts (())', () => assert.equal(g.recognize('(())'), true));
    it('accepts ()()', () => assert.equal(g.recognize('()()'), true));
    it('accepts deeply nested', () => assert.equal(g.recognize('((()))'), true));
    it('rejects (', () => assert.equal(g.recognize('('), false));
    it('rejects )(', () => assert.equal(g.recognize(')('), false));
    it('rejects (()', () => assert.equal(g.recognize('(()'), false));
});

/* ─── Left-recursive arithmetic — Russ Cox's "ambiguous" challenge ─────── */
//   S = S '+' S | '1'
class AmbiguousAdd extends Grammar<{ s: number }> {
    start(): Parser<number> { return this.s; }

    @rule get s(): Parser<number> {
        return this.or(
            this.seq(this.s, this.char('+'), this.s)
                .map(([l, , r]) => l + r),
            this.char('1').map(() => 1),
        );
    }
}

describe('Left-recursive ambiguous add (S = S+S | 1)', () => {
    const g = new AmbiguousAdd();

    it('accepts 1', () => assert.equal(g.recognize('1'), true));
    it('accepts 1+1', () => assert.equal(g.recognize('1+1'), true));
    it('accepts 1+1+1', () => assert.equal(g.recognize('1+1+1'), true));
    it('rejects 1+', () => assert.equal(g.recognize('1+'), false));
    it('rejects ++', () => assert.equal(g.recognize('++'), false));
    it('terminates on a moderate chained input', () => {
        const input = Array(20).fill('1').join('+');
        const t0 = Date.now();
        assert.equal(g.recognize(input), true);
        assert.ok(Date.now() - t0 < 5000, `should finish in < 5s (took ${Date.now() - t0}ms)`);
    });
    it('rejects a moderate chained invalid input', () => {
        const input = Array(20).fill('1').join('+') + '++';
        const t0 = Date.now();
        assert.equal(g.recognize(input), false);
        assert.ok(Date.now() - t0 < 5000, `should finish in < 5s (took ${Date.now() - t0}ms)`);
    });
});
