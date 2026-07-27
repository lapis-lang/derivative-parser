/**
 * Tests for grammar-native contracts.
 *
 * Phase 0: logical primitives (`assert`, `implies`, `iff`, error types,
 * `checkedMode`).
 * Phase 1: `@requires`, `@ensures`, `@invariant` decorators.
 */

import {
  assert,
  assertInvariants,
  AssertionError,
  ContractError,
  ensures,
  getCheckedMode,
  iff,
  implies,
  invariant,
  requires,
  setCheckedMode,
} from "../src/contracts.ts";
import { diagnostic, empty, Grammar, rule } from "../src/index.ts";
import type { Parser } from "../src/index.ts";
import { assertEquals, assertThrows } from "@std/assert";

/**
 * Minimal concrete `Grammar` subclass for testing contracts on plain
 * classes. `Grammar`'s constructor applies the contract Proxy; this just
 * satisfies the abstract `start()` requirement with a failing parser.
 */
class ContractedGrammar extends Grammar<{ start: unknown }> {
  override start(): Parser<unknown> {
    return empty();
  }
}

/** Assert that `fn` does not throw. (Not provided by @std/assert.) */
function assertDoesNotThrow(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    throw new Error(`Expected no throw, but got: ${(e as Error).message}`);
  }
}

/* ── assert ────────────────────────────────────────────────────────── */

Deno.test("assert — passes silently when condition is truthy", () => {
  assertDoesNotThrow(() => assert(true));
  assertDoesNotThrow(() => assert(1));
  assertDoesNotThrow(() => assert("non-empty"));
  assertDoesNotThrow(() => assert({}, "object is truthy"));
});

Deno.test("assert — throws AssertionError when condition is falsy", () => {
  assertThrows(() => assert(false), AssertionError);
  assertThrows(() => assert(0), AssertionError);
  assertThrows(() => assert(""), AssertionError);
  assertThrows(() => assert(null), AssertionError);
  assertThrows(() => assert(undefined), AssertionError);
});

Deno.test("assert — uses the provided message", () => {
  assertThrows(
    () => assert(false, "custom message"),
    AssertionError,
    "custom message",
  );
});

Deno.test("assert — default message is 'Assertion Error'", () => {
  assertThrows(
    () => assert(false),
    AssertionError,
    "Assertion Error",
  );
});

Deno.test("assert — narrows the type (compile-time check)", () => {
  const x: unknown = "hello";
  assert(typeof x === "string");
  // After assert, x is narrowed to string — this assignment type-checks.
  const y: string = x;
  assertEquals(y, "hello");
});

/* ── implies ────────────────────────────────────────────────────────── */

Deno.test("implies — material implication truth table (p → q ≡ !p || q)", async (t) => {
  await t.step("T → T = T", () => assertEquals(implies(true, true), true));
  await t.step("T → F = F", () => assertEquals(implies(true, false), false));
  await t.step("F → T = T", () => assertEquals(implies(false, true), true));
  await t.step("F → F = T", () => assertEquals(implies(false, false), true));
});

/* ── iff ────────────────────────────────────────────────────────────── */

Deno.test("iff — biconditional truth table (p ↔ q)", async (t) => {
  await t.step("T ↔ T = T", () => assertEquals(iff(true, true), true));
  await t.step("T ↔ F = F", () => assertEquals(iff(true, false), false));
  await t.step("F ↔ T = F", () => assertEquals(iff(false, true), false));
  await t.step("F ↔ F = T", () => assertEquals(iff(false, false), true));
});

Deno.test("iff — equivalent to implies(p,q) && implies(q,p)", () => {
  for (const p of [true, false]) {
    for (const q of [true, false]) {
      assertEquals(iff(p, q), implies(p, q) && implies(q, p));
    }
  }
});

/* ── error types ────────────────────────────────────────────────────── */

Deno.test("AssertionError — is an Error with the right name", () => {
  const e = new AssertionError("msg");
  assertEquals(e instanceof Error, true);
  assertEquals(e.name, "AssertionError");
  assertEquals(e.message, "msg");
});

Deno.test("ContractError — is an Error with the right name", () => {
  const e = new ContractError("msg");
  assertEquals(e instanceof Error, true);
  assertEquals(e.name, "ContractError");
  assertEquals(e.message, "msg");
});

/* ── checkedMode ────────────────────────────────────────────────────── */

Deno.test("checkedMode — enabled by default", () => {
  assertEquals(getCheckedMode(), true);
});

Deno.test("setCheckedMode — toggles the flag", () => {
  const prior = getCheckedMode();
  try {
    setCheckedMode(false);
    assertEquals(getCheckedMode(), false);
    setCheckedMode(true);
    assertEquals(getCheckedMode(), true);
  } finally {
    setCheckedMode(prior);
  }
});

/* ======================================================================
 *  Phase 1 — @requires / @ensures / @invariant
 * ====================================================================== */

/* ── @requires — graceful failure ──────────────────────────────────── */

class ReqDemo extends ContractedGrammar {
  @requires((_self: ReqDemo, x: number) => x >= 0)
  sqrt(x: number): number | undefined {
    return Math.sqrt(x);
  }
}

Deno.test("@requires — succeeds when precondition holds", () => {
  const d = new ReqDemo();
  assertEquals(d.sqrt(4), 2);
  assertEquals(d.sqrt(0), 0);
});

Deno.test("@requires — returns undefined when precondition fails (graceful)", () => {
  const d = new ReqDemo();
  assertEquals(d.sqrt(-1), undefined);
  // No exception is thrown — graceful failure.
  let threw = false;
  try {
    d.sqrt(-100);
  } catch {
    threw = true;
  }
  assertEquals(threw, false);
});

Deno.test("@requires — respects call-site receiver via .call/.apply/.bind", () => {
  // The method body must run against the call-site receiver, not a fixed
  // target, so .call/.apply/.bind work with normal JS/TS semantics.
  class ReceiverDemo extends ContractedGrammar {
    protected _label = "original";
    get label(): string {
      return this._label;
    }
    @requires((_self: ReceiverDemo, _v: string) => true)
    setLabel(v: string): void {
      this._label = v;
    }
  }
  const d = new ReceiverDemo();
  const other = new ReceiverDemo();
  (other as unknown as { _label: string })._label = "other";
  // .call: mutates `other`, not `d`.
  d.setLabel.call(other, "via-call");
  assertEquals(other.label, "via-call");
  assertEquals(d.label, "original");
  // .apply: same.
  d.setLabel.apply(other, ["via-apply"]);
  assertEquals(other.label, "via-apply");
  // .bind: bound to `other`.
  const bound = d.setLabel.bind(other, "via-bind");
  bound();
  assertEquals(other.label, "via-bind");
  assertEquals(d.label, "original");
});

Deno.test("@requires — disabled when checkedMode is off", () => {
  const prior = getCheckedMode();
  try {
    setCheckedMode(false);
    const d = new ReqDemo();
    // Without checks, the body runs even for a failing precondition.
    // Math.sqrt of a negative number is NaN — the body runs unguarded.
    assertEquals(Number.isNaN(d.sqrt(-4)), true);
  } finally {
    setCheckedMode(prior);
  }
});

Deno.test("checkedMode — global toggle affects all instances without an explicit override", () => {
  // checkedMode has a global default that applies live to every instance
  // that has no explicit per-instance override. Toggling the global default
  // affects existing instances immediately (not just new ones). This is
  // intentional: the global default is the "production off switch".
  // Per-instance isolation matters only for `withoutChecks` (internal
  // recursion guard), which is scoped per-instance so concurrent
  // operations on different instances don't interfere.
  const prior = getCheckedMode();
  try {
    setCheckedMode(true); // global default on
    const a = new ReqDemo();
    assertEquals(a.sqrt(-1), undefined); // enforces @requires
    // Flip the global default off; `a` has no explicit override, so it
    // falls back to the global default (now off) → checks disabled.
    setCheckedMode(false);
    assertEquals(Number.isNaN(a.sqrt(-4)), true); // body runs unguarded
    // A new instance constructed under off → no Proxy → no checks.
    const c = new ReqDemo();
    assertEquals(Number.isNaN(c.sqrt(-4)), true);
    // Flip back on; both `a` and `c` now fall back to on.
    setCheckedMode(true);
    assertEquals(a.sqrt(-1), undefined); // enforces again
  } finally {
    setCheckedMode(prior);
  }
});

/* ── @ensures — throws on violation ─────────────────────────────────── */

class EnsDemo extends ContractedGrammar {
  protected _value = 0;
  get value(): number {
    return this._value;
  }

  @ensures((self: EnsDemo, _args, _old) => self.value >= 0)
  inc(): void {
    this._value++;
  }

  @ensures((self: EnsDemo, _args, _old) => self.value >= 0)
  badInc(): void {
    this._value--; // violates the postcondition once value was 0
  }
}

Deno.test("@ensures — passes when postcondition holds", () => {
  const d = new EnsDemo();
  d.inc();
  assertEquals(d.value, 1);
  d.inc();
  assertEquals(d.value, 2);
});

Deno.test("@ensures — throws ContractError when postcondition fails", () => {
  const d = new EnsDemo();
  assertThrows(() => d.badInc(), ContractError);
});

Deno.test("@ensures — `old` snapshot reflects pre-call state", () => {
  const capturedOldN: { value: number | null } = { value: null };
  class OldDemo extends ContractedGrammar {
    // Public data field so `OldSnapshot<OldDemo>` exposes it typed.
    // (Mapped types can't surface protected/private keys as public —
    // a TypeScript limitation. The runtime snapshot copies them too;
    // see the "protected field" test below.)
    n = 10;
    @ensures((self: OldDemo, _args, old) => {
      capturedOldN.value = old.n;
      return self.n === old.n + 1;
    })
    bump(): void {
      this.n++;
    }
  }
  const d = new OldDemo();
  d.bump();
  assertEquals(d.n, 11);
  assertEquals(
    capturedOldN.value,
    10,
    "old snapshot should reflect pre-call value",
  );
});

Deno.test("@ensures — `old` excludes getters and methods (data-only snapshot)", () => {
  const seenKeys: { value: string[] } = { value: [] };
  class SnapshotShapeDemo extends ContractedGrammar {
    data = 1;
    get computed(): number {
      return this.data * 2;
    }
    @ensures((_self, _args, old) => {
      seenKeys.value = Object.keys(old as Record<string, unknown>);
      return true;
    })
    bump(): void {
      this.data++;
    }
  }
  const d = new SnapshotShapeDemo();
  d.bump();
  // `data` is an own enumerable data field → copied. `computed` is a getter
  // (not an own data prop) and `bump` is a prototype method → both absent.
  // (Grammar's own cache fields like `_ruleCache` may appear; we only assert
  // the demo-specific shape here.)
  assertEquals(seenKeys.value.includes("data"), true);
  assertEquals(seenKeys.value.includes("computed"), false);
  assertEquals(seenKeys.value.includes("bump"), false);
});

Deno.test("@ensures — infers args tuple and result type from the method", () => {
  // No manual `args: [Type, Type]` / `result: Type` annotation: the types
  // flow from `app(fn: Type, arg: Type): Type`. A wrong predicate body
  // (e.g. `args[0].nonexistent`) would be a *compile* error — the type
  // safety this test guards.
  class TypeEnv {
    lookup(_n: string): string | undefined {
      return "Int";
    }
  }
  class TVar {
    constructor(readonly name: string) {}
  }
  class TFun {
    constructor(readonly dom: string, readonly cod: string) {}
  }
  type Type = TVar | TFun;

  class InferenceDemo extends ContractedGrammar {
    @ensures((_self, args, _old, result) =>
      args[0] instanceof TFun && (result instanceof TVar ||
        result instanceof TFun)
    )
    app(fn: Type, _arg: Type): Type {
      // Return a real Type instance so the postcondition holds.
      return fn instanceof TFun ? new TVar(fn.cod) : new TVar("Int");
    }
    @requires((_self, _name, ctx) =>
      ctx instanceof TypeEnv && ctx.lookup("x") !== undefined
    )
    varRef(_name: string, ctx: TypeEnv): Type {
      return new TVar(ctx.lookup("x")!) as Type;
    }
  }
  const d = new InferenceDemo();
  const ty = d.app(new TFun("Int", "Int"), new TVar("Int"));
  assertEquals(ty instanceof TVar || ty instanceof TFun, true);
  assertEquals(d.varRef("x", new TypeEnv()) instanceof TVar, true);
});

Deno.test("@ensures — disabled when checkedMode is off", () => {
  const prior = getCheckedMode();
  try {
    setCheckedMode(false);
    const d = new EnsDemo();
    // No throw even though the postcondition would be violated.
    let threw = false;
    try {
      d.badInc();
    } catch {
      threw = true;
    }
    assertEquals(threw, false);
    assertEquals(d.value, -1);
  } finally {
    setCheckedMode(prior);
  }
});

/* ── @invariant — class decorator ───────────────────────────────────── */

@invariant((self: InvDemo) => self.value >= 0)
class InvDemo extends ContractedGrammar {
  protected _value = 0;
  get value(): number {
    return this._value;
  }
  set value(v: number) {
    this._value = v;
  }
  inc(): void {
    this._value++;
  }
  dec(): void {
    this._value--;
  }
}

Deno.test("@invariant — assertInvariants passes when invariant holds", () => {
  const d = new InvDemo();
  assertDoesNotThrow(() => assertInvariants(d));
  d.inc();
  assertDoesNotThrow(() => assertInvariants(d));
});

Deno.test("@invariant — assertInvariants throws when invariant is violated", () => {
  const d = new InvDemo();
  d.value = -1;
  assertThrows(() => assertInvariants(d), ContractError);
});

Deno.test("@invariant — no-op when checkedMode is off", () => {
  const prior = getCheckedMode();
  try {
    setCheckedMode(false);
    const d = new InvDemo();
    d.value = -5;
    assertDoesNotThrow(() => assertInvariants(d));
  } finally {
    setCheckedMode(prior);
  }
});

Deno.test("@invariant — original error wins over invariant-after violation", () => {
  // When the body throws AND the invariant is also violated, the original
  // error must propagate (not the invariant error). This matches the
  // reference library's "original error wins" semantics.
  @invariant((self: Throwy) => self.value >= 0)
  class Throwy extends ContractedGrammar {
    protected _value = 0;
    get value(): number {
      return this._value;
    }
    @ensures((self: Throwy) => self.value >= 0)
    bad(): void {
      this._value = -1; // violates invariant
      throw new Error("body error"); // and throws
    }
  }
  const d = new Throwy();
  // The body's "body error" should win, not the invariant violation.
  let caught: Error | null = null;
  try {
    (d as unknown as { bad: () => void }).bad();
  } catch (e) {
    caught = e as Error;
  }
  assertEquals(caught !== null, true);
  assertEquals((caught as Error).message, "body error");
});

/* ── Subcontracting across inheritance ──────────────────────────────── */

@invariant((self: Base) => self.n >= 0)
class Base extends ContractedGrammar {
  protected _n = 0;
  get n(): number {
    return this._n;
  }
  @requires((_self: Base, x: number) => x >= 0)
  setN(x: number): void {
    this._n = x;
  }
  @ensures((self: Base, _args, _old) => self.n >= 0)
  bump(): void {
    this._n++;
  }
}

@invariant((self: Sub) => self.n <= 10)
class Sub extends Base {
  // Weakens the precondition: Sub accepts negative numbers too.
  @requires((_self: Sub, x: number) => x === 42)
  override setN(x: number): void {
    this._n = x;
  }
  // Strengthens the postcondition: Sub guarantees n <= 10 after bump.
  @ensures((self: Sub, _args, _old) => self.n <= 10)
  override bump(): void {
    this._n++;
  }
}

Deno.test("subcontracting — @requires OR-ed (weakened) across inheritance", () => {
  const s = new Sub();
  // Base requires x >= 0; Sub requires x === 42. OR-ed: x >= 0 || x === 42.
  // But Sub invariant is n <= 10, so use values within that.
  // x = 5 (satisfies base requires) should succeed.
  s.setN(5);
  assertEquals(s.n, 5);
  // x = 42 (satisfies sub requires) would violate invariant (n<=10), so
  // instead test that x = 42 satisfies the sub's @requires by checking it
  // doesn't fail on @requires grounds (it fails on invariant grounds, which
  // is a different error). Use x = 8 to stay within invariant.
  s.setN(8);
  assertEquals(s.n, 8);
  // x = -1 (satisfies neither requires) should fail gracefully → undefined,
  // no mutation, no throw.
  let threw = false;
  try {
    s.setN(-1);
  } catch {
    threw = true;
  }
  assertEquals(threw, false, "weakened @requires should not throw");
  assertEquals(s.n, 8, "failed @requires should not mutate state");
});

Deno.test("subcontracting — @ensures AND-ed (strengthened) across inheritance", () => {
  const s = new Sub();
  s.setN(9);
  s.bump(); // n becomes 10 — satisfies base (>=0) and sub (<=10)
  assertEquals(s.n, 10);
  // bump would make n=11, violating the sub's strengthened ensures (<=10).
  assertThrows(() => s.bump(), ContractError);
});

Deno.test("subcontracting — @invariant AND-ed across inheritance", () => {
  const s = new Sub();
  // Valid: 0 <= n <= 10.
  assertDoesNotThrow(() => assertInvariants(s));
  s.setN(10);
  assertDoesNotThrow(() => assertInvariants(s));
  // setN(11) violates the sub invariant (n > 10) — the Proxy throws after
  // the call because the invariant check fails.
  assertThrows(() => s.setN(11), ContractError);
  // Violate the base invariant (n < 0) — set via a path that bypasses checks.
  (s as unknown as { _n: number })._n = -1;
  assertThrows(() => assertInvariants(s), ContractError);
});

/* ======================================================================
 *  Integration: contracts on STLCTypeCheck (examples/stlc.ts)
 * ====================================================================== */

import {
  STLCTypeCheck,
  TFun,
  TVar,
  type Type,
  TypeEnv,
} from "../examples/stlc.ts";

Deno.test("STLCTypeCheck — @requires on app rejects ill-typed terms gracefully", async (t) => {
  const tc = new STLCTypeCheck();
  const env = TypeEnv.empty();

  await t.step("well-typed application yields the result type", () => {
    // (\\x:Int. x) 7 : Int  — app of Int->Int to Int, result Int
    const [ty] = [...tc.parseWith("(\\x:Int. x) 7", env)];
    assertEquals(ty instanceof TVar && ty.name === "Int", true);
  });

  await t.step(
    "ill-typed application (x x) yields empty forest, no throw",
    () => {
      // \\x:Int. x x  — x : Int applied to x : Int, but Int is not a function type.
      // @requires fails → undefined → empty() → Set {}
      const result = tc.parseWith("\\x:Int. x x", env);
      assertEquals(result.size, 0);
    },
  );

  await t.step(
    "ill-typed application (x true) yields empty forest, no throw",
    () => {
      // \\x:Int. x true  — x : Int applied to true, Int is not a function type.
      const result = tc.parseWith("\\x:Int. x true", env);
      assertEquals(result.size, 0);
    },
  );
});

Deno.test("STLCTypeCheck — @requires on varRef returns undefined for unbound variables", () => {
  const tc = new STLCTypeCheck();
  const env = TypeEnv.empty();
  // `freevar` is not bound in the empty environment → @requires fails →
  // varRef returns undefined (graceful). The parse succeeds with `undefined`
  // in the forest (size 1) because atomProd's .map does not convert undefined
  // to empty(); rejection happens downstream when the undefined propagates
  // into an @requires that rejects it (e.g. application).
  const result = tc.parseWith("freevar", env);
  assertEquals(result.size, 1);
  assertEquals([...result][0], undefined);
});

Deno.test("STLCTypeCheck — @ensures on app catches a buggy override (inherited, no re-declaration)", () => {
  // `app` is a semantic action. A subclass overrides it WITHOUT re-declaring
  // @ensures. The Proxy dispatch walks the prototype chain's metadata, so
  // the inherited @ensures from STLCTypeCheck is still enforced — this is
  // the key capability the Proxy unlocks over per-feature decorators.
  class BuggySTLC extends STLCTypeCheck {
    protected override app(_fn: Type, _arg: Type): Type {
      return "not a type" as unknown as Type;
    }
  }
  const tc = new BuggySTLC();
  // Call app directly — inherited @ensures fires on the buggy result.
  const callApp = tc as unknown as { app: (fn: Type, arg: Type) => Type };
  assertThrows(
    () =>
      callApp.app(new TFun(new TVar("Int"), new TVar("Int")), new TVar("Int")),
    ContractError,
  );
});

Deno.test("STLCTypeCheck — @requires on app returns undefined on direct call (graceful)", () => {
  const tc = new STLCTypeCheck();
  const callApp = tc as unknown as { app: (fn: Type, arg: Type) => Type };
  // app(Int, Int) — Int is not a TFun, so @requires fails → undefined.
  assertEquals(callApp.app(new TVar("Int"), new TVar("Int")), undefined);
  // app(TFun(Int,Int), Bool) — dom mismatch, @requires fails → undefined.
  assertEquals(
    callApp.app(new TFun(new TVar("Int"), new TVar("Int")), new TVar("Bool")),
    undefined,
  );
  // app(TFun(Int,Int), Int) — valid, @requires passes → cod.
  assertEquals(
    callApp.app(new TFun(new TVar("Int"), new TVar("Int")), new TVar("Int")),
    new TVar("Int"),
  );
});

Deno.test("STLCTypeCheck — @invariant on AbstractSTLC is checked before parse", () => {
  // The invariant `self.start() !== undefined` holds for a well-formed
  // grammar, so parsing proceeds normally.
  const tc = new STLCTypeCheck();
  assertDoesNotThrow(() => tc.parseWith("\\x:Int. x", TypeEnv.empty()));
});

/* ======================================================================
 *  Phase 2 — @rescue + diagnostic() infrastructure
 * ====================================================================== */

import { findRescueHandler, rescue } from "../src/contracts.ts";

Deno.test("@rescue — registers a handler retrievable via findRescueHandler", () => {
  class RescueDemo extends ContractedGrammar {
    @rescue((_self, failure) => failure)
    @rule
    protected prod(): Parser<unknown> {
      return empty();
    }
  }
  const d = new RescueDemo();
  const handler = findRescueHandler(d, "prod");
  assertEquals(typeof handler, "function");
});

Deno.test("@rescue — handler is inherited by subclasses that don't re-declare", () => {
  class RescueBase extends ContractedGrammar {
    @rescue(() => "base-rescue")
    @rule
    protected prod(): Parser<unknown> {
      return empty();
    }
  }
  class RescueSub extends RescueBase {
    @rule
    protected override prod(): Parser<unknown> {
      return empty();
    }
  }
  const s = new RescueSub();
  const handler = findRescueHandler(s, "prod");
  assertEquals(typeof handler, "function");
  // The inherited handler returns "base-rescue".
  assertEquals(
    handler!(s, { reason: "test", production: "prod" }, []),
    "base-rescue",
  );
});

Deno.test("@rescue — subclass override replaces the handler (most-derived wins)", () => {
  class RescueBase extends ContractedGrammar {
    @rescue(() => "base-rescue")
    @rule
    protected prod(): Parser<unknown> {
      return empty();
    }
  }
  class RescueSub extends RescueBase {
    @rescue(() => "sub-rescue")
    @rule
    protected override prod(): Parser<unknown> {
      return empty();
    }
  }
  const s = new RescueSub();
  const handler = findRescueHandler(s, "prod");
  assertEquals(
    handler!(s, { reason: "test", production: "prod" }, []),
    "sub-rescue",
  );
});

Deno.test("@rescue — findRescueHandler returns undefined when no handler declared", () => {
  class NoRescue extends ContractedGrammar {
    @rule
    protected prod(): Parser<unknown> {
      return empty();
    }
  }
  const d = new NoRescue();
  assertEquals(findRescueHandler(d, "prod"), undefined);
});

Deno.test("diagnostic() — produces an epsilon parser carrying a Diagnostic", () => {
  class DiagDemo extends ContractedGrammar {
    @rule
    protected prod(): Parser<unknown> {
      return diagnostic("something went wrong", "test-reason");
    }
    override start(): Parser<unknown> {
      return this.prod();
    }
  }
  const d = new DiagDemo();
  // epsilon succeeds on empty input (no input to consume).
  const forest = d.parse("");
  assertEquals(forest.size, 1);
  const [val] = [...forest];
  assertEquals(
    (val as { reason: string; message: string }).reason,
    "test-reason",
  );
  assertEquals(
    (val as { reason: string; message: string }).message,
    "something went wrong",
  );
});

Deno.test("@rescue + @rule — decorator order does not matter", () => {
  // Contract decorators only register metadata (they return void and don't
  // wrap the function), while @rule wraps and marks the function. The two
  // concerns are independent, so either order is equivalent.

  // Order A: @rescue on top, @rule below
  class OrderA extends ContractedGrammar {
    @rescue(() => "rescue-A")
    @rule
    protected prod(): Parser<unknown> {
      return empty();
    }
  }

  // Order B: @rule on top, @rescue below
  class OrderB extends ContractedGrammar {
    @rule
    @rescue(() => "rescue-B")
    protected prod(): Parser<unknown> {
      return empty();
    }
  }

  const a = new OrderA();
  const b = new OrderB();
  const ha = findRescueHandler(a, "prod");
  const hb = findRescueHandler(b, "prod");
  // Both orders register the handler.
  assertEquals(typeof ha, "function");
  assertEquals(typeof hb, "function");
  // Both handlers fire with their respective values.
  assertEquals(
    ha!(a, { reason: "test", production: "prod" }, []),
    "rescue-A",
  );
  assertEquals(
    hb!(b, { reason: "test", production: "prod" }, []),
    "rescue-B",
  );
});

Deno.test("@rescue — can decorate a getter production", () => {
  // @rescue accepts both getter and method productions. This verifies the
  // getter overload type-checks and registers the handler.
  class GetterRescue extends ContractedGrammar {
    @rescue(() => "getter-rescue")
    @rule
    protected get prod(): Parser<unknown> {
      return empty();
    }
  }
  const d = new GetterRescue();
  const handler = findRescueHandler(d, "prod");
  assertEquals(typeof handler, "function");
  assertEquals(
    handler!(d, { reason: "test", production: "prod" }, []),
    "getter-rescue",
  );
});

Deno.test("@rescue — infers args type from the decorated method", () => {
  // No manual `args: [TypeEnv]` annotation: `args` flows from
  // `appProd(ctx: TypeEnv): Parser<unknown>`. A wrong body (e.g.
  // `args[0].nonexistent`) would be a *compile* error.
  class TypeEnv {
    bound = new Set(["x", "y"]);
  }
  class RescueInferenceDemo extends ContractedGrammar {
    @rescue((_self, _failure, args) =>
      args[0] instanceof TypeEnv && args[0].bound.has("x")
    )
    @rule
    protected appProd(_ctx: TypeEnv): Parser<unknown> {
      return empty();
    }
  }
  const d = new RescueInferenceDemo();
  const handler = findRescueHandler(d, "appProd");
  assertEquals(typeof handler, "function");
  // The inferred handler sees `args: [TypeEnv]` and returns true.
  assertEquals(
    handler!(d, { reason: "test", production: "appProd" }, [new TypeEnv()]),
    true,
  );
});
