/**
 * Runnable demo for arithmetic with variables.
 *
 * Shows the two interpretations of the same parameterised grammar:
 *  • ArithVarEval  — evaluates under an environment
 *  • ArithVarAST   — builds an AST (env threaded but ignored)
 */

import { ArithVarAST, ArithVarEval, Env } from "./arith-var.ts";

const env = Env.empty().extend("x", 3).extend("y", 4);

const evalCases = ["42", "x*y + 2", "(x+1)*y", "x*x + y*y"];
console.log("— ArithVarEval (numeric evaluator under env {x:3, y:4}) —");
for (const src of evalCases) {
  const result = [...new ArithVarEval().parseWith(src, env)];
  console.log(`  ${src.padEnd(12)} → ${JSON.stringify(result)}`);
}

console.log("\n— ArithVarAST (tree builder; env ignored) —");
console.log(
  `  x*y + 2 → ${JSON.stringify([...new ArithVarAST().parseWith("x*y + 2", env)])}`,
);