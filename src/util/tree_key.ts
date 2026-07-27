/**
 * Keying for `@rule` per-argument memoisation.
 *
 * Primitives, arrays, and plain objects are keyed structurally (by content).
 * Class instances and other non-plain objects are keyed **by identity** via
 * a `WeakMap` — `JSON.stringify` silently drops `Map`/`Set`/private fields,
 * so content keying would collide distinct instances with different hidden
 * state (issue #16). `undefined`/`symbol`/`function` fall back to a
 * monotonic `<unkeyable@n>` sentinel. Keys are process-local, never persisted.
 */

let _unkeyableCounter = 0;

/** Per-instance unique id for class-instance objects (identity keying). */
const _objectIdMap = new WeakMap<object, number>();
let _objectIdCounter = 0;

/**
 * Build a stable key for a parse-tree value (or `@rule` argument tuple).
 *
 * See the module doc comment for the keying strategy. Exported for internal
 * use by the `@rule` decorator; not part of the public API.
 */
export function treeKey(v: unknown): string {
  return _key(v, new Set<object>());
}

/** Add a parse-tree value to a content-keyed map under its content key. */
export function addTree<T>(out: Map<string, T>, v: T): void {
  out.set(treeKey(v), v);
}

/**
 * Recursive key builder. `seen` guards against cycles in plain objects /
 * arrays (which can reference each other); class instances are keyed by
 * identity and never recursed into, so they cannot cycle.
 */
function _key(v: unknown, seen: Set<object>): string {
  // Primitives: content-based.
  if (v === null) return "null";
  if (v === undefined) return `<unkeyable@${++_unkeyableCounter}>`;
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "number") return JSON.stringify(v);
  if (t === "boolean") return JSON.stringify(v);
  if (t === "bigint") return `${v}n`;
  if (t === "symbol" || t === "function") {
    return `<unkeyable@${++_unkeyableCounter}>`;
  }

  // From here, `v` is an object.
  const obj = v as object;

  // Arrays: structural, element-wise.
  if (Array.isArray(obj)) {
    if (seen.has(obj)) return "[…]";
    seen.add(obj);
    const parts = (obj as unknown[]).map((e) => _key(e, seen));
    return `[${parts.join(",")}]`;
  }

  // Plain objects (direct prototype is Object.prototype): structural over
  // enumerable own properties.
  if (Object.getPrototypeOf(obj) === Object.prototype) {
    if (seen.has(obj)) return "{…}";
    seen.add(obj);
    const entries = Object.entries(obj).map(
      ([k, val]) => `${JSON.stringify(k)}:${_key(val, seen)}`,
    );
    return `{${entries.join(",")}}`;
  }

  // All other objects (class instances, Map, Set, Date, ...): identity-based.
  let id = _objectIdMap.get(obj);
  if (id === undefined) {
    id = ++_objectIdCounter;
    _objectIdMap.set(obj, id);
  }
  return `<obj@${id}>`;
}
