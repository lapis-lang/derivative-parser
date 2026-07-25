/**
 * Grammar-native contracts — Design by Contract primitives adapted to the
 * parsing domain.
 *
 * This module provides a small contract system (no external dependency)
 * inspired by [`decorator-contracts`](https://github.com/final-hill/decorator-contracts)
 * but adapted for `Grammar`:
 *
 * - `assert` — inline assertions with TypeScript type narrowing.
 * - `implies` / `iff` — material implication and biconditional for predicate
 *   composition.
 * - `@requires` — inference-rule premises; on failure returns `undefined`
 *   (graceful — the calling `chain`/`.map` produces `empty()`), unlike the
 *   reference library which throws.
 * - `@ensures` — inference-rule conclusions; on failure throws `ContractError`
 *   (a violated postcondition is a bug, not a parse failure).
 * - `@invariant` — grammar well-formedness; checked after construction and
 *   after each contracted semantic action.
 * - `checkedMode` — per-instance flag (with a global default); when `false`,
 *   all checks are skipped for that instance (zero overhead in production).
 *
 * Contracts decorate **semantic-action methods** (e.g. `app`, `lam`,
 * `varRef`) — plain methods called inside `.map()` callbacks — not `@rule`
 * productions, so they compose with the existing `@rule` machinery without
 * engine changes.
 *
 * @module
 */

/* ======================================================================
 *  Errors
 * ====================================================================== */

/**
 * Thrown by `assert` when an inline assertion fails.
 *
 * Assertions catch *bugs* (violated invariants of the implementation), not
 * parse failures — hence they always throw, never return `undefined`.
 */
export class AssertionError extends Error {
  constructor(message = "Assertion Error") {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Thrown by `@ensures` / `@invariant` when a contract is violated, and by
 * `@rescue` when `retry` is misused.
 *
 * A violated postcondition or invariant is a bug in the semantic-action
 * implementation, not a parse failure — hence it throws rather than
 * producing an empty parse forest.
 */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/* ======================================================================
 *  Logical primitives
 * ====================================================================== */

/**
 * Inline assertion. If `condition` is falsy, throws {@link AssertionError}.
 *
 * In TypeScript, `assert` also narrows the type of `condition` — useful for
 * narrowing the `unknown`-typed `ctx` parameter in parameterised productions:
 *
 *   assert(typeof param === "string");
 *   // param: string
 *
 * `assert` should **not** be used for validating arguments to semantic
 * actions — use `@requires` for that (which fails gracefully). Use `assert`
 * for invariants of the implementation that, if violated, indicate a bug.
 *
 * @param condition - The condition to test.
 * @param message - Optional message displayed if the condition is false.
 * @throws {AssertionError} If `condition` is falsy.
 */
export function assert(
  condition: unknown,
  message = "Assertion Error",
): asserts condition {
  if (Boolean(condition) === false) {
    throw new AssertionError(message);
  }
}

/**
 * Material implication: `p → q`. Logically equivalent to `!p || q`.
 *
 * Useful for composing predicates in `@requires` / `@ensures` so that the
 * expression reads as logic rather than boolean arithmetic:
 *
 *   @requires((_self, fn: Type, arg: Type) =>
 *     implies(fn instanceof TFun, typeEq(fn.dom, arg)))
 *
 * @param p - The antecedent.
 * @param q - The consequent.
 * @returns `!p || q`.
 */
export function implies(p: boolean, q: boolean): boolean {
  return !p || q;
}

/**
 * Biconditional: `p ↔ q` ("p if and only if q"). Logically equivalent to
 * `implies(p, q) && implies(q, p)`, i.e. `(p && q) || (!p && !q)`.
 *
 * @param p - The first boolean.
 * @param q - The second boolean.
 * @returns `(p && q) || (!p && !q)`.
 */
export function iff(p: boolean, q: boolean): boolean {
  return (p && q) || (!p && !q);
}

/* ======================================================================
 *  Checked mode
 * ====================================================================== */

/**
 * Global default for contract checking. New `Grammar` instances inherit
 * this value at construction time; per-instance overrides are stored in
 * {@link instanceCheckedMode}. Toggle the default with
 * {@link setCheckedMode} / {@link getCheckedMode}.
 */
let globalCheckedMode = true;

/**
 * Per-instance checked-mode overrides. A `Grammar` instance not in this
 * map uses {@link globalCheckedMode}. Scoping the flag per-instance (rather
 * than purely global) prevents concurrent/overlapping executions — e.g.
 * parallel parses or interleaved async tasks — from disabling each other's
 * checks via {@link withoutChecks}.
 */
const instanceCheckedMode = new WeakMap<object, boolean>();

/**
 * Returns `true` if contract checks are enabled for `instance` (the default).
 * Falls back to {@link globalCheckedMode} when no per-instance override is
 * set.
 */
function checkedModeFor(instance: object): boolean {
  return instanceCheckedMode.get(instance) ?? globalCheckedMode;
}

/**
 * Set the per-instance checked-mode override on `instance`.
 */
function setCheckedModeFor(instance: object, enabled: boolean): void {
  instanceCheckedMode.set(instance, enabled);
}

/**
 * Returns the global default for contract checking (applied to new
 * `Grammar` instances at construction).
 *
 * @returns `true` if contract checks are enabled by default.
 */
export function getCheckedMode(): boolean {
  return globalCheckedMode;
}

/**
 * Set the global default for contract checking. Disable in production for
 * maximum performance:
 *
 *   import { setCheckedMode } from "@lapis-lang/zipper-grammar";
 *   setCheckedMode(process.env.NODE_ENV === "development");
 *
 * Note: this only affects instances created *after* the call (and
 * instances with no per-instance override). To toggle an existing instance,
 * use {@link setCheckedModeFor}.
 */
export function setCheckedMode(enabled: boolean): void {
  globalCheckedMode = enabled;
}

/**
 * Run `fn` with contract checks temporarily disabled for `instance` only.
 * Used inside predicate evaluation to avoid infinite recursion when a
 * predicate calls a contracted method on the same instance. Scoped per
 * instance so concurrent operations on *other* instances are unaffected.
 * Restores the prior value on exit, even if `fn` throws.
 */
function withoutChecks<T>(instance: object, fn: () => T): T {
  const prior = checkedModeFor(instance);
  setCheckedModeFor(instance, false);
  try {
    return fn();
  } finally {
    setCheckedModeFor(instance, prior);
  }
}

/* ======================================================================
 *  Contract metadata (Symbol.metadata)
 * ====================================================================== */
//
// Predicates are stored on `Class[Symbol.metadata]` via the TS5 stage-3
// decorator `ctx.metadata` / `ctx.addInitializer` API. Each decorator pushes
// its predicate into an array keyed by feature name. Subcontracting falls
// out naturally: `Class[Symbol.metadata]?.requires?.[name]` walks the
// prototype chain, so a subclass's predicates compose with its ancestors'
// (OR-ed for `@requires`, AND-ed for `@ensures` / `@invariant`).

/** Metadata shape stored on each contracted class via `Symbol.metadata`. */
export interface ContractMetadata {
  /** Class invariants — AND-ed across the inheritance chain. */
  invariants: InvariantPredicate[];
  /** Per-feature preconditions — OR-ed across the inheritance chain. */
  requires: Record<PropertyKey, RequiresPredicate[]>;
  /** Per-feature postconditions — AND-ed across the inheritance chain. */
  ensures: Record<PropertyKey, EnsuresPredicate[]>;
  /** Per-feature rescue handlers — inherited unless overridden. */
  rescue: Record<PropertyKey, RescueHandler>;
}

/**
 * Private symbol under which {@link ContractMetadata} is stored on a class's
 * `Symbol.metadata` object. Using a dedicated key avoids conflicting with
 * other decorators that may share `Symbol.metadata`.
 */
const CONTRACTS = Symbol.for("@lapis-lang/zipper-grammar/contracts");

/**
 * Retrieve (or initialise) the {@link ContractMetadata} stored on a given
 * `Symbol.metadata` object (the `ctx.metadata` passed to a decorator).
 */
function metaOn(symMeta: object): ContractMetadata {
  const store = symMeta as Record<symbol, unknown>;
  const existing = store[CONTRACTS] as ContractMetadata | undefined;
  if (existing) return existing;
  const fresh: ContractMetadata = {
    invariants: [],
    requires: {},
    ensures: {},
    rescue: {},
  };
  store[CONTRACTS] = fresh;
  return fresh;
}

/**
 * Retrieve (or initialise) the {@link ContractMetadata} stored on a class
 * constructor's `Symbol.metadata`. Returns `undefined` if the class has no
 * metadata object (e.g. it was never decorated).
 */
function metadataOf(
  Class: abstract new (...args: unknown[]) => unknown,
): ContractMetadata | undefined {
  const symMeta = (Class as unknown as { [Symbol.metadata]?: object })[
    Symbol.metadata
  ];
  if (!symMeta) return undefined;
  return metaOn(symMeta);
}

/**
 * Walk the prototype chain of `instance`'s class and collect every
 * `ContractMetadata` (most-derived first). Used to evaluate inherited
 * contracts for subcontracting.
 */
function* chainMetadata(instance: object): Generator<ContractMetadata> {
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    const meta = metadataOf(
      proto.constructor as abstract new (...args: unknown[]) => unknown,
    );
    if (meta) yield meta;
    proto = Object.getPrototypeOf(proto);
  }
}

/* ======================================================================
 *  Predicate types
 * ====================================================================== */

/** A class invariant predicate: `(self) => boolean`. */
export type InvariantPredicate<This = unknown> = (self: This) => boolean;

/** A precondition predicate: `(self, ...args) => boolean`. */
export type RequiresPredicate<This = unknown, A extends unknown[] = unknown[]> =
  (
    self: This,
    ...args: A
  ) => boolean;

/** A postcondition predicate: `(self, args, old, result) => boolean`. */
export type EnsuresPredicate<
  This = unknown,
  A extends unknown[] = unknown[],
  R = unknown,
> = (
  self: This,
  args: A,
  old: This,
  result: R,
) => boolean;

/* ======================================================================
 *  @invariant — class decorator
 * ====================================================================== */

/**
 * `@invariant(pred)` — class decorator declaring a class invariant.
 *
 * The invariant is checked after construction and after each contracted
 * semantic action (via {@link assertInvariants}). When subclassing, the
 * subclass invariant is AND-ed with the base class invariant (strengthened),
 * per Liskov subcontracting.
 *
 *   @invariant((self: AbstractSTLC<any>) => self.start() !== undefined)
 *   class AbstractSTLC<...> extends Grammar<...> { ... }
 */
export function invariant<
  This extends abstract new (...args: unknown[]) => unknown,
>(
  predicate: InvariantPredicate<InstanceType<This>>,
): (value: This, ctx: ClassDecoratorContext<This>) => This {
  return (value, ctx) => {
    if (ctx.kind !== "class") {
      throw new ContractError("@invariant can only decorate a class");
    }
    ctx.addInitializer(function (this: This) {
      const meta = metaOn(ctx.metadata);
      meta.invariants = [...meta.invariants, predicate as InvariantPredicate];
    });
    return value;
  };
}

/**
 * Append `predicate` to the named `table` (`requires` / `ensures`) under
 * `key`, creating the array if absent. Shared by `@requires` / `@ensures`.
 */
function registerPredicate(
  meta: ContractMetadata,
  table: "requires" | "ensures",
  key: PropertyKey,
  predicate: RequiresPredicate | EnsuresPredicate,
): void {
  const existing = meta[table][key] ?? [];
  meta[table][key] = [...existing, predicate];
}

/**
 * Collect every predicate declared for `prop` under `table` across the
 * whole inheritance chain (most-derived first). Shared by the Proxy
 * `get` trap and `assertInvariants`.
 */
function* collectPredicates(
  target: object,
  table: "requires" | "ensures" | "invariants",
  prop?: PropertyKey,
): Generator<RequiresPredicate | EnsuresPredicate | InvariantPredicate> {
  for (const meta of chainMetadata(target)) {
    const preds = prop === undefined
      ? meta.invariants
      : (meta[table] as Record<PropertyKey, unknown[]>)[prop] ?? [];
    for (const p of preds) yield p as RequiresPredicate;
  }
}

/**
 * Format a contract-violation message naming the class (and optionally the
 * feature). Shared by `assertInvariants` and the `@ensures` check.
 */
function violationMessage(
  target: object,
  kind: "Invariant" | "Postcondition",
  prop?: PropertyKey,
): string {
  const Class = target.constructor;
  const where = prop === undefined ? "" : `.${String(prop)}`;
  return `${kind} violated on ${Class.name}${where}`;
}

/**
 * Wrap `target` in the contract-enforcement `Proxy`, or return it unchanged
 * when `checkedMode` is disabled. Called from `Grammar`'s constructor so
 * the contracts layer owns the Proxy-creation decision.
 */
export function wrapWithContracts<T extends object>(target: T): T {
  if (!checkedModeFor(target)) return target;
  return new Proxy(target, contractProxyHandler) as unknown as T;
}

/**
 * Evaluate all invariants (AND-ed across the inheritance chain) on
 * `instance`. Throws {@link ContractError} if any invariant is violated.
 * No-op when `checkedMode` is disabled.
 */
export function assertInvariants(instance: object): void {
  const err = tryInvariants(instance);
  if (err !== null) throw err;
}

/**
 * Like {@link assertInvariants} but returns the error instead of throwing
 * (or `null` if all invariants hold). Used inside `finally` blocks where
 * throwing is unsafe (no-unsafe-finally).
 */
function tryInvariants(instance: object): ContractError | null {
  if (!checkedModeFor(instance)) return null;
  return withoutChecks(instance, () => {
    for (const inv of collectPredicates(instance, "invariants")) {
      if (!(inv as InvariantPredicate)(instance)) {
        return new ContractError(violationMessage(instance, "Invariant"));
      }
    }
    return null;
  });
}

/* ======================================================================
 *  @requires — precondition decorator (graceful failure)
 * ====================================================================== */

/**
 * `@requires(pred)` — method decorator declaring a precondition (an
 * inference-rule premise).
 *
 * Unlike the reference library (which throws on failure), `@requires`
 * **returns `undefined`** when the precondition fails — the calling
 * `chain`/`.map` callback then produces `empty()`, so the parse branch is
 * rejected gracefully rather than raising an exception. This is the core
 * domain adaptation: a failed premise means the inference rule doesn't
 * apply, so the parse forest for that branch is empty.
 *
 * When subclassing, preconditions are OR-ed (weakened) across the
 * inheritance chain: the subclass accepts a superset of the inputs.
 *
 *   @requires((_self, fn: Type, arg: Type) =>
 *     fn instanceof TFun && typeEq(fn.dom, arg))
 *   protected app(fn: Type, arg: Type): Type { ... }
 *
 * The decorator only **registers** the predicate in the class's contract
 * metadata; the actual check is performed by the `Proxy` dispatch layer
 * in {@link contractProxyHandler} (see {@link Grammar}). This means
 * inherited preconditions are enforced even on subclass overrides that do
 * not re-declare `@requires`.
 */
export function requires<This extends object, A extends unknown[], R>(
  predicate: RequiresPredicate<This, A>,
): <F extends (this: This, ...args: A) => R>(
  target: F,
  ctx: ClassMethodDecoratorContext<This, F>,
) => void {
  return (_target, ctx) => {
    if (ctx.kind !== "method") {
      throw new ContractError("@requires can only decorate a method");
    }
    ctx.addInitializer(function (this: This) {
      registerPredicate(
        metaOn(ctx.metadata),
        "requires",
        ctx.name,
        predicate as RequiresPredicate,
      );
    });
  };
}

/* ======================================================================
 *  @ensures — postcondition decorator (throws on violation)
 * ====================================================================== */

/**
 * `@ensures(pred)` — method decorator declaring a postcondition (an
 * inference-rule conclusion).
 *
 * The predicate receives `(self, args, old, result)` where `old` is a
 * shallow snapshot of `self`'s own enumerable properties taken before the
 * method body runs, and `result` is the method's return value. If the
 * postcondition fails, {@link ContractError} is thrown — a violated
 * postcondition is a bug in the semantic action, not a parse failure.
 *
 * When subclassing, postconditions are AND-ed (strengthened) across the
 * inheritance chain: the subclass guarantees a more specific postcondition.
 *
 *   @ensures((_self, _args, _old, result: Type) =>
 *     result instanceof TVar || result instanceof TFun)
 *   protected app(fn: Type, arg: Type): Type { ... }
 *
 * Like `@requires`, this decorator only **registers** the predicate; the
 * check is performed by the `Proxy` dispatch layer, so inherited
 * postconditions are enforced on undecorated overrides.
 */
export function ensures<This extends object, A extends unknown[], R>(
  predicate: EnsuresPredicate<This, A, R>,
): <F extends (this: This, ...args: A) => R>(
  target: F,
  ctx: ClassMethodDecoratorContext<This, F>,
) => void {
  return (_target, ctx) => {
    if (ctx.kind !== "method") {
      throw new ContractError("@ensures can only decorate a method");
    }
    ctx.addInitializer(function (this: This) {
      registerPredicate(
        metaOn(ctx.metadata),
        "ensures",
        ctx.name,
        predicate as EnsuresPredicate,
      );
    });
  };
}

/**
 * Shallow snapshot of an object's own enumerable *string* keys, used as the
 * `old` value passed to `@ensures` predicates. Returns a plain object with
 * the same own enumerable string-keyed properties. Symbol-keyed properties
 * are not included (they are skipped by `Object.keys`).
 */
function snapshotOld<T>(self: T): T {
  const old: Record<PropertyKey, unknown> = {};
  for (const key of Object.keys(self as unknown as object)) {
    old[key] = (self as unknown as Record<PropertyKey, unknown>)[key];
  }
  return old as unknown as T;
}

/* ======================================================================
 *  @rescue — parse-failure recovery with diagnostics
 * ====================================================================== */

/**
 * Describes why a production's parse yielded an empty forest. Passed to a
 * `@rescue` handler so it can report diagnostics or retry with an
 * alternative strategy.
 */
export interface ParseFailure {
  /** Machine-readable reason category, e.g. `"type-mismatch"`. */
  reason: string;
  /** Human-readable detail. */
  message?: string;
  /** The value that was expected (if applicable). */
  expected?: unknown;
  /** The value that was found (if applicable). */
  actual?: unknown;
  /** 0-based source position of the failure, if known. */
  position?: number;
  /** Name of the production that failed. */
  production: string;
}

/**
 * Handler invoked when a `@rescue`-decorated production yields an empty
 * parse forest. May return a `Parser<T>` (e.g. `this.empty()` or a
 * diagnostic-bearing epsilon) or call `retry` to re-run the production
 * once. If the handler returns without calling `retry`, its return value
 * is used as the production's result.
 *
 *   @rescue((self, failure, _args, retry) => {
 *     if (failure.reason === "type-mismatch") {
 *       self.diagnostic(`type error: ${failure.expected} ≠ ${failure.actual}`);
 *     }
 *     return self.empty();
 *   })
 */
export type RescueHandler = (
  self: object,
  failure: ParseFailure,
  args: unknown[],
  retry?: () => unknown,
) => unknown;

/**
 * `@rescue(handler)` — method/getter decorator declaring a rescue handler
 * for a production. When the production's parse yields an empty forest,
 * the handler is invoked with a {@link ParseFailure} describing the
 * failure. The handler may report a diagnostic, return an alternative
 * parser, or call `retry` to re-run the production once.
 *
 * Inherited unless overridden: a subclass that does not re-declare
 * `@rescue` inherits the parent's handler (most-derived wins).
 *
 *   @rescue((self, failure, _args, retry) => {
 *     self.diagnostic(`type error: ${failure.message}`);
 *     return self.empty();
 *   })
 *   @rule
 *   protected override appProd(ctx: unknown): Parser<Type> { ... }
 *
 * The decorator accepts both **getter** and **method** productions; the
 * decorator order with `@rule` does not matter (see
 * `test/contracts.test.ts`).
 */

/** Decorator factory for `@rescue` — accepts both getter and method productions. */
export function rescue(
  handler: RescueHandler,
): (
  target: unknown,
  ctx:
    | ClassGetterDecoratorContext<object, unknown>
    | ClassMethodDecoratorContext<object, (...args: unknown[]) => unknown>,
) => void;
export function rescue(
  handler: RescueHandler,
): (
  target: unknown,
  ctx:
    | ClassGetterDecoratorContext<object, unknown>
    | ClassMethodDecoratorContext<object, (...args: unknown[]) => unknown>,
) => void {
  return (_target, ctx) => {
    if (ctx.kind !== "method" && ctx.kind !== "getter") {
      throw new ContractError("@rescue can only decorate a method or getter");
    }
    ctx.addInitializer(function (this: object) {
      const meta = metaOn(ctx.metadata);
      meta.rescue[ctx.name] = handler;
    });
  };
}

/**
 * Look up the rescue handler for `prop` on `target`'s inheritance chain
 * (most-derived wins). Returns `undefined` if none is declared.
 */
export function findRescueHandler(
  target: object,
  prop: PropertyKey,
): RescueHandler | undefined {
  for (const meta of chainMetadata(target)) {
    const h = meta.rescue[prop];
    if (h) return h;
  }
  return undefined;
}

/* ======================================================================
 *  Proxy dispatch — enforces contracts on every method call
 * ====================================================================== */
//
// The decorators above only *register* predicates in the class's contract
// metadata. The actual enforcement happens here: a `Proxy` handler that
// intercepts method calls and wraps them with the contract checks. This is
// the mechanism that lets inherited `@requires` / `@ensures` fire on
// subclass overrides that do not re-declare the decorators — the `get`
// trap sees every method access and applies the checks by walking the
// prototype chain's metadata.
//
// Key design points (resolving the issue #4 "No Proxy" concern):
//   • No `Contracted` base class — the handler is applied in `Grammar`'s
//     own constructor via `return new Proxy(this, contractProxyHandler)`.
//   • No `.new()` factory — `new Grammar()` returns the Proxy directly
//     because a constructor may return a different object.
//   • `@rule` memoization is unaffected — the `WeakMap` is keyed on the
//     *target* (the unwrapped instance), which the Proxy forwards to
//     transparently. Internal `this` references resolve on the target.
//   • `checkedMode` gates the whole handler: when disabled, `get`/`set`
//     fall through to the target with zero overhead.

/**
 * The set of property keys that must bypass contract checking (internal
 * machinery, combinators, and the parse driver). Contract checks only apply
 * to *semantic-action* methods — the user-facing methods that return
 * values, not the `Parser`-returning productions or engine internals.
 *
 * Rather than maintain an allow-list (fragile), we check whether the
 * resolved property is a function that is *not* a `@rule`-decorated
 * production. `@rule` replaces the method on the prototype with a wrapper
 * that returns a `Parser`; we detect productions by a sentinel. See
 * `Grammar._isProduction`.
 */
const CONTRACT_SKIP_KEYS = new Set<PropertyKey>([
  "constructor",
  "start", // entry production is a @rule getter; skip
]);

/**
 * `ProxyHandler` that enforces `@requires` / `@ensures` / `@invariant` on
 * every method call. Applied by `Grammar`'s constructor. When `checkedMode`
 * is disabled, all traps pass through to the target unchanged.
 *
 * Order of assertions (per the reference library):
 *   invariant(before) → requires → body → ensures → invariant(after)
 *
 * `@requires` failure is **graceful**: the method returns `undefined`
 * (the calling `chain`/`.map` produces `empty()`). `@ensures` /
 * `@invariant` failure throws `ContractError`.
 */
export const contractProxyHandler: ProxyHandler<object> = {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    // Only intercept function-valued properties (methods). Non-functions
    // (fields, getters returning data) pass through.
    if (typeof value !== "function") return value;
    // Skip internal/constructor keys.
    if (CONTRACT_SKIP_KEYS.has(prop)) return value;
    // Skip @rule productions — they return Parser<T> and are memoised; the
    // contract system targets semantic actions, not productions.
    if (isProduction(value)) return value;

    // If no contract metadata references this method, no wrapping needed.
    if (!hasContracts(target, prop)) return value;

    // When checked mode is off for this instance, return the raw method.
    if (!checkedModeFor(target)) return value;

    return function (this: object, ...args: unknown[]): unknown {
      // Contracts evaluate against `target` (the unwrapped instance) to
      // avoid Proxy re-entry in predicates/snapshots; the method body runs
      // against `this` (the call-site receiver) to preserve normal JS/TS
      // method semantics under `.call`/`.apply`/`.bind`.
      let pendingError: unknown = null;
      try {
        // invariant(before)
        assertInvariants(target);
        // requires (OR-ed across the chain). If ANY is satisfied, proceed.
        // No preconditions at all → always proceed (vacuously true).
        const requiresOk = withoutChecks(target, () => {
          let anyPred = false;
          for (const p of collectPredicates(target, "requires", prop)) {
            anyPred = true;
            if ((p as RequiresPredicate)(target, ...args)) return true;
          }
          // If no @requires predicates exist, the precondition is vacuously true.
          return !anyPred;
        });
        if (!requiresOk) {
          // graceful failure → caller produces empty(); still check invariant-after
          const invErr = tryInvariants(target);
          if (invErr !== null) throw invErr;
          return undefined;
        }
        // Snapshot `old` before the body for @ensures.
        const old = snapshotOld(target);
        const result = Reflect.apply(value, this, args);
        // ensures (AND-ed across the chain). ALL must hold.
        withoutChecks(target, () => {
          for (const p of collectPredicates(target, "ensures", prop)) {
            if (!(p as EnsuresPredicate)(target, args, old, result)) {
              throw new ContractError(
                violationMessage(target, "Postcondition", prop),
              );
            }
          }
        });
        // invariant(after) on success
        const invErr = tryInvariants(target);
        if (invErr !== null) throw invErr;
        return result;
      } catch (e) {
        pendingError = e;
        // invariant(after) on throw — but the original error wins if the
        // invariant also fails (matches the reference library semantics).
        const invErr = tryInvariants(target);
        if (invErr !== null && pendingError === null) throw invErr;
        throw e;
      }
    };
  },
};

/**
 * Does any class in `target`'s inheritance chain declare a `@requires` or
 * `@ensures` for `prop`? If not, the Proxy `get` trap can skip wrapping.
 */
function hasContracts(target: object, prop: PropertyKey): boolean {
  for (const meta of chainMetadata(target)) {
    if ((meta.requires[prop]?.length ?? 0) > 0) return true;
    if ((meta.ensures[prop]?.length ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Sentinel marker applied by `@rule` to its wrapper functions, so the
 * contract Proxy can recognise and skip productions. Set by `Grammar`'s
 * `@rule` decorator via `_markProduction`.
 */
const PRODUCTION = Symbol.for("@lapis-lang/zipper-grammar/production");

/**
 * Mark a function as a `@rule` production (to be skipped by contract
 * checking). Called by the `@rule` decorator.
 */
export function _markProduction<F extends (...args: unknown[]) => unknown>(
  fn: F,
): F {
  (fn as unknown as Record<symbol, boolean>)[PRODUCTION] = true;
  return fn;
}

/**
 * Is `value` a `@rule` production (marked to skip contract checking)?
 */
function isProduction(value: unknown): boolean {
  return typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[PRODUCTION] === true;
}
