/**
 * Runnable demo for untyped lambda calculus evaluator.
 */

import { LambdaEval, UTClosure, UTValEnv } from "./lambda-eval.ts";

const g = new LambdaEval();

const cases = [
  "\\x.x",
  "let id = \\x.x in id id",
  "(\\x.\\y.x) (\\z.z) (\\w.w)",
];

for (const src of cases) {
  const results = [...g.parseWith(src, UTValEnv.empty())];
  if (results.length === 0) {
    console.log(`  ${src.padEnd(35)} → PARSE FAILED`);
    continue;
  }
  const v = results[0]!;
  const desc = v instanceof UTClosure ? `<closure ${v.param}>` : String(v);
  console.log(`  ${src.padEnd(35)} ⇓ ${desc}`);
}
