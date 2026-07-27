/**
 * End-to-end regression test for issue #16: `@rule` parameterised methods
 * cache per `(instance, method, treeKey(args))`. When an argument is an
 * object with non-enumerable state (e.g. a private `Map`), the old
 * `JSON.stringify`-based `treeKey` serialised distinct instances
 * identically, so the cache returned stale results for different argument
 * values.
 *
 * This test mirrors the reproduction in issue #16: a grammar with a
 * parameterised `@rule` method taking an `Env`-like object with a private
 * `Map`. Two parses with different envs must yield different results.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { epsilon, Grammar, literal, rule, seq } from "../src/index.ts";
import type { Parser } from "../src/index.ts";

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

/** Grammar whose production depends on the env's (hidden) Map contents.
 *
 * Matches the literal input string and yields the env's looked-up value
 * for `"x"`, so the parse completes at the final position. */
class EnvGrammar extends Grammar<{ r: string }> {
  override start(): Parser<string> {
    return this.prod(new Env());
  }

  /** Public wrapper around the protected driver for testing. */
  parseWith(input: string, start: Parser<string>): Set<string> {
    return this._parseWith(input, start);
  }

  @rule
  prod(env: unknown): Parser<string> {
    const e = env as Env;
    const val = e.lookup("x");
    if (val === undefined) {
      // No binding for "x": match the empty string and yield "".
      return seq(literal("")).map(() => "");
    }
    // Match the input literal and yield the env's value (consuming input
    // so the parse completes at the final position).
    return seq(literal(val)).map(() => val);
  }
}

Deno.test("@rule cache — distinct envs with private Map do not collide (#16)", () => {
  const g = new EnvGrammar();

  const env1 = new Env().extend("x", "hello");
  const env2 = new Env().extend("x", "world");

  // Each prod(env) matches the literal of its own value, so the input must
  // equal the value for the parse to succeed. The key assertion is that the
  // second parse is not served a stale cache entry from the first.
  const r1 = [...g.parseWith("hello", g.prod(env1))];
  const r2 = [...g.parseWith("world", g.prod(env2))];

  // Both should produce their own value, not a stale cached copy.
  assertEquals(r1, ["hello"]);
  assertEquals(r2, ["world"]);
  assertNotEquals(r1, r2);
});

Deno.test("@rule cache — same env reference reuses cache entry", () => {
  const g = new EnvGrammar();
  const env = new Env().extend("x", "hello");

  const r1 = [...g.parseWith("hello", g.prod(env))];
  const r2 = [...g.parseWith("hello", g.prod(env))];

  assertEquals(r1, ["hello"]);
  assertEquals(r2, ["hello"]);
});

Deno.test("@rule cache — primitive args still share cache (structural)", () => {
  // Guards against over-fixing: primitive / plain-data arguments must still
  // be structurally keyed so that `this.block(2)` and a second
  // `this.block(2)` share a cache entry.
  let buildCount = 0;
  class NumGrammar extends Grammar<{ r: string }> {
    override start(): Parser<string> {
      return this.prod(2);
    }
    parseWith(input: string, start: Parser<string>): Set<string> {
      return this._parseWith(input, start);
    }
    @rule
    prod(depth: number): Parser<string> {
      buildCount++;
      return epsilon(`d${depth}`);
    }
  }
  const g = new NumGrammar();
  const r1 = [...g.parseWith("", g.prod(2))];
  const r2 = [...g.parseWith("", g.prod(2))];
  assertEquals(r1, ["d2"]);
  assertEquals(r2, ["d2"]);
  // The body should have been built once for the structurally-equal arg.
  assertEquals(buildCount, 1);
});

Deno.test("@rule cache — plain-object args still share cache (structural)", () => {
  let buildCount = 0;
  class ObjGrammar extends Grammar<{ r: string }> {
    override start(): Parser<string> {
      return this.prod({ depth: 2 });
    }
    parseWith(input: string, start: Parser<string>): Set<string> {
      return this._parseWith(input, start);
    }
    @rule
    prod(ctx: { depth: number }): Parser<string> {
      buildCount++;
      return epsilon(`d${ctx.depth}`);
    }
  }
  const g = new ObjGrammar();
  const r1 = [...g.parseWith("", g.prod({ depth: 2 }))];
  const r2 = [...g.parseWith("", g.prod({ depth: 2 }))];
  assertEquals(r1, ["d2"]);
  assertEquals(r2, ["d2"]);
  assertEquals(buildCount, 1);
  // Different content → different cache entry.
  const r3 = [...g.parseWith("", g.prod({ depth: 3 }))];
  assertEquals(r3, ["d3"]);
  assert(buildCount >= 2);
});
