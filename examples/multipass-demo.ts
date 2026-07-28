/**
 * Multi-pass parsing demo — parse once structurally, then run multiple
 * semantic passes over the retained derivation tree.
 *
 * Contrast with `arith-demo.ts`, which instantiates separate grammar
 * subclasses (`MathEval`, `MathAST`) that each re-parse the input
 * independently. Here, we parse once via `parseToTree`, then walk the
 * retained derivation tree with multiple semantic passes.
 *
 * The retained derivation tree (`DerivationNode`) captures which `@rule`
 * production matched where, with child relationships and source spans.
 * Multiple passes walk this tree independently — no re-parsing.
 */

import {
  derivationToTreeToks,
  exactTreeExp,
  foldTree,
  Grammar,
  rule,
  or,
  seq,
  char,
  epsilon,
  type DerivationNode,
} from "../src/index.ts";
import type { Parser } from "../src/Parser.ts";

/* ── A simple grammar: S → "a" S "b" | ε  (balanced a^n b^n) ─────────── */

class Balanced extends Grammar<{ s: string }> {
  start() { return this.s; }
  @rule get s(): Parser<string> {
    return or(
      seq(char("a"), this.s, char("b")).map(() => "ok"),
      epsilon("ok"),
    );
  }
}

/* ── Step 1: Parse once structurally — retain the derivation tree ────── */

const source = "aaabbb";
const parser = new Balanced();
const { forest, trees } = parser.parseToTree(source);

console.log("— Multi-pass: parse once, evaluate many ways —");
console.log(`  source: "${source}"`);
console.log(`  inline parse: ${[...forest][0]}`);

if (trees.length === 0) {
  console.error("  No derivation tree captured!");
  Deno.exit(1);
}

const tree = trees[0]!;

/* ── Step 2: Inspect the derivation tree ──────────────────────────────── */

function printTree(node: DerivationNode, indent: string): void {
  console.log(`${indent}${node.label} [${node.span.start},${node.span.end}) children=${node.children.length}`);
  for (const c of node.children) printTree(c, indent + "  ");
}

console.log("\n  derivation tree:");
printTree(tree.root, "    ");

/* ── Step 3: Decorator #1 — depth (foldTree) ─────────────────────────── */
//
// `foldTree` is the simplest way to run a semantic pass over a derivation
// tree — no grammar subclass, no TreeExp, no engine. Each handler receives
// the node and the already-folded child results.

const depth = foldTree<number>(tree, {
  s: (_node, childResults) =>
    childResults.length === 0 ? 0 : 1 + Math.max(...childResults),
});

console.log(`\n  decorator #1 (depth):     ${depth}`);

/* ── Step 4: Decorator #2 — count nodes (foldTree) ──────────────────── */

const count = foldTree<number>(tree, {
  s: (_node, childResults) => 1 + childResults.reduce((sum, c) => sum + c, 0),
});

console.log(`  decorator #2 (count):     ${count}`);

/* ── Step 5: Decorator #3 — extract source spans (foldTree) ─────────── */

const spans = foldTree(tree, {
  s: (node, childResults) => {
    const self = `${node.label}[${node.span.start},${node.span.end})`;
    return childResults.length === 0 ? self : `${self}, ${childResults.join(", ")}`;
  },
});

console.log(`  decorator #3 (spans):     ${spans}`);

/* ── Step 6: Decorator #4 — TreeExp grammar over the derivation tree ── */
//
// For passes that need grammar-level features (ambiguity handling,
// memoization, composition with other grammar passes), a `TreeExp`-based
// decorator grammar can consume the derivation tree via
// `derivationToTreeToks` + `parseTree`. The `exactTreeExp` helper accepts
// `Parser<T>` children (not raw `Exp`) and ensures exact-arity matching.

class RootSpanDecorator extends Grammar<{ s: string }> {
  start() { return this.s; }
  @rule get s(): Parser<string> {
    return or(
      exactTreeExp("s", 1, [this.s], (node: unknown) => {
        const n = node as DerivationNode;
        return `[${n.span.start},${n.span.end})`;
      }),
      exactTreeExp("s", 0, [], (node: unknown) => {
        const n = node as DerivationNode;
        return `[${n.span.start},${n.span.end})`;
      }),
    );
  }
}

const toks = derivationToTreeToks(tree);
const rootSpanResult = new RootSpanDecorator().parseTree(toks);
console.log(`  decorator #4 (TreeExp):   ${[...rootSpanResult][0]}`);

/* ── Contrast: the old way re-parses for each pass ──────────────────── */

console.log("\n— Contrast: old way (re-parse per pass) —");
console.log(`  Balanced.parse:          ${[...new Balanced().parse(source)][0]}`);

console.log("\n— Done —");
