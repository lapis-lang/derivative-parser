/**
 * Retained derivation tree — the tree-*producing* half of the
 * structural/semantic separation, and the {@link SemanticPass}
 * base class — the tree-*consuming* half.
 *
 * A {@link DerivationTree} materialises *which `Exp` (production) matched
 * where, with child relationships and source spans* as a first-class tree.
 * It is produced opt-in via {@link Grammar.parseToTree}; the inline
 * single-pass L-attributed model remains the default (zero overhead).
 *
 * A {@link SemanticPass} walks a `DerivationTree` bottom-up, dispatching
 * each node to an overridable method named after the production label.
 * This is the OOP-native way to run a semantic pass: subclass and override,
 * mirroring the grammar's shape — with contracts, shape-typing, and
 * inheritance composition.
 */

import type { Span } from "./zipper.ts";
import { wrapWithContracts } from "./contracts.ts";
import type { GrammarShape } from "./Grammar.ts";

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
 *
 * @internal Exported only because `ZipperDriver.parseWithDerivation`
 * returns it; not part of the public API.
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

/* ── SemanticPass — OOP-native tree consumer ────────────────────────── */

/**
 * Abstract base class for semantic passes over {@link DerivationTree}s.
 *
 * A semantic pass mirrors the grammar's production names as overridable
 * methods. {@link evaluate} walks the tree bottom-up, dispatching each
 * {@link DerivationNode} to the method named after the node's `label`
 * (the `@rule` production name). The method receives the node and the
 * already-computed results of its children (in source order).
 *
 * This is the OOP-native equivalent of a fold (catamorphism): instead of a
 * handler map, you subclass and override — the same subclass-and-override
 * pattern used by Bracha's executable grammars and the library's own
 * `Grammar` base. This enables:
 *
 * - **Code Contracts**: `@ensures` / `@requires` / `@invariant` / `@rescue`
 *   on semantic methods (via the same `wrapWithContracts` Proxy as `Grammar`).
 * - **Shape-typing**: `SemanticPass<{ s: number }>` ties the pass to the
 *   grammar's shape, just like `Grammar<S>`.
 * - **Inheritance composition**: a subclass can override one method and
 *   inherit defaults from a base pass — the Decorator pattern.
 * - **Stateful passes**: `this` gives natural access to shared state
 *   (symbol tables, environments) across productions — the L-attributed /
 *   inherited-attribute case.
 *
 * @example
 * ```ts
 * class DepthPass extends SemanticPass<{ s: number }> {
 *   s(node: DerivationNode, children: number[]): number {
 *     return children.length ? 1 + Math.max(...children) : 0;
 *   }
 * }
 * const depth = new DepthPass().evaluate(tree);
 * ```
 *
 * @typeParam S  The shape interface mapping production names to result types.
 *               Mirrors the `Grammar<S>` shape parameter.
 */
export abstract class SemanticPass<S extends GrammarShape = GrammarShape> {
  /**
   * When contract checking is enabled, returns a `Proxy` enforcing
   * `@requires`/`@ensures`/`@invariant` on semantic methods. When disabled,
   * no Proxy is created (zero overhead). Same mechanism as `Grammar`.
   */
  constructor() {
    return wrapWithContracts(this) as unknown as SemanticPass<S>;
  }

  /**
   * Walk a {@link DerivationTree} bottom-up, dispatching each node to the
   * method named after its `label`. Returns the result of the root node's
   * method.
   *
   * If a production label has no corresponding method, a default handler is
   * used: if the node has exactly one child, the child's result is returned
   * (passthrough); otherwise an error is thrown. Override {@link defaultHandler}
   * to customise this behaviour.
   *
   * @param tree  The derivation tree to evaluate.
   * @returns     The result of evaluating the root node's semantic method.
   */
  evaluate(tree: DerivationTree): S[keyof S] {
    return this._visit(tree.root) as S[keyof S];
  }

  /**
   * Default handler for production labels that have no corresponding method.
   * The default behaviour is passthrough: if the node has exactly one child,
   * return the child's result; otherwise throw. Override to customise.
   *
   * @param node  The unmatched {@link DerivationNode}.
   * @param childResults  Already-computed results of the node's children.
   * @returns     The result for this node.
   */
  protected defaultHandler(
    _node: DerivationNode,
    childResults: readonly unknown[],
  ): unknown {
    if (childResults.length === 1) return childResults[0];
    throw new Error(
      `SemanticPass: no method for label "${_node.label}" (arity ${childResults.length}) and no default handler override. ` +
        `Override a method named "${_node.label}" or override defaultHandler().`,
    );
  }

  /**
   * Internal recursive visitor. Visits children first (bottom-up), then
   * dispatches the node to its method or the default handler.
   */
  private _visit(node: DerivationNode): unknown {
    const childResults = node.children.map((c) => this._visit(c));
    const fn = (this as Record<string, unknown>)[node.label];
    if (typeof fn === "function") {
      return (fn as (...args: unknown[]) => unknown).call(
        this,
        node,
        childResults,
      );
    }
    return this.defaultHandler(node, childResults);
  }
}
