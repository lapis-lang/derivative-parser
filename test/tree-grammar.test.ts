/**
 * Tests for tree-consuming grammars: {@link TreeExp}, {@link flattenTree},
 * and {@link ZipperDriver.parseTree}. Also covers per-pass memo isolation
 * (Layer 0): running the engine twice over the same grammar must not leak
 * stale memo state from the first pass.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  flattenTree,
  Grammar,
  or,
  parserOf,
  rule,
  TreeExp,
} from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ── A tiny tree algebra for testing ─────────────────────────────────── */

class Num {
  constructor(readonly value: number) {}
}
class Add {
  constructor(readonly l: unknown, readonly r: unknown) {}
}
class Mul {
  constructor(readonly l: unknown, readonly r: unknown) {}
}

/** Children extractor for the test tree algebra. */
function childrenOf(node: unknown, tag: string): readonly unknown[] {
  if (tag === "Num") return [];
  if (tag === "Add" || tag === "Mul") {
    const n = node as Add;
    return [n.l, n.r];
  }
  return [];
}

/* ── A tree-consuming grammar: evaluates the tree to a number ────────── */

interface EvalShape {
  [k: string]: unknown;
  expr: unknown;
}

abstract class AbstractTreeEval extends Grammar<EvalShape> {
  /** `expr` matches any of the tree node alternatives. */
  @rule
  get expr(): Parser<unknown> {
    return or(
      this.numNode,
      this.addNode,
      this.mulNode,
    );
  }

  protected get numNode(): Parser<number> {
    return parserOf<number>(
      new TreeExp("Num", [], (node: unknown) => (node as Num).value),
    );
  }
  protected get addNode(): Parser<number> {
    return parserOf<number>(
      new TreeExp(
        "Add",
        [this.expr._exp, this.expr._exp],
        (_node: unknown, [l, r]: unknown[]) => (l as number) + (r as number),
      ),
    );
  }
  protected get mulNode(): Parser<number> {
    return parserOf<number>(
      new TreeExp(
        "Mul",
        [this.expr._exp, this.expr._exp],
        (_node: unknown, [l, r]: unknown[]) => (l as number) * (r as number),
      ),
    );
  }
}

class TreeEval extends AbstractTreeEval {
  override start(): Parser<unknown> {
    return this.expr;
  }
}

/* ── Tests ──────────────────────────────────────────────────────────── */

Deno.test("TreeExp — evaluates a single Num node", () => {
  const g = new TreeEval();
  const tree = new Num(42);
  const toks = flattenTree(tree, childrenOf);
  const [v] = [...g.parseTree(toks)];
  assertEquals(v, 42);
});

Deno.test("TreeExp — evaluates Add(Num, Num)", () => {
  const g = new TreeEval();
  const tree = new Add(new Num(3), new Num(4));
  const toks = flattenTree(tree, childrenOf);
  const [v] = [...g.parseTree(toks)];
  assertEquals(v, 7);
});

Deno.test("TreeExp — evaluates nested Mul(Add, Num)", () => {
  const g = new TreeEval();
  // (3 + 4) * 5 = 35
  const tree = new Mul(new Add(new Num(3), new Num(4)), new Num(5));
  const toks = flattenTree(tree, childrenOf);
  const [v] = [...g.parseTree(toks)];
  assertEquals(v, 35);
});

Deno.test("TreeExp — evaluates deep left-nested Add", () => {
  const g = new TreeEval();
  // ((1 + 2) + 3) + 4 = 10
  const tree = new Add(
    new Add(new Add(new Num(1), new Num(2)), new Num(3)),
    new Num(4),
  );
  const toks = flattenTree(tree, childrenOf);
  const [v] = [...g.parseTree(toks)];
  assertEquals(v, 10);
});

Deno.test("TreeExp — mismatched tag yields empty parse forest", () => {
  // A Num tree cannot match an Add-rooted grammar expectation at the top
  // because the root tag is "Num" and the grammar's start is `expr` which
  // *does* accept Num. To test a mismatch, build a grammar whose start only
  // accepts Add.
  class AddOnly extends AbstractTreeEval {
    override start(): Parser<unknown> {
      return this.addNode;
    }
  }
  const g2 = new AddOnly();
  const toks = flattenTree(new Num(5), childrenOf);
  const results = [...g2.parseTree(toks)];
  assertEquals(results.length, 0);
});

Deno.test("Layer 0 — per-pass memo isolation: two parses over same grammar", () => {
  // The critical regression test: running the engine twice over the same
  // grammar instance must not leak stale Mem state from pass 1 into pass 2.
  // Without Layer 0, the second parse would re-flow pass 1's values.
  const g = new TreeEval();
  const tree1 = new Add(new Num(10), new Num(20));
  const tree2 = new Mul(new Num(6), new Num(7));

  const [v1] = [...g.parseTree(flattenTree(tree1, childrenOf))];
  assertEquals(v1, 30);

  // Second pass over a DIFFERENT tree on the SAME grammar instance.
  // If memo isolation were broken, this would return 30 (stale) or fail.
  const [v2] = [...g.parseTree(flattenTree(tree2, childrenOf))];
  assertEquals(v2, 42);
  assertNotEquals(v2, 30);
});

Deno.test("Layer 0 — repeated identical parse still correct (memo reuse within a pass)", () => {
  // Within a single pass, memoisation should still work (the stale-Pos
  // check must not break same-pass memo reuse). Parse the same tree twice
  // in succession and confirm both give the right answer.
  const g = new TreeEval();
  const tree = new Add(new Num(1), new Num(2));
  const toks = flattenTree(tree, childrenOf);
  assertEquals([...g.parseTree(toks)][0], 3);
  assertEquals([...g.parseTree(toks)][0], 3);
});

Deno.test("flattenTree — preorder with correct arity and offsets", () => {
  const tree = new Mul(new Num(2), new Add(new Num(3), new Num(4)));
  const toks = flattenTree(tree, childrenOf);
  // Preorder: Mul, Num(2), Add, Num(3), Num(4)
  assertEquals(toks.length, 5);
  assertEquals(toks[0]!.tag, "Mul");
  assertEquals(toks[0]!.arity, 2);
  assertEquals(toks[1]!.tag, "Num");
  assertEquals(toks[1]!.arity, 0);
  assertEquals(toks[2]!.tag, "Add");
  assertEquals(toks[2]!.arity, 2);
  assertEquals(toks[3]!.tag, "Num");
  assertEquals(toks[4]!.tag, "Num");
  assertEquals(toks.map((t) => t.offset), [0, 1, 2, 3, 4]);
});
