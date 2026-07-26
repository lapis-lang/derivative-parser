/** Indentation-sensitive grammar with parameterised `block(depth)` productions. See the README for usage. */

import {
  char,
  epsilon,
  Grammar,
  literal,
  or,
  pred,
  rule,
  seq,
} from "../src/index.ts";
import type { Parser, Span } from "../src/index.ts";

/* ─── AST ─────────────────────────────────────────────────────────── */

export interface Leaf {
  kind: "leaf";
  key: string;
  value: string;
  span: Span;
}

export interface Branch {
  kind: "branch";
  key: string;
  children: Node[];
  span: Span;
}

export type Node = Leaf | Branch;

/* ─── Grammar ─────────────────────────────────────────────────────── */

interface IndentShape {
  [k: string]: unknown;
  doc: Node[];
}

class IndentGrammar extends Grammar<IndentShape> {
  override start(): Parser<Node[]> {
    return this.doc;
  }

  @rule
  get doc(): Parser<Node[]> {
    // One or more top-level lines at depth 0
    return this.block(0);
  }

  /** A block at indent depth `depth`: one or more lines at that depth. */
  @rule
  block(depth: number): Parser<Node[]> {
    return seq(this.line(depth), this.block(depth).opt())
      .map(([first, rest]) => [first, ...(rest ?? [])]);
  }

  /**
   * A single line at indent depth `depth`.
   * Two variants:
   *   1. Leaf:   <spaces> <key> ": " <value> "\n"
   *   2. Branch: <spaces> <key> ":\n" <block(depth+2)>
   */
  @rule
  line(depth: number): Parser<Node> {
    const leaf: Parser<Node> = seq(
      this.spaces(depth),
      this.key,
      literal(": "),
      this.value,
      char("\n"),
    ).map(([, k, , v], span): Node => ({
      kind: "leaf",
      key: k,
      value: v,
      span,
    }));

    const branch: Parser<Node> = seq(
      this.spaces(depth),
      this.key,
      literal(":\n"),
      this.block(depth + 2),
    ).map(([, k, , children], span): Node => ({
      kind: "branch",
      key: k,
      children,
      span,
    }));

    return or(branch, leaf);
  }

  /**
   * Match exactly `n` space characters, returning `""`.
   * Parameterised via recursion; cached per depth by `@rule`.
   */
  @rule
  spaces(n: number): Parser<string> {
    if (n === 0) return epsilon("");
    return seq(char(" "), this.spaces(n - 1)).map(() => "");
  }

  /** One or more word characters: [a-zA-Z0-9 ]+ (no colon, no newline). */
  @rule
  get key(): Parser<string> {
    const wordChar = pred(
      (c) => /[a-zA-Z0-9 ]/.test(c) && c !== "\n",
      "<keychar>",
    );
    return seq(wordChar, wordChar.many())
      .map(([h, t]) => h + (t as string[]).join(""));
  }

  /** Value: any characters up to (but not including) newline. */
  @rule
  get value(): Parser<string> {
    const nonNl = pred((c) => c !== "\n", "<valuechar>");
    return seq(nonNl, nonNl.many())
      .map(([h, t]) => h + (t as string[]).join(""));
  }
}

/* ─── Demo ────────────────────────────────────────────────────────── */

const input = [
  "name: Alice\n",
  "address:\n",
  "  street: 1 Main St\n",
  "  city: Wonderland\n",
  "age: 30\n",
].join("");

const grammar = new IndentGrammar();
const resultSet = grammar.parse(input);
const results = [...resultSet] as Node[][];

if (results.length === 0) {
  console.error("No parse!");
  Deno.exit(1);
}

function printNode(node: Node, indent = 0): void {
  const pad = "  ".repeat(indent);
  if (node.kind === "leaf") {
    console.log(
      `${pad}[${node.span.start}-${node.span.end}) ${node.key}: ${node.value}`,
    );
  } else {
    console.log(`${pad}[${node.span.start}-${node.span.end}) ${node.key}:`);
    for (const child of node.children) printNode(child, indent + 1);
  }
}

console.log("Parsed document:");
for (const node of results[0]!) printNode(node);
