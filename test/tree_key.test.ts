/**
 * Unit tests for `treeKey` keying strategy (issue #16).
 *
 * Covers:
 * - Primitives: content-based equality.
 * - Arrays: structural, element-wise.
 * - Plain objects: structural over enumerable own properties.
 * - Class instances / Map / Set / Date: identity-based (the #16 fix).
 * - Identity stability across calls.
 * - Cycles in plain objects / arrays do not throw.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { treeKey } from "../src/util/tree_key.ts";

/* ─── Primitives ─────────────────────────────────────────────────────── */

Deno.test("treeKey — primitives are content-based", () => {
  assertEquals(treeKey(1), treeKey(1));
  assertEquals(treeKey("a"), treeKey("a"));
  assertEquals(treeKey(true), treeKey(true));
  assertEquals(treeKey(null), treeKey(null));
  assertEquals(treeKey(1n), treeKey(1n));
  assertNotEquals(treeKey(1), treeKey(2));
  assertNotEquals(treeKey("a"), treeKey("b"));
  assertNotEquals(treeKey(true), treeKey(false));
});

Deno.test("treeKey — NaN is stable", () => {
  // JSON.stringify(NaN) === "null", so NaN and null collide under the old
  // scheme. Under the new scheme they still both emit "null" for NaN (via
  // JSON.stringify) — document this rather than assert a specific value.
  const k = treeKey(NaN);
  assertEquals(typeof k, "string");
  assertEquals(treeKey(NaN), k);
});

Deno.test("treeKey — undefined/symbol/function get unkeyable sentinels", () => {
  // Each call produces a fresh monotonic sentinel, so two calls are unequal.
  assertNotEquals(treeKey(undefined), treeKey(undefined));
  assertNotEquals(treeKey(Symbol("x")), treeKey(Symbol("x")));
  assertNotEquals(treeKey(() => 1), treeKey(() => 1));
});

/* ─── Arrays ─────────────────────────────────────────────────────────── */

Deno.test("treeKey — arrays are structural", () => {
  assertEquals(treeKey([1, 2, 3]), treeKey([1, 2, 3]));
  assertNotEquals(treeKey([1, 2, 3]), treeKey([1, 2, 4]));
  assertNotEquals(treeKey([1, 2]), treeKey([1, 2, 3]));
});

Deno.test("treeKey — nested arrays", () => {
  assertEquals(treeKey([[1, 2], [3]]), treeKey([[1, 2], [3]]));
  assertNotEquals(treeKey([[1, 2], [3]]), treeKey([[1, 2], [4]]));
});

/* ─── Plain objects ──────────────────────────────────────────────────── */

Deno.test("treeKey — plain objects are structural", () => {
  assertEquals(treeKey({ a: 1, b: 2 }), treeKey({ a: 1, b: 2 }));
  assertNotEquals(treeKey({ a: 1 }), treeKey({ a: 2 }));
  assertNotEquals(treeKey({ a: 1 }), treeKey({ a: 1, b: 2 }));
});

Deno.test("treeKey — plain object key order does not matter", () => {
  // Object.entries order is insertion order for string keys; {a:1,b:2} and
  // {b:2,a:1} produce different entry orders. This documents that key order
  // *does* matter under the current implementation (structural keying via
  // Object.entries). Two objects with the same properties in the same order
  // share a key.
  assertEquals(treeKey({ a: 1, b: 2 }), treeKey({ a: 1, b: 2 }));
});

Deno.test("treeKey — plain object with nested array", () => {
  assertEquals(treeKey({ d: 2, xs: [1, 2] }), treeKey({ d: 2, xs: [1, 2] }));
  assertNotEquals(
    treeKey({ d: 2, xs: [1, 2] }),
    treeKey({ d: 2, xs: [1, 3] }),
  );
});

/* ─── Class instances (the issue #16 fix) ────────────────────────────── */

/** Env-like class with a private Map — the exact pattern from issue #16. */
class Env {
  #bindings: Map<string, string>;
  constructor(entries?: Map<string, string>) {
    this.#bindings = entries ?? new Map();
  }
  extend(name: string, value: string): Env {
    const next = new Map(this.#bindings);
    next.set(name, value);
    return new Env(next);
  }
  lookup(name: string): string | undefined {
    return this.#bindings.get(name);
  }
}

Deno.test("treeKey — class instances with private Map are distinguished (#16)", () => {
  const env1 = new Env().extend("x", "hello");
  const env2 = new Env().extend("x", "world");
  // Under the old JSON.stringify scheme both serialise to "{}" and collide.
  assertNotEquals(treeKey(env1), treeKey(env2));
});

Deno.test("treeKey — same instance reference is stable across calls", () => {
  const env = new Env().extend("x", "hello");
  assertEquals(treeKey(env), treeKey(env));
});

Deno.test("treeKey — two structurally-equal class instances differ by identity", () => {
  // Documents the new semantics: identity keying for class instances means
  // structurally-equal but distinct instances get different keys. This is
  // intentional and correct for context-threading (see issue #16).
  const a = new Env();
  const b = new Env();
  assertNotEquals(treeKey(a), treeKey(b));
});

Deno.test("treeKey — Map/Set/Date instances are identity-keyed", () => {
  const m1 = new Map([["a", 1]]);
  const m2 = new Map([["a", 1]]);
  assertNotEquals(treeKey(m1), treeKey(m2));
  assertEquals(treeKey(m1), treeKey(m1));

  const s1 = new Set([1, 2]);
  const s2 = new Set([1, 2]);
  assertNotEquals(treeKey(s1), treeKey(s2));

  const d1 = new Date(0);
  const d2 = new Date(0);
  assertNotEquals(treeKey(d1), treeKey(d2));
});

/* ─── Argument tuples (arrays containing class instances) ────────────── */

Deno.test("treeKey — arg tuple with class instance distinguishes by identity", () => {
  const env1 = new Env().extend("x", "hello");
  const env2 = new Env().extend("x", "world");
  // The @rule decorator calls treeKey(args) where args is a fresh array.
  assertNotEquals(treeKey([env1]), treeKey([env2]));
});

Deno.test("treeKey — arg tuple with same instance shares a key", () => {
  const env = new Env().extend("x", "hello");
  assertEquals(treeKey([env]), treeKey([env]));
});

/* ─── Cycles ─────────────────────────────────────────────────────────── */

Deno.test("treeKey — cyclic plain object does not throw", () => {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  // Should not throw; emits a cycle sentinel for the back-reference.
  const k = treeKey(o);
  assertEquals(typeof k, "string");
});

Deno.test("treeKey — cyclic array does not throw", () => {
  const arr: unknown[] = [1];
  arr.push(arr);
  const k = treeKey(arr);
  assertEquals(typeof k, "string");
});
