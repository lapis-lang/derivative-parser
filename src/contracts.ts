/**
 * Design-by-contract decorators for grammar semantic actions.
 * See the README for the full introduction.
 *
 * @module
 */

/* ======================================================================
 *  Errors
 * ====================================================================== */

/** Thrown by `assert()` on assertion failure. */
export class AssertionError extends Error {
  constructor(message = "Assertion Error") {
    super(message);
    this.name = "AssertionError";
  }
}

/** Thrown by `@ensures`/`@invariant` on contract violation. */
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
 * Inline assertion; throws `AssertionError` on failure, narrows `c`'s type.
 * Use for bugs, not parse failures (use `@requires` for those).
 */
export function assert(
  condition: unknown,
  message = "Assertion Error",
): asserts condition {
  if (Boolean(condition) === false) {
    throw new AssertionError(message);
  }
}

/** Material implication `!p || q`. */
export function implies(p: boolean, q: boolean): boolean {
  return !p || q;
}

/** Biconditional `(p && q) || (!p && !q)`. */
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

/** Per-instance override for contract checking. */
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

/** Toggle the global default for contract enforcement. Applies live to all instances. */
export function setCheckedMode(enabled: boolean): void {
  globalCheckedMode = enabled;
}

/**
 * Run `fn` with contract checking disabled for `self`.
 * Restores prior state on exit.
 */
function withoutChecks<T>(instance: object, fn: () => T): T {
  const hadOverride = instanceCheckedMode.has(instance);
  const prior = checkedModeFor(instance);
  setCheckedModeFor(instance, false);
  try {
    return fn();
  } finally {
    if (hadOverride) {
      setCheckedModeFor(instance, prior);
    } else {
      // Remove the temporary override so the instance falls back to the
      // global default again (avoiding pinning the global value as a
      // permanent per-instance override).
      instanceCheckedMode.delete(instance);
    }
  }
}

/* ======================================================================
 *  Contract metadata (Symbol.metadata)
 * ====================================================================== */
//
// Subcontracting: @invariant AND-ed, @requires OR-ed, @ensures AND-ed across inheritance.

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
 * Class invariant; checked after construction and after each contracted call.
 * AND-ed across inheritance.
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
 * Precondition; on failure returns `undefined` (graceful → empty forest).
 * OR-ed across inheritance.
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
 * Postcondition `(self, args, old, result) => boolean`; throws `ContractError` on failure.
 * AND-ed across inheritance.
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
 * Parse-failure recovery handler. Invoked when a production yields an empty forest.
 */
export type RescueHandler = (
  self: object,
  failure: ParseFailure,
  args: unknown[],
  retry?: () => unknown,
) => unknown;

/**
 * Parse-failure recovery; most-derived handler wins.
 * Decorator factory for `@rescue` — accepts both getter and method productions.
 */
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
// Proxy dispatches to target, wrapping contracted methods with pre/post checks.

/** Property keys that bypass contract checking (internal helpers, symbols). */
const CONTRACT_SKIP_KEYS = new Set<PropertyKey>([
  "constructor",
  "start", // entry production is a @rule getter; skip
]);

/** Proxy handler enforcing contracts on method calls. */
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
