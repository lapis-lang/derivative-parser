/** Content-based keying for memoisation (used by `@rule` per-argument cache). */

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
