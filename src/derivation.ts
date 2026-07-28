/**
 * Retained derivation tree — the tree-*producing* half of the
 * structural/semantic separation (issue #23).
 *
 * A {@link DerivationTree} materialises *which `Exp` (production) matched
 * where, with child relationships and source spans* as a first-class tree.
 * It is produced opt-in via {@link Grammar.parseToTree}; the inline
 * single-pass L-attributed model remains the default (zero overhead).
 *
 * The tree is shaped to feed the existing tree-consuming half
 * ({@link TreeExp} / {@link flattenTree} / `Grammar.parseTree`) via
 * {@link derivationToTreeToks}, so decorators are grammars
 * (grammar-over-grammar composition).
 */

import type { Exp, Span, TreeTok, ZipperDriver } from "./zipper.ts";
import { type Mem, TreeExp } from "./zipper.ts";
import { type Parser, parserOf } from "./Parser.ts";

/**
 * A single node in a retained derivation tree.
 *
 * `label` is the `@rule` production name (from `ctx.name` in the `@rule`
 * decorator). Only `@rule` productions produce labeled nodes; combinators
 * (`AltExp`/`SeqExp`/etc.) contribute children/spans only.
 *
 * `span` is the absolute source span `[start, end)` covered by this node.
 *
 * `children` are the sub-derivations nested within this node's span, in
 * source order.
 *
 * `value` is the optional inline semantic value if the producing grammar
 * also computed one (via `.map()`/`.chain()` actions).
 */
export class DerivationNode {
  /** The sub-derivations nested within this node's span, in source order. */
  readonly children: readonly DerivationNode[];
  /** Completion order (0-based, assigned by the engine). Parents have higher `seq` than children. */
  readonly seq: number;
  constructor(
    readonly label: string,
    readonly span: Span,
    children: readonly DerivationNode[] = [],
    readonly value?: unknown,
    seq = 0,
  ) {
    this.children = children;
    this.seq = seq;
  }
}

/**
 * A retained derivation tree: the root node plus the source string it was
 * parsed from (for error reporting and re-parsing if needed).
 */
export class DerivationTree {
  constructor(
    readonly root: DerivationNode,
    readonly source: string,
  ) {}
}

/**
 * A flat capture record collected during a parse when the derivation sink is
 * enabled. Each record corresponds to one `@rule` production completion.
 * Records are post-processed into a {@link DerivationTree} by span nesting.
 *
 * The `seq` field is the completion order (0-based), assigned as records
 * are captured. Since the engine completes children before parents
 * (bottom-up), a parent's `seq` is always greater than its children's.
 */
export interface DerivationRecord {
  readonly label: string;
  readonly span: Span;
  readonly value?: unknown;
  readonly seq: number;
}

/**
 * Build a {@link DerivationTree} from flat {@link DerivationRecord}s.
 *
 * Uses a stack-based algorithm that leverages completion order: the engine
 * completes children before parents (bottom-up), so a parent's `seq` is
 * always greater than its children's. A new record is a child of the
 * innermost open record whose span contains it. Records with the same span
 * (passthrough productions like `expr → term → factor`) are nested by
 * completion order: the earlier-completed one is the child of the
 * later-completed one.
 *
 * For ambiguous grammars (multiple records with the same span and the same
 * completion order), each top-level record produces a separate root.
 */
export function buildDerivationTrees(
  records: readonly DerivationRecord[],
  source: string,
): DerivationTree[] {
  if (records.length === 0) return [];

  // Filter out zero-length spans (epsilon productions completing at the
  // same position they started). These don't contribute meaningful
  // structure to the derivation tree.
  const meaningful = records.filter((r) => r.span.end > r.span.start);
  if (meaningful.length === 0) return [];

  // Sort by seq (completion order). The engine completes children before
  // parents, so processing in seq order means children are processed first.
  const sorted = [...meaningful].sort((a, b) => a.seq - b.seq);

  // Build trees using a stack. Each stack entry holds the already-constructed
  // `DerivationNode` (with its children attached). A new record pops entries
  // whose span is contained in this record's span (or same span with lower
  // seq — the earlier-completed one is the child), collects them as children,
  // then pushes itself. Remaining stack entries at the end are roots.
  const roots: DerivationNode[] = [];
  const stack: DerivationNode[] = [];

  for (const record of sorted) {
    // Pop stack entries that are children of this record:
    // - A stack entry is a child if its span is contained in this record's span.
    // - If the spans are equal, the earlier-completed (deeper in stack)
    //   record is the child (it completed first = it's the inner production).
    const children: DerivationNode[] = [];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const topSpan = top.span;
      const mySpan = record.span;
      // Is top contained in this record (or same span with lower seq)?
      if (
        (topSpan.start >= mySpan.start && topSpan.end <= mySpan.end) &&
        (topSpan.start > mySpan.start || topSpan.end < mySpan.end ||
          top.seq < record.seq)
      ) {
        children.push(stack.pop()!);
        continue;
      }
      break;
    }

    // Reverse children to restore source order (stack pops in reverse).
    children.reverse();
    const node = new DerivationNode(
      record.label,
      record.span,
      children,
      record.value,
      record.seq,
    );

    // This node stays on the stack — it may be popped by a later parent
    // or become a root at the end.
    stack.push(node);
  }

  // All remaining stack entries are roots. Use pop() (O(1)) instead of
  // shift() (O(n)) to avoid O(n²) on large trees. Order doesn't matter —
  // they are independent derivation trees (ambiguity).
  while (stack.length > 0) {
    roots.push(stack.pop()!);
  }

  return roots.map((root) => new DerivationTree(root, source));
}

/* ── Adapter: derivation tree → tree-token stream ────────────────────── */

/**
 * Flatten a {@link DerivationTree} into a stream of {@link TreeTok}s in
 * preorder, so it can be consumed by the existing tree-consuming half
 * (`Grammar.parseTree` + `TreeExp`-based decorator grammars).
 *
 * Each `DerivationNode` becomes a `TreeTok` with:
 * - `tag` = the node's `label` (the `@rule` production name)
 * - `node` = the `DerivationNode` itself (available to `TreeExp` `fn` callbacks)
 * - `arity` = the number of children
 * - `subtreeSize` = 1 + all descendants
 * - `offset` = 0-based preorder position
 *
 * This mirrors {@link flattenTree} but operates on `DerivationNode`s
 * instead of arbitrary tree objects, using `label` as the tag (rather than
 * `constructor.name`).
 */
export function derivationToTreeToks(tree: DerivationTree): TreeTok[] {
  const out: TreeTok[] = [];
  let offset = 0;
  const visit = (node: DerivationNode): number => {
    const myOffset = offset++;
    let size = 1;
    for (const child of node.children) size += visit(child);
    out.push({
      tag: node.label,
      node,
      arity: node.children.length,
      subtreeSize: size,
      offset: myOffset,
    });
    return size;
  };
  visit(tree.root);
  // Tokens are pushed post-recurse (after children), so the array is in
  // postorder despite offsets being assigned preorder. Re-sort by offset
  // to restore preorder for positional matching by TreeExp.
  out.sort((a, b) => a.offset - b.offset);
  return out;
}

/* ── Exact-arity TreeExp for decorator grammars ──────────────────────── */

/**
 * A `TreeExp` variant that requires the tree token's arity to *exactly*
 * match `expectedArity` (not just be >= children.length as `TreeExp`
 * normally allows). Useful for decorator grammars over derivation trees
 * where a production with arity N must only match tree tokens with exactly
 * N children — e.g. `s` with arity 0 only matches leaf nodes, not any
 * `s` node.
 */
export class ExactArityTreeExp extends TreeExp {
  constructor(
    tag: string,
    private readonly expectedArity: number,
    children: readonly Exp[],
    fn: (node: unknown, childVals: unknown[]) => unknown,
  ) {
    super(tag, children, fn);
  }
  /** Match the current tree token by class name and exact arity, then dispatch to child sub-parsers. */
  override descend(driver: ZipperDriver, m: Mem): void {
    const tok = driver.currentTreeToken;
    if (tok === undefined || tok.tag !== this.tag) return;
    // Exact arity check: only match if the token has exactly expectedArity
    // children (not "at least" as TreeExp normally allows).
    if (tok.arity !== this.expectedArity) {
      return;
    }
    // Delegate to the normal TreeExp descent for child matching.
    super.descend(driver, m);
  }
}

/* ── Convenience helpers ────────────────────────────────────────────── */

/**
 * Build a `TreeExp`-based parser from `Parser<T>` children (not raw `Exp`),
 * eliminating the `parserOf(new TreeExp(..., [this.s._exp, ...]))` boilerplate.
 *
 * Each child slot accepts a `Parser<T>` instead of a raw `Exp`, so you write
 * `treeExp("Add", [this.expr, this.expr], fn)` instead of
 * `parserOf(new TreeExp("Add", [this.expr._exp, this.expr._exp], fn))`.
 *
 * @param tag  The tree-node label to match.
 * @param children  Child sub-parsers (as `Parser<T>`, not raw `Exp`).
 * @param fn  Semantic function combining the matched node and child values.
 */
export function treeExp<T>(
  tag: string,
  children: readonly Parser<unknown>[],
  fn: (node: unknown, childVals: unknown[]) => T = (_n, vs) =>
    vs as unknown as T,
): Parser<T> {
  return parserOf(
    new TreeExp(
      tag,
      children.map((c) => c._exp),
      fn as (node: unknown, childVals: unknown[]) => unknown,
    ),
  );
}

/**
 * Build an `ExactArityTreeExp`-based parser from `Parser<T>` children,
 * combining the exact-arity check of `ExactArityTreeExp` with the
 * `Parser`-accepting convenience of {@link treeExp}.
 *
 * @param tag  The tree-node label to match.
 * @param expectedArity  The exact number of children the node must have.
 * @param children  Child sub-parsers (as `Parser<T>`, not raw `Exp`).
 * @param fn  Semantic function combining the matched node and child values.
 */
export function exactTreeExp<T>(
  tag: string,
  expectedArity: number,
  children: readonly Parser<unknown>[],
  fn: (node: unknown, childVals: unknown[]) => T = (_n, vs) =>
    vs as unknown as T,
): Parser<T> {
  return parserOf(
    new ExactArityTreeExp(
      tag,
      expectedArity,
      children.map((c) => c._exp),
      fn as (node: unknown, childVals: unknown[]) => unknown,
    ),
  );
}

/**
 * A handler map for {@link foldTree}: maps each production label to a
 * function that receives the matched {@link DerivationNode} and the
 * already-folded child results, and returns the fold result for that node.
 *
 * A wildcard handler (`_`) catches any label without an explicit handler.
 */
export type FoldHandlers<T> = {
  [label: string]: (node: DerivationNode, childResults: readonly T[]) => T;
} & {
  readonly _?: (node: DerivationNode, childResults: readonly T[]) => T;
};

/**
 * Fold a {@link DerivationTree} bottom-up, applying a handler function per
 * production label. This is the simplest way to run a semantic pass over a
 * retained derivation tree — no grammar subclass, no `TreeExp`, no engine.
 *
 * Each handler receives the `DerivationNode` and the already-folded results
 * of its children (in source order). A wildcard handler (`_`) catches any
 * label without an explicit handler; if no wildcard is provided and a label
 * is missing, an error is thrown.
 *
 * @example
 * ```ts
 * const depth = foldTree(tree, {
 *   s: (node, childResults) =>
 *     childResults.length === 0 ? 0 : 1 + Math.max(...childResults),
 * });
 * ```
 */
export function foldTree<T>(
  tree: DerivationTree,
  handlers: FoldHandlers<T>,
): T {
  const visit = (node: DerivationNode): T => {
    const childResults = node.children.map(visit);
    const handler = handlers[node.label] ?? handlers._;
    if (!handler) {
      throw new Error(
        `foldTree: no handler for label "${node.label}" and no wildcard "_" provided. ` +
          `Available handlers: ${
            [...Object.keys(handlers)].filter((k) => k !== "_").join(", ")
          }`,
      );
    }
    return handler(node, childResults);
  };
  return visit(tree.root);
}
