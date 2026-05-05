/**
 * Phase 4 — exercises the shape-typed Grammar pattern + Bracha-style
 * production override (`super.expr().map(...)`).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { MathAST, MathEval, MathTraced, type Exp } from '../examples/arith.mjs';

describe('Shape-typed grammar — MathEval (numbers)', () => {
    const g = new MathEval();
    it('evaluates a single number', () => {
        assert.deepEqual([...g.parse('42')], [42]);
    });
    it('evaluates addition', () => {
        assert.deepEqual([...g.parse('1+2+3')], [6]);
    });
    it('evaluates precedence (* binds tighter than +)', () => {
        assert.deepEqual([...g.parse('1+2*3')], [7]);
    });
    it('evaluates parenthesised expressions', () => {
        assert.deepEqual([...g.parse('(1+2)*3')], [9]);
    });
    it('rejects malformed input', () => {
        assert.equal(g.recognize('1+'), false);
    });
});

describe('Shape-typed grammar — MathAST (tree)', () => {
    const g = new MathAST();
    it('builds a num leaf', () => {
        const trees = [...g.parse('7')];
        assert.deepEqual(trees, [{ tag: 'num', value: 7 }]);
    });
    it('builds an add tree (left-associative via left-recursion)', () => {
        const trees = [...g.parse('1+2')];
        assert.equal(trees.length, 1);
        const t = trees[0]!;
        assert.equal(t.tag, 'add');
        assert.deepEqual(t, {
            tag: 'add',
            left: { tag: 'num', value: 1 },
            right: { tag: 'num', value: 2 },
        } as Exp);
    });
});

describe('Bracha-style production override — MathTraced', () => {
    it('records every successful expr parse via super.expr().map(...)', () => {
        const g = new MathTraced();
        const result = [...g.parse('1+2*3')];
        assert.deepEqual(result, [7]);
        // Trace contains the final expr value (and any intermediate
        // sub-expressions whose `expr` rule succeeded). At minimum the
        // final value must be present.
        assert.ok(g.trace.includes(7), `trace should include 7, got: ${g.trace.join(',')}`);
    });
});
