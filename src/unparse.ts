/**
 * Inverse parsing (unparsing) — convert a {@link DerivationTree} back into
 * formatted source text.
 *
 * The default {@link UnparsePass} walks a `DerivationTree` bottom-up,
 * reconstructing source text from the tree's spans. For grammars that want
 * pretty-printing, authors subclass `SemanticPass<string>` and override
 * methods named after production labels — the same OOP-native pattern the
 * library already uses for semantic passes. No new decorator is needed.
 *
 * @module
 */

import type { DerivationNode, DerivationTree } from "./derivation.ts";
import { SemanticPass } from "./derivation.ts";

/* ======================================================================
 *  Default unparse pass
 * ====================================================================== */

/**
 * The default unparse pass — reconstructs source text from a
 * {@link DerivationTree} by extracting the source substring spanned by each
 * leaf node and concatenating. For a parsed tree this round-trips the
 * original source exactly; for a generated tree it reconstructs the
 * generated token string.
 *
 * Grammar authors who want pretty-printing subclass `SemanticPass<string>`
 * and override methods named after production labels (e.g. `lam(node,
 * children) => ...`). This class serves as the zero-config default.
 */
export class UnparsePass extends SemanticPass<Record<string, string>> {
  /** The source string of the tree being unparsed. */
  private _source: string = "";

  /**
   * Unparse a {@link DerivationTree} to a source string. This is the main
   * entry point — it stores the tree's source for span extraction, then
   * delegates to the standard {@link SemanticPass.evaluate} bottom-up walk.
   */
  unparse(tree: DerivationTree): string {
    this._source = tree.source;
    return this.evaluate(tree);
  }

  /**
   * Default handler: extract the source substring spanned by this node.
   * For a leaf node (no children), this is `source.slice(start, end)`.
   * For an inner node, the full span `[start, end)` covers all tokens
   * including those consumed by combinators (not just `@rule` children),
   * so we extract the full substring. This ensures operators, whitespace,
   * and other combinator-consumed tokens are preserved in the output.
   */
  protected override defaultHandler(
    node: DerivationNode,
    _childResults: readonly string[],
  ): string {
    return this._source.slice(node.span.start, node.span.end);
  }
}

/* ======================================================================
 *  Grammar.unparse convenience
 * ====================================================================== */

/**
 * Unparse a {@link DerivationTree} to a source string using the default
 * {@link UnparsePass}. For pretty-printing, grammar authors create their
 * own `SemanticPass<string>` subclass and call `pass.unparse(tree)`.
 *
 * This is a standalone function (not a `Grammar` method) so it can be used
 * with any `DerivationTree` regardless of which grammar produced it.
 */
export function unparse(tree: DerivationTree): string {
  return new UnparsePass().unparse(tree);
}
