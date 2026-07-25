/**
 * Phase 4 — exercises the shape-typed Grammar pattern + Bracha-style
 * production override (`super.expr().map(...)`).
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { type Exp, MathAST, MathEval, MathTraced } from "../examples/arith.ts";

Deno.test("Shape-typed grammar — MathEval (numbers)", async (t) => {
  const g = new MathEval();
  await t.step("evaluates a single number", () => {
    assertEquals([...g.parse("42")], [42]);
  });
  await t.step("evaluates addition", () => {
    assertEquals([...g.parse("1+2+3")], [6]);
  });
  await t.step("evaluates precedence (* binds tighter than +)", () => {
    assertEquals([...g.parse("1+2*3")], [7]);
  });
  await t.step("evaluates parenthesised expressions", () => {
    assertEquals([...g.parse("(1+2)*3")], [9]);
  });
  await t.step("rejects malformed input", () => {
    assertEquals(g.recognize("1+"), false);
  });
});

Deno.test("Shape-typed grammar — MathAST (tree)", async (t) => {
  const g = new MathAST();
  await t.step("builds a num leaf", () => {
    const trees = [...g.parse("7")];
    assertEquals(trees, [{ tag: "num", value: 7 }]);
  });
  await t.step(
    "builds an add tree (left-associative via left-recursion)",
    () => {
      const trees = [...g.parse("1+2")];
      assertEquals(trees.length, 1);
      const tree = trees[0]!;
      assertEquals(tree.tag, "add");
      assertEquals(tree, {
        tag: "add",
        left: { tag: "num", value: 1 },
        right: { tag: "num", value: 2 },
      } as Exp);
    },
  );
});

Deno.test("Bracha-style production override — MathTraced", async (t) => {
  await t.step(
    "records every successful expr parse via super.expr().map(...)",
    () => {
      const g = new MathTraced();
      const result = [...g.parse("1+2*3")];
      assertEquals(result, [7]);
      // Trace contains the final expr value (and any intermediate
      // sub-expressions whose `expr` rule succeeded). At minimum the
      // final value must be present.
      assertExists(g.trace.find((v) => v === 7));
      assert(
        g.trace.includes(7),
        `trace should include 7, got: ${g.trace.join(",")}`,
      );
    },
  );
});
