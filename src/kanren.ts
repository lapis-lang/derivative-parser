/**
 * Yield-Kanren — a micro relational programming engine using JS generators.
 *
 * A self-contained implementation of the microKanren core (unification,
 * fresh variables, conjunction, disjunction) using JavaScript generators
 * for backtracking, inspired by both:
 *
 * - **microKanren** (Hemann & Friedman, Scheme Workshop 2013): the minimal
 *   relational programming core with unification and stream-based search.
 * - **Yield Prolog** (https://yieldprolog.sourceforge.net/): the insight
 *   that `yield`/`for...of` can express backtracking choice points, with
 *   `try/finally` for automatic undo on backtracking.
 *
 * ## Core operations
 *
 * | Operation | Effect |
 * |---|---|
 * | `unify(u, v, s)` | Unify two terms under substitution `s`; yields each satisfying substitution. |
 * | `fresh(f)` | Introduce a fresh logic variable. |
 * | `conj(g1, g2)` | Conjunction — both goals must hold (AND). |
 * | `disj(g1, g2)` | Disjunction — either goal may hold (OR). |
 * | `run(goal, n?)` | Run a goal and collect up to `n` answers. |
 *
 * ## Terms
 *
 * Logic terms are either:
 * - **Atoms**: strings, numbers, booleans (compared by value)
 * - **Logic variables**: `Var` instances (compared by identity)
 * - **Compound terms**: `Term` instances with a tag and args (unified
 *   structurally, like Prolog functors)
 *
 * @module
 */

/* ======================================================================
 *  Logic variables
 * ====================================================================== */

/**
 * A logic variable — an unknown that can be bound to a value during
 * unification. Two `Var`s are equal iff they are the same object
 * (identity, not value equality).
 */
export class Var {
  /** A unique id for debugging/display. */
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
  /** Returns a display string of the form `_.<id>`. */
  toString(): string {
    return `_.${this.id}`;
  }
}

/* ======================================================================
 *  Terms
 * ====================================================================== */

/** Any value that can appear in the unification system. */
export type LogicValue = Var | Term | string | number | boolean;

/**
 * A compound term — a tagged structure with zero or more arguments,
 * like a Prolog functor. Unified structurally: two terms unify iff they
 * have the same tag and the same number of args, and each pair of args
 * unifies. Arguments may be `Term`s, `Var`s, or primitives — so logic
 * variables can appear inside compound terms (e.g. `term("→", x, y)`
 * where `x` and `y` are `Var`s).
 *
 * @example
 * ```ts
 * const arrow = (dom: LogicValue, cod: LogicValue): Term => term("→", dom, cod);
 * const int = term("Int");
 * const bool = term("Bool");
 * // arrow(int, bool)  →  term("→", term("Int"), term("Bool"))
 * ```
 */
export class Term {
  /** The functor tag, e.g. `"→"`, `"Int"`, `"Bool"`. */
  readonly tag: string;
  /** The arguments (zero for atoms represented as terms). */
  readonly args: readonly LogicValue[];
  constructor(tag: string, ...args: LogicValue[]) {
    this.tag = tag;
    this.args = args;
  }
  /** Returns the tag for atoms, or `tag(arg₁, arg₂, …)` for compound terms. */
  toString(): string {
    return this.args.length === 0
      ? this.tag
      : `${this.tag}(${this.args.map((a) => a.toString()).join(", ")})`;
  }
}

/* ======================================================================
 *  Substitution
 * ====================================================================== */

/**
 * A substitution (association list of `Var → LogicValue`).
 * Represented as a `Map` for O(1) lookup.
 */
export class Substitution {
/** The internal variable-to-value binding map. */
  private readonly bindings: Map<Var, LogicValue>;
  private constructor(bindings: Map<Var, LogicValue>) {
    this.bindings = bindings;
  }
  /** The empty substitution. */
  static empty(): Substitution {
    return new Substitution(new Map());
  }
  /** Look up `v` in this substitution; return its bound value or `undefined`. */
  get(v: Var): LogicValue | undefined {
    return this.bindings.get(v);
  }
  /** Extend this substitution with `v → val`, returning a new substitution. */
  extend(v: Var, val: LogicValue): Substitution {
    const m = new Map(this.bindings);
    m.set(v, val);
    return new Substitution(m);
  }
  /** Check whether `v` is bound in this substitution. */
  has(v: Var): boolean {
    return this.bindings.has(v);
  }
}

/* ======================================================================
 *  Walk — follow variable bindings
 * ====================================================================== */

/**
 * Follow the binding chain for `v` in `s` until a non-variable or an
 * unbound variable is reached. This is the core lookup operation:
 * `walk(v, s)` resolves `v` to its ultimate value under `s`.
 */
export function walk(v: LogicValue, s: Substitution): LogicValue {
  while (v instanceof Var && s.has(v)) {
    v = s.get(v)!;
  }
  return v;
}

/* ======================================================================
 *  Unification
 * ====================================================================== */

/**
 * Unify `u` and `v` under substitution `s`. Yields each satisfying
 * substitution (there is at most one — unification is deterministic).
 * Yields nothing if `u` and `v` cannot be unified.
 *
 * This is a generator: the caller iterates with `for...of` to get
 * solutions, following the Yield Prolog convention.
 *
 * @example
 * ```ts
 * const x = new Var(0);
 * for (const s of unify(x, term("Int"), Substitution.empty())) {
 *   // s binds x → term("Int")
 * }
 * ```
 */
export function* unify(
  u: LogicValue,
  v: LogicValue,
  s: Substitution,
): Generator<Substitution> {
  const u2 = walk(u, s);
  const v2 = walk(v, s);

  // Same variable → already unified.
  if (u2 instanceof Var && v2 instanceof Var && u2 === v2) {
    yield s;
    return;
  }
  // u is an unbound variable → bind it.
  if (u2 instanceof Var) {
    yield s.extend(u2, v2);
    return;
  }
  // v is an unbound variable → bind it.
  if (v2 instanceof Var) {
    yield s.extend(v2, u2);
    return;
  }
  // Both are Terms → unify tag and args structurally.
  if (u2 instanceof Term && v2 instanceof Term) {
    if (u2.tag !== v2.tag || u2.args.length !== v2.args.length) return;
    yield* unifyArgs(u2.args, v2.args, s);
    return;
  }
  // Both are primitives → compare by value.
  if (
    typeof u2 !== "object" && typeof v2 !== "object" &&
    u2 === v2
  ) {
    yield s;
    return;
  }
  // One is Term, other is primitive → cannot unify.
  // (Term vs string/number/boolean never unifies.)
}

/** Unify two arrays of arguments pairwise. */
function* unifyArgs(
  us: readonly LogicValue[],
  vs: readonly LogicValue[],
  s: Substitution,
): Generator<Substitution> {
  if (us.length === 0) {
    yield s;
    return;
  }
  for (const s1 of unify(us[0]!, vs[0]!, s)) {
    yield* unifyArgs(us.slice(1), vs.slice(1), s1);
  }
}

/* ======================================================================
 *  Goals
 * ====================================================================== */

/**
 * A goal: a function from substitution to a stream of satisfying
 * substitutions. Implemented as a generator function — the generator
 * yields one substitution per solution.
 */
export type Goal = (s: Substitution) => Generator<Substitution>;

/**
 * The unification goal: `==` in microKanren. Succeeds iff `u` and `v`
 * unify under the current substitution.
 */
export function eq(u: LogicValue, v: LogicValue): Goal {
  return function* (s: Substitution): Generator<Substitution> {
    yield* unify(u, v, s);
  };
}

/**
 * Introduce a fresh logic variable. The callback receives the new
 * variable and returns a goal that may use it. This is `call/fresh` in
 * microKanren, `fresh` in miniKanren.
 *
 * Variable IDs are assigned from a module-level monotonic counter, so
 * IDs are deterministic within a single process run (no `Math.random`).
 */
let varCounter = 0;

/** Introduce a single fresh logic variable. */
export function fresh(f: (x: Var) => Goal): Goal;
/** Introduce two fresh logic variables. */
export function fresh(f: (x: Var, y: Var) => Goal): Goal;
/** Introduce three fresh logic variables. */
export function fresh(f: (x: Var, y: Var, z: Var) => Goal): Goal;
/** Introduce fresh logic variables (implementation overload). */
export function fresh(f: (...vars: Var[]) => Goal): Goal {
  return function* (s: Substitution): Generator<Substitution> {
    const baseId = varCounter;
    varCounter += 3;
    const vars = [new Var(baseId), new Var(baseId + 1), new Var(baseId + 2)];
    yield* f(...vars)(s);
  };
}

/**
 * Conjunction (AND): both `g1` and `g2` must succeed. This is `conj` /
 * `bind` in microKanren — for each solution of `g1`, run `g2`.
 */
export function conj(g1: Goal, g2: Goal): Goal {
  return function* (s: Substitution): Generator<Substitution> {
    for (const s1 of g1(s)) {
      yield* g2(s1);
    }
  };
}

/**
 * Disjunction (OR): either `g1` or `g2` may succeed. This is `disj` /
 * `mplus` in microKanren — solutions from `g1` and `g2` are interleaved.
 */
export function disj(g1: Goal, g2: Goal): Goal {
  return function* (s: Substitution): Generator<Substitution> {
    yield* g1(s);
    yield* g2(s);
  };
}

/**
 * Conjunction of multiple goals (left-to-right). Convenience for
 * `conj(g1, conj(g2, conj(g3, ...)))`.
 */
export function conjAll(...goals: Goal[]): Goal {
  if (goals.length === 0) {
    return function* (s: Substitution): Generator<Substitution> {
      yield s;
    };
  }
  return goals.reduce((acc, g) => conj(acc, g));
}

/**
 * Disjunction of multiple goals. Convenience for
 * `disj(g1, disj(g2, disj(g3, ...)))`.
 */
export function disjAll(...goals: Goal[]): Goal {
  if (goals.length === 0) {
    return function* (_s: Substitution): Generator<Substitution> {
      // No goals → no solutions.
    };
  }
  return goals.reduce((acc, g) => disj(acc, g));
}

/* ======================================================================
 *  Running goals
 * ====================================================================== */

/**
 * Run a goal against the empty substitution and collect up to `n`
 * answers (default: all). Each answer is the substitution after
 * reification of the first variable (variable 0).
 *
 * @param goal The goal to run.
 * @param n Maximum number of answers to collect. Default: `Infinity`.
 * @returns An array of answers (substitutions).
 */
export function run(goal: Goal, n: number = Infinity): Substitution[] {
  const results: Substitution[] = [];
  for (const s of goal(Substitution.empty())) {
    results.push(s);
    if (results.length >= n) break;
  }
  return results;
}

/**
 * Run a goal and check whether it has at least one solution.
 * @returns `true` if the goal succeeds at least once.
 */
export function runExists(goal: Goal): boolean {
  for (const _s of goal(Substitution.empty())) {
    return true;
  }
  return false;
}

/* ======================================================================
 *  Term construction helpers
 * ====================================================================== */

/** Construct an atomic term (a `Term` with no args). */
export function atom(tag: string): Term {
  return new Term(tag);
}

/** Construct a compound term with the given tag and args. */
export function term(tag: string, ...args: LogicValue[]): Term {
  return new Term(tag, ...args);
}

/**
 * Parse a type string (e.g. `"σ → τ"`, `"Int"`, `"Bool"`) into a `Term`.
 * Arrow types (`→`) are parsed as binary compound terms: `term("→", dom, cod)`.
 * Other tokens become atomic terms.
 */
export function parseType(formula: string): Term {
  const arrow = "→";
  if (formula.includes(arrow)) {
    const parts = formula.split(arrow).map((p) => p.trim());
    if (parts.length === 2) {
      return term(arrow, parseType(parts[0]!), parseType(parts[1]!));
    }
  }
  return atom(formula.trim());
}
