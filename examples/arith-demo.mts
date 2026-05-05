/**
 * Runnable demo for `npm run example`.
 *
 * Evaluates a few arithmetic expressions, prints the AST for one of them,
 * and demonstrates the Bracha-style production override.
 */

import { MathAST, MathEval, MathTraced } from './arith.mjs';

const evalCases = ['42', '1+2+3', '1+2*3', '(1+2)*3'];
console.log('— MathEval (numeric evaluator) —');
for (const src of evalCases) {
    const result = [...new MathEval().parse(src)];
    console.log(`  ${src.padEnd(10)} → ${JSON.stringify(result)}`);
}

console.log('\n— MathAST (tree builder) —');
console.log(`  (1+2)*3 → ${JSON.stringify([...new MathAST().parse('(1+2)*3')])}`);

console.log('\n— MathTraced (Bracha-style override) —');
const traced = new MathTraced();
const out = [...traced.parse('1+2*3')];
console.log(`  result : ${JSON.stringify(out)}`);
console.log(`  trace  : ${JSON.stringify(traced.trace)}`);
