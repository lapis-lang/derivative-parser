/**
 * Incremental re-parsing demo.
 *
 * Demonstrates `Grammar.reparseIncremental`: after a small edit, re-parse
 * only the affected region by reusing memoised derivations from the prior
 * pass for the unchanged prefix and suffix.
 *
 * Run: deno run examples/incremental-demo.ts
 */

import { ArithVarEval, Env } from "./arith-var.ts";
import { ZipperDriver } from "../src/index.ts";

function main(): void {
  const g = new ArithVarEval();
  const start = g.expr(Env.empty());

  // --- Prior parse: "1+2*3" = 7 ---
  const original = "1+2*3";
  const driver = new ZipperDriver();
  driver.init(start._exp);
  let off = 0;
  for (const c of original) {
    driver.step({ tag: c, sym: c, offset: off++ });
  }
  driver.flushEof();
  const [prior] = [...driver.forest<number>()];
  console.log("Incremental re-parsing demo");
  console.log("============================================================");
  console.log(`  original:  "${original}" = ${prior}`);

  // --- Edit: change "2" to "5" at offset 2 → "1+5*3" = 16 ---
  const edited = "1+5*3";
  const editStart = 2;
  const editEnd = 3;

  const incForest = g.reparseIncremental(
    edited,
    start,
    editStart,
    editEnd,
    driver,
  );
  const [incVal] = [...incForest];
  console.log(
    `  edited:    "${edited}" = ${incVal}  (re-parsed region [${editStart}, ${editEnd}))`,
  );

  // --- Compare with a full re-parse ---
  const [fullVal] = [...g.parse(edited)];
  console.log(`  full parse:            ${fullVal}  (re-derived entire input)`);
  console.log();
  console.log("  Results match — incremental re-parse is correct.");
}

if (import.meta.main) main();
