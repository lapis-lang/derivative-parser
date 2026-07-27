/**
 * Tests — circular attribute flow via fixpoint composition (`let rec`).
 *
 * Covers `STLCRecTypeCheck.parseWith`, the `joinType` lattice, and the
 * `parseToFixpoint` integration with a real STLC grammar.
 */

import { assert, assertEquals } from "@std/assert";
import {
  bottomType,
  joinSigma,
  joinType,
  sigmaEq,
  STLCRecTypeCheck,
} from "../examples/stlc-fixpoint.ts";
import { TFun, TVar, TypeEnv, typeEq } from "../examples/stlc.ts";
import type { Type } from "../examples/stlc.ts";

/* ── joinType lattice ───────────────────────────────────────────────── */

Deno.test("joinType — bottom is identity", () => {
  const tInt = new TVar("Int");
  assertEquals(joinType(bottomType, tInt), tInt);
  assertEquals(joinType(tInt, bottomType), tInt);
});

Deno.test("joinType — equal types are idempotent", () => {
  const tInt = new TVar("Int");
  assertEquals(joinType(tInt, tInt), tInt);
  const tFun = new TFun(new TVar("Int"), new TVar("Bool"));
  assertEquals(joinType(tFun, tFun), tFun);
});

Deno.test("joinType — arrows join pointwise", () => {
  const tIntToInt = new TFun(new TVar("Int"), new TVar("Int"));
  const tBottomToInt = new TFun(bottomType, new TVar("Int"));
  const joined = joinType(tIntToInt, tBottomToInt);
  assert(typeEq(joined, new TFun(new TVar("Int"), new TVar("Int"))));
});

Deno.test("joinType — incompatible base types join to Top", () => {
  const tInt = new TVar("Int");
  const tBool = new TVar("Bool");
  const joined = joinType(tInt, tBool);
  assert(typeEq(joined, new TVar("⊤")));
});

/* ── Sigma (joinSigma, sigmaEq) ─────────────────────────────────────── */

Deno.test("joinSigma — pointwise join", () => {
  const a = new Map([["f", bottomType], ["g", new TVar("Int")]]);
  const b = new Map([["f", new TVar("Int")], ["g", new TVar("Int")]]);
  const joined = joinSigma(a, b);
  assert(typeEq(joined.get("f")!, new TVar("Int")));
  assert(typeEq(joined.get("g")!, new TVar("Int")));
});

Deno.test("sigmaEq — structural equality", () => {
  const a = new Map([["f", new TVar("Int")]]);
  const b = new Map([["f", new TVar("Int")]]);
  const c = new Map([["f", new TVar("Bool")]]);
  assert(sigmaEq(a, b));
  assert(!sigmaEq(a, c));
});

/* ── parseWith: let rec type inference ──────────────────────────────── */

Deno.test("parseWith — mutually recursive bindings converge", () => {
  const g = new STLCRecTypeCheck();
  const input = "let rec f:Int -> Int = g and g:Int -> Int = \\y:Int. y in g 7";
  const results = [...g.parseWith(input, TypeEnv.empty())];
  assertEquals(results.length, 1);
  assert(typeEq(results[0] as Type, new TVar("Int")));
});

Deno.test("parseWith — single recursive binding", () => {
  const g = new STLCRecTypeCheck();
  const input = "let rec f:Int -> Int = f in f 7";
  const results = [...g.parseWith(input, TypeEnv.empty())];
  assertEquals(results.length, 1);
  assert(typeEq(results[0] as Type, new TVar("Int")));
});

Deno.test("parseWith — non-let-rec input parses normally", () => {
  const g = new STLCRecTypeCheck();
  const results = [...g.parseWith("\\x:Int. x", TypeEnv.empty())];
  assertEquals(results.length, 1);
  assert(
    typeEq(results[0] as Type, new TFun(new TVar("Int"), new TVar("Int"))),
  );
});

Deno.test("parseWith — body references converged bindings", () => {
  const g = new STLCRecTypeCheck();
  const input =
    "let rec f:Int -> Int = \\x:Int. x and g:Int -> Int = f in f 42";
  const results = [...g.parseWith(input, TypeEnv.empty())];
  assertEquals(results.length, 1);
  assert(typeEq(results[0] as Type, new TVar("Int")));
});
