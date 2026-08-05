/**
 * Native property-based testing — no external dependency.
 *
 * Provides `forAll` (a property runner) and `toGenerator` (a grammar-aware
 * `Generator` adapter with shrinking). Shrinking is **grammar-aware**: a
 * failing counterexample is minimized by re-generating the same production
 * at a shallower depth, or by pruning subtrees — producing *structurally
 * smaller* counterexamples that stay well-formed. This is superior to
 * generic value-level shrinking (e.g. `fast-check`) for grammar-generated
 * terms, where generic shrinkers would produce ill-formed garbage.
 *
 * See the README for the full discussion.
 *
 * @module
 */

import type { Grammar, GrammarShape } from "./Grammar.ts";
import {
  defaultGeneratorOptions,
  Generator,
  type GeneratorOptions,
  RNG,
} from "./generate.ts";

/* ======================================================================
 *  Generator adapter (with shrinking)
 * ====================================================================== */

/**
 * A generator that can `sample` a value, `shrink` it into simpler values,
 * and run `forAll` property checks. The native property-testing primitive
 * — equivalent to `fast-check`'s `Arbitrary<T>` but with grammar-aware
 * shrinking.
 */
export interface ValueGenerator<T> {
  /** Generate one sample value from a seed. */
  sample(seed: number): T;
  /**
   * Shrink `value` into a list of simpler values. Each element is a
   * *concrete* simpler value (not a generator) — the runner re-derives
   * generators for further shrinking.
   */
  shrink(value: T): T[];
  /**
   * Run a property-based test: generate random values, check `property`
   * on each, and shrink any counterexample to a minimal form.
   *
   * Throws {@link PropertyFailure} with the minimized counterexample if the
   * property fails. Returns a {@link ForAllResult} otherwise.
   */
  forAll(
    property: (value: T) => boolean | void,
    options?: ForAllOptions,
  ): ForAllResult<T>;
}

/**
 * A grammar-aware generator adapter. Wraps a {@link Generator} and adds
 * shrinking by re-generating at shallower depths.
 */
export class GrammarGenerator<T, S extends GrammarShape = GrammarShape>
  implements ValueGenerator<T> {
  /** The grammar's start production accessor. */
  private readonly startRule: () => ReturnType<Grammar<S>["start"]>;
  /** Resolved generation options (all fields filled from defaults). */
  private readonly baseOpts: Required<GeneratorOptions>;

  constructor(
    _grammar: Grammar<S>,
    start: () => ReturnType<Grammar<S>["start"]>,
    options: GeneratorOptions = {},
  ) {
    this.startRule = start as () => ReturnType<Grammar<S>["start"]>;
    // PBT wants diverse random samples — override the default depth-first
    // strategy with random, unless the caller explicitly sets one.
    this.baseOpts = {
      ...defaultGeneratorOptions(),
      branchStrategy: "random",
      ...options,
    };
  }

  /** Generate one sample value from a seed. */
  sample(seed: number): T {
    const result = new Generator({ ...this.baseOpts, seed }).generate(
      this.startRule() as unknown as ReturnType<Grammar<S>["start"]>,
    );
    return result.value as T;
  }

  /**
   * Shrink `value` by re-generating at shallower depths with different seeds.
   * Each shrunk value is structurally smaller (shallower derivation) but
   * still well-formed (it was produced by the grammar).
   *
   * The strategy: try depths from 0 up to `currentDepth - 1`, with
   * `shrinkAttempts` seeds per depth. Candidates are generated incrementally
   * and deduplicated by structural key; the search stops early once
   * `maxShrinkCandidates` unique candidates are found, avoiding unnecessary
   * generation on large grammars.
   */
  shrink(value: T): T[] {
    const tryGen = (depth: number, seed: number): T | undefined => {
      try {
        const result = new Generator(
          { ...this.baseOpts, maxDepth: depth, seed },
        ).generate(
          this.startRule() as unknown as ReturnType<Grammar<S>["start"]>,
        );
        return result.value !== value ? result.value as T : undefined;
      } catch {
        return undefined; // Generation may fail at very shallow depths.
      }
    };
    const seen = new Set<string>();
    const out: T[] = [];
    const max = this.baseOpts.maxShrinkCandidates;
    const attempts = this.baseOpts.shrinkAttempts;
    for (
      let depth = 0;
      depth < this.baseOpts.maxDepth && out.length < max;
      depth++
    ) {
      for (let seed = 0; seed < attempts && out.length < max; seed++) {
        const v = tryGen(depth, seed * 7919 + depth * 31);
        if (v === undefined) continue;
        const key = stableKey(v);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
      }
    }
    return out;
  }

  /**
   * Run a property-based test: generate random values, check `property`
   * on each, and shrink any counterexample to a minimal form.
   *
   * Throws {@link PropertyFailure} with the minimized counterexample if the
   * property fails. Returns a {@link ForAllResult} otherwise.
   */
  forAll(
    property: (value: T) => boolean | void,
    options: ForAllOptions = {},
  ): ForAllResult<T> {
    return runForAll(this, property, options);
  }
}

/* ======================================================================
 *  Property runner
 * ====================================================================== */

/** Options for {@link forAll}. */
export interface ForAllOptions {
  /** Number of random tests to run. Default: `100`. */
  numRuns?: number;
  /** Initial RNG seed. Default: `0`. */
  seed?: number;
  /** Maximum shrink iterations per failing case. Default: `100`. */
  maxShrink?: number;
}

/** The result of a {@link forAll} run. */
export interface ForAllResult<T> {
  /** `true` if all runs passed. */
  passed: boolean;
  /** The number of runs executed. */
  runs: number;
  /** The minimal counterexample (if `passed` is `false`). */
  counterexample?: T;
  /** The error message from the failing property (if `passed` is `false`). */
  reason?: string;
}

/**
 * Internal property runner — used by {@link ValueGenerator.forAll}.
 * Not exported; callers use `generator.forAll(property, options)`.
 */
function runForAll<T>(
  gen: ValueGenerator<T>,
  property: (value: T) => boolean | void,
  options: ForAllOptions = {},
): ForAllResult<T> {
  const numRuns = options.numRuns ?? 100;
  const seed = options.seed ?? 0;
  const maxShrink = options.maxShrink ?? 100;
  const rng = new RNG(seed);

  const fail = (
    value: T,
    run: number,
    reason: string,
    originalError?: unknown,
  ): never => {
    const minimized = minimize(gen, property, value, maxShrink);
    const message = originalError instanceof Error
      ? originalError.message
      : reason;
    throw new PropertyFailure(
      `property failed on run ${run + 1}/${numRuns} (seed ${seed})`,
      minimized,
      message,
    );
  };

  for (let run = 0; run < numRuns; run++) {
    // Derive a per-run seed from the base seed's PRNG, so each run explores
    // a different part of the generation space while remaining reproducible.
    const runSeed = rng.next();
    const value = gen.sample(runSeed);
    try {
      const result = property(value);
      if (result === false) {
        fail(value, run, "property returned false");
      }
    } catch (e) {
      fail(value, run, "property threw", e);
    }
  }

  return { passed: true, runs: numRuns };
}

/** Error thrown by {@link forAll} when the property fails. */
export class PropertyFailure extends Error {
  constructor(
    message: string,
    readonly counterexample: unknown,
    readonly reason: string,
  ) {
    super(
      `${message}\n  Counterexample: ${
        PropertyFailure.format(counterexample)
      }\n  Reason: ${reason}`,
    );
    this.name = "PropertyFailure";
  }

  /** Format a counterexample value for display in the error message. */
  private static format(value: unknown): string {
    if (typeof value === "string") return JSON.stringify(value);
    if (
      value !== null && typeof value === "object" &&
      typeof (value as { print?: unknown }).print === "function"
    ) {
      return (value as { print: () => string }).print();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}

/* ======================================================================
 *  Minimization (shrinking)
 * ====================================================================== */

/**
 * Minimize a counterexample by repeatedly shrinking until the property
 * still fails on the simplest value found. Recursive: each successful
 * shrink restarts from the simpler value.
 *
 * Returns the minimized value. The budget is decremented explicitly per
 * candidate examined (not via closure mutation), so the accounting is
 * transparent and refactor-safe.
 */
function minimize<T>(
  gen: ValueGenerator<T>,
  property: (value: T) => boolean | void,
  value: T,
  maxIterations: number,
): T {
  const fails = (v: T): boolean => {
    try {
      return property(v) === false;
    } catch {
      return true;
    }
  };
  const recur = (best: T, budget: number): T => {
    if (budget <= 0) return best;
    // Find the first shrunk candidate that still fails, decrementing budget
    // explicitly for each candidate examined.
    let spent = 0;
    const candidates = gen.shrink(best);
    const simpler = candidates.find((c) => {
      spent++;
      return fails(c);
    });
    return simpler ? recur(simpler, budget - spent) : best;
  };
  return recur(value, maxIterations);
}

/* ======================================================================
 *  Structural key for dedup
 * ====================================================================== */

/**
 * Build a stable structural key for a value, for deduplication in
 * {@link GrammarGenerator.shrink}. Uses `JSON.stringify` with a cycle guard.
 * Class instances are serialized via their own enumerable properties
 * (prefixed with the constructor name for type discrimination); if
 * `JSON.stringify` fails entirely (e.g. circular structures the cycle
 * guard can't handle), falls back to constructor name + `String(v)`.
 * Primitives are keyed by their type tag + value.
 */
function stableKey(v: unknown): string {
  if (typeof v === "string") return `s:${v}`;
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "boolean") return `b:${v}`;
  if (v === null) return "null";
  if (v === undefined) return "undef";
  // Object/array — JSON.stringify with a cycle guard.
  const seen = new WeakSet();
  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[cyclic]";
      seen.add(val);
    }
    return val;
  };
  try {
    // For class instances, prefix with the constructor name so that
    // structurally identical but type-distinct instances get different keys.
    const ctor = (v as object)?.constructor?.name;
    const json = JSON.stringify(v, replacer);
    return ctor && ctor !== "Object" && ctor !== "Array"
      ? `c:${ctor}:${json}`
      : "o:" + json;
  } catch {
    // Fallback: constructor name + String(v).
    return "r:" + (v as object)?.constructor?.name + ":" + String(v);
  }
}
