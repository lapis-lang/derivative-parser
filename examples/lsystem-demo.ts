/**
 * L-System examples — top-down grammar-driven generation as Lindenmayer systems.
 *
 * An L-system is a parallel rewriting system: starting from an axiom, each
 * symbol is simultaneously replaced by its production rule's successor. The
 * generator in LangForma performs the dual operation — top-down expansion
 * of a grammar's `Exp` tree — which maps naturally to L-system generation.
 *
 * This example demonstrates three classic L-systems from the Wikipedia
 * article (https://en.wikipedia.org/wiki/L-system):
 *
 * 1. **Algae** (Lindenmayer's original): A → AB, B → A (Fibonacci words)
 * 2. **Koch curve**: F → F+F−F−F+F (right-angle variant)
 * 3. **Fractal binary tree**: 0 → 1[0]0, 1 → 11
 *
 * **Note on `maxDepth` vs `maxRecursion`:** `maxDepth` limits the total
 * number of `DelayedExp` descents (the derivation depth). `maxRecursion`
 * limits how many times the *same* `DelayedExp` (i.e. the same `@rule`
 * production) can be re-entered on the current path. For L-systems where a
 * single rule is applied recursively, `maxRecursion` must be at least
 * `maxDepth` to allow the full expansion. The default branch strategy is
 * `"depth-first"` (recursive branches first, terminals last), which
 * produces deterministic L-system expansion. Use `branchStrategy: "random"`
 * for diverse property-based testing samples.
 *
 * Run: `deno run examples/lsystem-demo.ts`
 */

import { char, Grammar, or, rule, seq } from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ======================================================================
 *  Example 1: Algae (Lindenmayer's original L-system)
 *
 *  variables : A B
 *  constants : (none)
 *  axiom     : A
 *  rules     : (A → AB), (B → A)
 *
 *  n=0: A
 *  n=1: AB
 *  n=2: ABA
 *  n=3: ABAAB
 *  n=4: ABAABABA
 *
 *  The string lengths follow the Fibonacci sequence: 1, 2, 3, 5, 8, 13, ...
 * ====================================================================== */

class Algae extends Grammar<{ s: string }> {
  override start() {
    return this.s;
  }

  // A → AB (recursive), or terminal 'A' at depth 0
  @rule
  get a(): Parser<string> {
    return or(
      seq(this.a, this.b).map(([a, b]) => a + b),
      char("A").map(() => "A"),
    );
  }

  // B → A (recursive), or terminal 'B' at depth 0
  @rule
  get b(): Parser<string> {
    return or(
      this.a,
      char("B").map(() => "B"),
    );
  }

  @rule
  get s(): Parser<string> {
    return this.a;
  }
}

/* ======================================================================
 *  Example 2: Koch curve (right-angle variant)
 *
 *  variables : F
 *  constants : + −
 *  axiom     : F
 *  rules     : (F → F+F−F−F+F)
 *
 *  F means "draw forward", + means "turn left 90°", − means "turn right 90°".
 * ====================================================================== */

class KochCurve extends Grammar<{ s: string }> {
  override start() {
    return this.s;
  }

  // F → F+F−F−F+F  (recursive), or terminal 'F' at depth 0
  @rule
  get f(): Parser<string> {
    return or(
      seq(
        this.f,
        char("+"),
        this.f,
        char("−"),
        this.f,
        char("−"),
        this.f,
        char("+"),
        this.f,
      )
        .map(([f1, , f2, , f3, , f4, , f5]) => `${f1}+${f2}−${f3}−${f4}+${f5}`),
      char("F").map(() => "F"),
    );
  }

  @rule
  get s(): Parser<string> {
    return this.f;
  }
}

/* ======================================================================
 *  Example 3: Fractal binary tree
 *
 *  variables : 0, 1
 *  constants : [, ]
 *  axiom     : 0
 *  rules     : (1 → 11), (0 → 1[0]0)
 * ====================================================================== */

class FractalTree extends Grammar<{ s: string }> {
  override start() {
    return this.s;
  }

  // 1 → 11 (recursive), or terminal '1' at depth 0
  @rule
  get one(): Parser<string> {
    return or(
      seq(this.one, this.one).map(([a, b]) => a + b),
      char("1").map(() => "1"),
    );
  }

  // 0 → 1[0]0 (recursive), or terminal '0' at depth 0
  @rule
  get zero(): Parser<string> {
    return or(
      seq(this.one, char("["), this.zero, char("]"), this.zero)
        .map(([one, , zero1, , zero2]) => `${one}[${zero1}]${zero2}`),
      char("0").map(() => "0"),
    );
  }

  @rule
  get s(): Parser<string> {
    return this.zero;
  }
}

/* ======================================================================
 *  Run the examples
 * ====================================================================== */

console.log("=== L-System Generation with LangForma ===\n");
console.log("(Using default depth-first branch strategy — deterministic)\n");

// --- Algae ---
console.log("Example 1: Algae (A → AB, B → A)");
console.log("  Expected: Fibonacci word lengths 1, 2, 3, 5, 8, ...");
const algae = new Algae();
for (let depth = 0; depth <= 4; depth++) {
  const { value } = algae.generate({
    maxDepth: depth,
    maxRecursion: depth + 1,
    maxSteps: 10000,
  });
  console.log(`  n=${depth}: ${value} (length ${value.length})`);
}

// --- Koch curve ---
console.log("\nExample 2: Koch curve (F → F+F−F−F+F)");
console.log("  Expected: F, F+F−F−F+F, ...");
const koch = new KochCurve();
for (let depth = 0; depth <= 2; depth++) {
  const { value } = koch.generate({
    maxDepth: depth,
    maxRecursion: depth + 1,
    maxSteps: 10000,
  });
  console.log(`  n=${depth}: ${value}`);
}

// --- Fractal tree ---
console.log("\nExample 3: Fractal binary tree (0 → 1[0]0, 1 → 11)");
console.log("  Expected: 0, 1[0]0, 11[1[0]0]1[0]0, ...");
const tree = new FractalTree();
for (let depth = 0; depth <= 2; depth++) {
  const { value } = tree.generate({
    maxDepth: depth,
    maxRecursion: depth + 1,
    maxSteps: 10000,
  });
  console.log(`  n=${depth}: ${value}`);
}

console.log(
  "\nThese examples show LangForma's generator performing L-system style",
);
console.log(
  "top-down expansion — the dual of parsing. The default depth-first branch",
);
console.log(
  "strategy tries recursive productions first, producing deterministic",
);
console.log(
  "L-system output. Use `branchStrategy: 'random'` for property-based",
);
console.log("testing with diverse random samples.");
