/**
 * Runnable demo for untyped lambda calculus evaluator.
 */

import { LambdaAST, lambdaEval, UTClosure, UTValEnv } from "./lambda-eval.ts";

const g = new LambdaAST();

const cases = [
  "\\x.x",
  "let id = \\x.x in id id",
  "(\\x.\\y.x) (\\z.z) (\\w.w)",
];

for (const src of cases) {
  const asts = [...g.parse(src)];
  if (asts.length === 0) {
    console.log(`  ${src.padEnd(35)} → PARSE FAILED`);
    continue;
  }
  const ast = asts[0]!;
  try {
    const v = lambdaEval(ast, UTValEnv.empty());
    const desc = v instanceof UTClosure ? `<closure ${v.param}>` : String(v);
    console.log(`  ${src.padEnd(35)} ⇓ ${desc}`);
  } catch (e) {
    console.log(`  ${src.padEnd(35)} → ERROR: ${(e as Error).message}`);
  }
}
