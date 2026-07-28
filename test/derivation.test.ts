/**
 * Tests for retained derivation trees: `DerivationNode`,
 * `DerivationTree`, `buildDerivationTrees`, `derivationToTreeToks`,
 * `Grammar.parseToTree`.
 */

import {
  assertEquals,
} from "@std/assert";
import {
  buildDerivationTrees,
  derivationToTreeToks,
  DerivationNode,
  DerivationTree,
  Grammar,
  rule,
  or,
  seq,
  char,
  epsilon,
  type DerivationRecord,
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

/* ── derivationToTreeToks ────────────────────────────────────────────── */

Deno.test("derivationToTreeToks — flattens a simple tree", () => {
  const leaf = new DerivationNode("s", { start: 2, end: 4 }, []);
  const mid = new DerivationNode("s", { start: 1, end: 5 }, [leaf]);
  const root = new DerivationNode("s", { start: 0, end: 6 }, [mid]);
  const tree = new DerivationTree(root, "aaabbb");

  const toks = derivationToTreeToks(tree);
  assertEquals(toks.length, 3);
  // Preorder: root, mid, leaf
  assertEquals(toks[0]!.tag, "s");
  assertEquals(toks[0]!.offset, 0);
  assertEquals(toks[0]!.arity, 1);
  assertEquals(toks[0]!.subtreeSize, 3);
  assertEquals(toks[1]!.tag, "s");
  assertEquals(toks[1]!.offset, 1);
  assertEquals(toks[1]!.arity, 1);
  assertEquals(toks[1]!.subtreeSize, 2);
  assertEquals(toks[2]!.tag, "s");
  assertEquals(toks[2]!.offset, 2);
  assertEquals(toks[2]!.arity, 0);
  assertEquals(toks[2]!.subtreeSize, 1);
});

Deno.test("derivationToTreeToks — single node", () => {
  const root = new DerivationNode("s", { start: 0, end: 6 }, []);
  const tree = new DerivationTree(root, "aaabbb");
  const toks = derivationToTreeToks(tree);
  assertEquals(toks.length, 1);
  assertEquals(toks[0]!.tag, "s");
  assertEquals(toks[0]!.arity, 0);
  assertEquals(toks[0]!.subtreeSize, 1);
});

/* ── Grammar.parseToTree ────────────────────────────────────────────── */

// Simple grammar: S → "a" S "b" | ε  (balanced a^n b^n)
class Balanced extends Grammar<{ s: string }> {
  start() { return this.s; }
  @rule get s(): Parser<string> {
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
