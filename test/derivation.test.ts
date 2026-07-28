/**
 * Tests for retained derivation trees: `DerivationNode`,
 * `DerivationTree`, `buildDerivationTrees`, `Grammar.parseToTree`,
 * and `SemanticPass`.
 */

import { assertEquals } from "@std/assert";
import {
  buildDerivationTrees,
  char,
  DerivationNode,
  type DerivationRecord,
  DerivationTree,
  ensures,
  epsilon,
  Grammar,
  or,
  rule,
  SemanticPass,
  seq,
} from "../src/index.ts";
import type { Parser } from "../src/Parser.ts";

/* ── DerivationNode / DerivationTree ─────────────────────────────────── */

Deno.test("DerivationNode — construction and immutability", () => {
  const leaf = new DerivationNode("factor", { start: 0, end: 1 }, []);
  assertEquals(leaf.label, "factor");
  assertEquals(leaf.span, { start: 0, end: 1 });
  assertEquals(leaf.children.length, 0);

  const parent = new DerivationNode("expr", { start: 0, end: 5 }, [leaf]);
  assertEquals(parent.label, "expr");
  assertEquals(parent.span, { start: 0, end: 5 });
  assertEquals(parent.children.length, 1);
  assertEquals(parent.children[0], leaf);
});

Deno.test("DerivationTree — carries source string", () => {
  const root = new DerivationNode("s", { start: 0, end: 6 }, []);
  const tree = new DerivationTree(root, "aaabbb");
  assertEquals(tree.source, "aaabbb");
  assertEquals(tree.root, root);
});

/* ── buildDerivationTrees ────────────────────────────────────────────── */

Deno.test("buildDerivationTrees — empty records yields empty array", () => {
  assertEquals(buildDerivationTrees([], ""), []);
});

Deno.test("buildDerivationTrees — single record yields single tree", () => {
  const records: DerivationRecord[] = [
    { label: "s", span: { start: 0, end: 6 }, seq: 0 },
  ];
  const trees = buildDerivationTrees(records, "aaabbb");
  assertEquals(trees.length, 1);
  assertEquals(trees[0]!.root.label, "s");
  assertEquals(trees[0]!.root.span, { start: 0, end: 6 });
  assertEquals(trees[0]!.root.children.length, 0);
});

Deno.test("buildDerivationTrees — nested records form parent-child hierarchy", () => {
  // Simulate: s[0,6) → s[1,5) → s[2,4)
  const records: DerivationRecord[] = [
    { label: "s", span: { start: 2, end: 4 }, seq: 0 }, // innermost (completed first)
    { label: "s", span: { start: 1, end: 5 }, seq: 1 },
    { label: "s", span: { start: 0, end: 6 }, seq: 2 }, // outermost (completed last)
  ];
  const trees = buildDerivationTrees(records, "aaabbb");
  assertEquals(trees.length, 1);
  const root = trees[0]!.root;
  assertEquals(root.span, { start: 0, end: 6 });
  assertEquals(root.children.length, 1);
  assertEquals(root.children[0]!.span, { start: 1, end: 5 });
  assertEquals(root.children[0]!.children.length, 1);
  assertEquals(root.children[0]!.children[0]!.span, { start: 2, end: 4 });
});

Deno.test("buildDerivationTrees — same-span records nest by completion order", () => {
  // Simulate passthrough: expr[0,1) → term[0,1) → factor[0,1)
  const records: DerivationRecord[] = [
    { label: "factor", span: { start: 0, end: 1 }, seq: 0 }, // innermost
    { label: "term", span: { start: 0, end: 1 }, seq: 1 },
    { label: "expr", span: { start: 0, end: 1 }, seq: 2 }, // outermost
  ];
  const trees = buildDerivationTrees(records, "3");
  assertEquals(trees.length, 1);
  const root = trees[0]!.root;
  assertEquals(root.label, "expr");
  assertEquals(root.children.length, 1);
  assertEquals(root.children[0]!.label, "term");
  assertEquals(root.children[0]!.children.length, 1);
  assertEquals(root.children[0]!.children[0]!.label, "factor");
});

Deno.test("buildDerivationTrees — zero-length spans are filtered", () => {
  const records: DerivationRecord[] = [
    { label: "s", span: { start: 0, end: 0 }, seq: 0 }, // epsilon — filtered
    { label: "s", span: { start: 0, end: 6 }, seq: 1 },
  ];
  const trees = buildDerivationTrees(records, "aaabbb");
  assertEquals(trees.length, 1);
  assertEquals(trees[0]!.root.span, { start: 0, end: 6 });
  assertEquals(trees[0]!.root.children.length, 0);
});

/* ── Grammar.parseToTree ────────────────────────────────────────────── */

// Simple grammar: S → "a" S "b" | ε  (balanced a^n b^n)
class Balanced extends Grammar<{ s: string }> {
  start() {
    return this.s;
  }
  @rule
  get s(): Parser<string> {
    return or(
      seq(char("a"), this.s, char("b")).map(() => "ok"),
      epsilon("ok"),
    );
  }
}

Deno.test("parseToTree — captures derivation tree for balanced parens", () => {
  const g = new Balanced();
  const { forest, trees } = g.parseToTree("aaabbb");

  // The inline parse should still work
  assertEquals([...forest][0], "ok");

  // One derivation tree
  assertEquals(trees.length, 1);
  const tree = trees[0]!;
  assertEquals(tree.source, "aaabbb");

  // Root spans the full input
  assertEquals(tree.root.label, "s");
  assertEquals(tree.root.span, { start: 0, end: 6 });

  // Root has one child (the recursive S)
  assertEquals(tree.root.children.length, 1);
  const child = tree.root.children[0]!;
  assertEquals(child.label, "s");
  assertEquals(child.span, { start: 1, end: 5 });

  // Grandchild
  assertEquals(child.children.length, 1);
  const grandchild = child.children[0]!;
  assertEquals(grandchild.label, "s");
  assertEquals(grandchild.span, { start: 2, end: 4 });
  assertEquals(grandchild.children.length, 0);
});

Deno.test("parseToTree — empty input (epsilon match)", () => {
  const g = new Balanced();
  const { forest, trees } = g.parseToTree("");

  assertEquals([...forest][0], "ok");
  // Epsilon match produces a zero-length span, which is filtered
  // → no derivation tree
  assertEquals(trees.length, 0);
});

Deno.test("parseToTree — single pair 'ab'", () => {
  const g = new Balanced();
  const { trees } = g.parseToTree("ab");

  assertEquals(trees.length, 1);
  const tree = trees[0]!;
  assertEquals(tree.root.label, "s");
  assertEquals(tree.root.span, { start: 0, end: 2 });
  // The inner S matched epsilon (filtered) → no children
  assertEquals(tree.root.children.length, 0);
});

Deno.test("parseToTree — rejected input yields empty forest", () => {
  const g = new Balanced();
  const { forest } = g.parseToTree("aab");

  // The full parse fails (not enough b's)
  assertEquals(forest.size, 0);
  // Note: partial matches may still produce derivation records/trees,
  // but the forest is empty because no complete parse succeeded.
});

Deno.test("parseToTree — inline parse() is unaffected (zero overhead)", () => {
  const g = new Balanced();
  // parse() should work exactly as before
  const result = g.parse("aaabbb");
  assertEquals([...result][0], "ok");
});

/* ── SemanticPass ───────────────────────────────────────────────────── */

// Reuse the Balanced grammar from the parseToTree tests above.

/** Depth pass: leaf = 0, internal = 1 + max(children). */
class DepthPass extends SemanticPass<{ s: number }> {
  s(_node: DerivationNode, children: number[]): number {
    return children.length === 0 ? 0 : 1 + Math.max(...children);
  }
}

/** Count pass: count all nodes. */
class CountPass extends SemanticPass<{ s: number }> {
  s(_node: DerivationNode, children: number[]): number {
    return 1 + children.reduce((sum, c) => sum + c, 0);
  }
}

/** Span extraction pass: returns a string of all spans. */
class SpanPass extends SemanticPass<{ s: string }> {
  s(node: DerivationNode, children: string[]): string {
    const self = `${node.label}[${node.span.start},${node.span.end})`;
    return children.length === 0 ? self : `${self}, ${children.join(", ")}`;
  }
}

Deno.test("SemanticPass — depth of balanced a^n b^n tree", () => {
  const g = new Balanced();
  const { trees } = g.parseToTree("aaabbb");
  const tree = trees[0]!;
  const depth = new DepthPass().evaluate(tree);
  // "aaabbb" → 2 levels of nesting: s[0,6) → s[1,5) → s[2,4) (leaf, depth 0)
  // s[2,4) depth=0, s[1,5) depth=1, s[0,6) depth=2
  assertEquals(depth, 2);
});

Deno.test("SemanticPass — count nodes in balanced tree", () => {
  const g = new Balanced();
  const { trees } = g.parseToTree("aaabbb");
  const tree = trees[0]!;
  const count = new CountPass().evaluate(tree);
  // 3 non-epsilon s nodes
  assertEquals(count, 3);
});

Deno.test("SemanticPass — extract spans from balanced tree", () => {
  const g = new Balanced();
  const { trees } = g.parseToTree("aaabbb");
  const tree = trees[0]!;
  const spans = new SpanPass().evaluate(tree);
  assertEquals(spans, "s[0,6), s[1,5), s[2,4)");
});

Deno.test("SemanticPass — leaf node (single pair 'ab')", () => {
  const g = new Balanced();
  const { trees } = g.parseToTree("ab");
  const tree = trees[0]!;
  const depth = new DepthPass().evaluate(tree);
  // Single pair: root s has no children (inner s matched epsilon, filtered)
  assertEquals(depth, 0);
});

Deno.test("SemanticPass — defaultHandler throws for arity-0 node (no method)", () => {
  // A pass that doesn't override 's' — defaultHandler should passthrough
  // the single child's result, but throw for arity-0.
  class PassthroughPass extends SemanticPass<{ s: number }> {
    // No s() method — relies on defaultHandler
  }
  const g = new Balanced();
  const { trees } = g.parseToTree("ab");
  const tree = trees[0]!;
  // Root s has 0 children (epsilon filtered) → defaultHandler throws
  let threw = false;
  try {
    new PassthroughPass().evaluate(tree);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("SemanticPass — defaultHandler passthrough for arity-1 node", () => {
  // A pass that doesn't override 'mid' — defaultHandler should passthrough
  // the single child's result for a 1-child node.
  class LeafPass extends SemanticPass<{ s: number }> {
    s(_node: DerivationNode, _children: number[]): number {
      return 42;
    }
  }
  // Build a tree: leaf (label "s", arity 0, has s method) → mid (label "mid", arity 1, no method).
  const leaf = new DerivationNode("s", { start: 1, end: 2 }, []);
  const mid = new DerivationNode("mid", { start: 0, end: 2 }, [leaf]);
  const tree = new DerivationTree(mid, "ab");
  // 'mid' has no method → defaultHandler passthrough returns leaf's result (42)
  const result = new LeafPass().evaluate(tree);
  assertEquals(result, 42);
});

Deno.test("SemanticPass — defaultHandler throws for arity != 1", () => {
  class ThrowingPass extends SemanticPass<{ s: number }> {
    // No s() method, no defaultHandler override
  }
  // Build a tree with a 2-child root manually
  const c1 = new DerivationNode("s", { start: 0, end: 1 }, []);
  const c2 = new DerivationNode("s", { start: 1, end: 2 }, []);
  const root = new DerivationNode("s", { start: 0, end: 2 }, [c1, c2]);
  const tree = new DerivationTree(root, "ab");
  let threw = false;
  try {
    new ThrowingPass().evaluate(tree);
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message.includes("SemanticPass"), true);
  }
  assertEquals(threw, true);
});

Deno.test("SemanticPass — custom defaultHandler override", () => {
  class CustomDefaultPass extends SemanticPass<{ s: number }> {
    protected override defaultHandler(
      _node: DerivationNode,
      childResults: readonly unknown[],
    ): unknown {
      return childResults.length;
    }
  }
  const c1 = new DerivationNode("s", { start: 0, end: 1 }, []);
  const c2 = new DerivationNode("s", { start: 1, end: 2 }, []);
  const root = new DerivationNode("s", { start: 0, end: 2 }, [c1, c2]);
  const tree = new DerivationTree(root, "ab");
  const result = new CustomDefaultPass().evaluate(tree);
  // Root has 2 children, no s() method → custom defaultHandler returns 2
  assertEquals(result, 2);
});

Deno.test("SemanticPass — inheritance composition (override one method)", () => {
  // Base pass computes depth; subclass overrides to compute double depth
  class DoubleDepthPass extends DepthPass {
    override s(node: DerivationNode, children: number[]): number {
      const base = super.s(node, children);
      return base * 2;
    }
  }
  const g = new Balanced();
  const { trees } = g.parseToTree("aaabbb");
  const tree = trees[0]!;
  const depth = new DoubleDepthPass().evaluate(tree);
  // Each node's result is doubled, including children:
  // leaf: 0→0, middle: 1+0=1→2, root: 1+2=3→6
  assertEquals(depth, 6);
});

Deno.test("SemanticPass — @ensures contract is enforced on semantic methods", () => {
  // Contracts on SemanticPass methods work via the same wrapWithContracts
  // Proxy as Grammar. A violating subclass should throw ContractError.
  class NonNegativePass extends SemanticPass<{ s: number }> {
    @ensures((_self, _node, _children, result) => result >= 0)
    s(_node: DerivationNode, children: number[]): number {
      return children.length === 0 ? 0 : 1 + Math.max(...children);
    }
  }
  // A subclass that violates the postcondition
  class ViolatingPass extends NonNegativePass {
    override s(_node: DerivationNode, _children: number[]): number {
      return -1; // violates @ensures (result >= 0)
    }
  }
  const g = new Balanced();
  const { trees } = g.parseToTree("ab");
  const tree = trees[0]!;

  // The base pass should work fine (result = 0, satisfies >= 0)
  const ok = new NonNegativePass().evaluate(tree);
  assertEquals(ok, 0);

  // The violating pass should throw ContractError
  let threw = false;
  let caught: unknown = null;
  try {
    new ViolatingPass().evaluate(tree);
  } catch (e) {
    threw = true;
    caught = e;
  }
  assertEquals(threw, true);
  assertEquals((caught as Error).name, "ContractError");
});

Deno.test("SemanticPass — stateful pass (inherited attribute via this)", () => {
  // A pass that collects all labels into an array via instance state
  class CollectLabelsPass extends SemanticPass<{ s: string[] }> {
    private labels: string[] = [];

    s(node: DerivationNode, _children: string[][]): string[] {
      this.labels.push(node.label);
      return [...this.labels];
    }
  }
  const g = new Balanced();
  const { trees } = g.parseToTree("aaabbb");
  const tree = trees[0]!;
  const result = new CollectLabelsPass().evaluate(tree);
  // 3 s nodes, each returns the accumulated labels
  assertEquals(result, ["s", "s", "s"]);
});
