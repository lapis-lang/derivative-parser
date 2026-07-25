/**
 * Content-based keying for parse-tree values.
 *
 * Used by `@rule` method-form memoisation (to cache per-argument-tuple
 * slots) and — in the legacy derivative engine — by the least-fixed-point
 * solver to detect convergence on object/array trees.
 *
 * Falls back to a "<unkeyable@N>" key for non-JSON-serialisable values,
 * which means memoisation may not converge for grammars producing such
 * trees; documented limitation, easy to override per-grammar in a later
 * iteration.
 */

let _unkeyableCounter = 0;

/** Build a stable content-based key for a parse-tree value. */
export function treeKey(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (s !== undefined) return s;
  } catch {
    /* fall through */
  }
  return `<unkeyable@${++_unkeyableCounter}>`;
}

/** Add a parse-tree value to a content-keyed map under its content key. */
export function addTree<T>(out: Map<string, T>, v: T): void {
  out.set(treeKey(v), v);
}
