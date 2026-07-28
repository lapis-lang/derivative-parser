/**
 * Multi-pass parsing demo — parse once structurally, then run multiple
 * semantic passes over the retained derivation tree using `SemanticPass`.
 *
 * Contrast with `arith-demo.ts`, which instantiates separate grammar
 * subclasses (`MathEval`, `MathAST`) that each re-parse the input
 * independently. Here, we parse once via `parseToTree`, then walk the
 * retained derivation tree with multiple `SemanticPass` subclasses.
 *
 * The retained derivation tree (`DerivationNode`) captures which `@rule`
 * production matched where, with child relationships and source spans.
 * Multiple passes walk this tree independently — no re-parsing.
 */

import {
  char,
  type DerivationNode,
  epsilon,
  Grammar,
  or,
  rule,
  SemanticPass,
  seq,
} from "../src/index.ts";
import type { Parser } from "../src/Parser.ts";

/* ── A simple grammar: S → "a" S "b" | ε  (balanced a^n b^n) ─────────── */

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
  console.log(
    `${indent}${node.label} [${node.span.start},${node.span.end}) children=${node.children.length}`,
  );
  for (const c of node.children) printTree(c, indent + "  ");
}

console.log("\n  derivation tree:");
printTree(tree.root, "    ");

/* ── Step 3: Pass #1 — depth (SemanticPass) ──────────────────────────── */
//
// `SemanticPass` is the OOP-native way to run a semantic pass: subclass and
// override a method named after each production label. The method receives
// the `DerivationNode` and the already-computed child results.

class DepthPass extends SemanticPass<{ s: number }> {
  s(_node: DerivationNode, children: number[]): number {
    return children.length === 0 ? 0 : 1 + Math.max(...children);
  }
}

const depth = new DepthPass().evaluate(tree);
console.log(`\n  pass #1 (depth):     ${depth}`);

/* ── Step 4: Pass #2 — count nodes (SemanticPass) ────────────────────── */

class CountPass extends SemanticPass<{ s: number }> {
  s(_node: DerivationNode, children: number[]): number {
    return 1 + children.reduce((sum, c) => sum + c, 0);
  }
}

const count = new CountPass().evaluate(tree);
console.log(`  pass #2 (count):     ${count}`);

/* ── Step 5: Pass #3 — extract source spans (SemanticPass) ──────────── */

class SpanPass extends SemanticPass<{ s: string }> {
  s(node: DerivationNode, children: string[]): string {
    const self = `${node.label}[${node.span.start},${node.span.end})`;
    return children.length === 0 ? self : `${self}, ${children.join(", ")}`;
  }
}

const spans = new SpanPass().evaluate(tree);
console.log(`  pass #3 (spans):     ${spans}`);

/* ── Step 6: Pass #4 — inheritance composition (Decorator pattern) ─── */
//
// A subclass can override one method and inherit the rest from a base pass.
// This is the Decorator pattern: `DoubleDepthPass` decorates `DepthPass`.

class DoubleDepthPass extends DepthPass {
  override s(node: DerivationNode, children: number[]): number {
    return super.s(node, children) * 2;
  }
}

const doubleDepth = new DoubleDepthPass().evaluate(tree);
console.log(`  pass #4 (2×depth):   ${doubleDepth}`);

/* ── Contrast: the old way re-parses for each pass ──────────────────── */

console.log("\n— Contrast: old way (re-parse per pass) —");
console.log(
  `  Balanced.parse:          ${[...new Balanced().parse(source)][0]}`,
);

console.log("\n— Done —");
