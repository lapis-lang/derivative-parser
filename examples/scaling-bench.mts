/**
 * Scaling benchmark: `S = S+S | 1` ambiguous left-recursive grammar.
 *
 * The unified Grammar engine (Parsing-with-Zippers + semantic actions)
 * is exercised at increasing input sizes to demonstrate asymptotic behaviour.
 *
 * Inputs are `1+1+…+1` with `n` ones.
 */

import { Grammar, rule } from '../src/index.mjs';
import type { Parser } from '../src/index.mjs';

class Ambig extends Grammar<{ s: number }> {
    start(): Parser<number> { return this.s; }
    @rule get s(): Parser<number> {
        return this.or(
            this.seq(this.s, this.char('+'), this.s).map(([l, , r]) => l + r),
            this.char('1').map(() => 1),
        );
    }
}

function inputOf(n: number): string {
    return Array(n).fill('1').join('+');
}

function timeMs(label: string, fn: () => boolean): { ok: boolean; ms: number } | null {
    try {
        const t0 = performance.now();
        const ok = fn();
        const ms = performance.now() - t0;
        console.log(`  ${label.padEnd(18)}  ok=${ok}  ${ms.toFixed(1)} ms`);
        return { ok, ms };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  ${label.padEnd(18)}  FAILED: ${msg.split('\n')[0]}`);
        return null;
    }
}

function run(n: number, budgetMs: number, alive: { ok: boolean }): void {
    const input = inputOf(n);
    console.log(`\n n = ${n}  (input length = ${input.length})`);
    if (alive.ok) {
        const r = timeMs('Grammar (PwZ)', () => new Ambig().recognize(input));
        if (r === null || r.ms > budgetMs) {
            alive.ok = false;
            console.log(`    (over budget — skipping for n > ${n})`);
        }
    } else {
        console.log(`  Grammar (PwZ)       (skipped)`);
    }
}

console.log('S = S+S | 1   benchmark  (Grammar · PwZ engine)');
console.log('================================================');

const alive = { ok: true };
for (const n of [10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000]) {
    run(n, 5_000, alive);
}
