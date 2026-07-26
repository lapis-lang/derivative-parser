/**
 * Tests for semantic examples — demonstrates that inference rules encoded
 * as grammar productions produce correct semantic results.
 */

import { assert, assertEquals } from "@std/assert";
import { ArithVarAST, ArithVarEval, Env } from "../examples/arith-var.ts";
import {
  Closure,
  STLCAST,
  STLCEval,
  STLCTypeCheck,
  STLCTyped,
  type Term,
  TFun,
  TVar,
  TypeEnv,
  typeEq,
  ValEnv,
} from "../examples/stlc.ts";
import {
  type Formula,
  printFormula,
  PropAST,
  PropProof,
  PropTruth,
} from "../examples/proplogic.ts";
import { LambdaEval, UTClosure, UTValEnv } from "../examples/lambda-eval.ts";

/* ── arith-var: inherited attributes (read-only env) ────────────────── */

Deno.test("ArithVarEval — evaluator under environment", async (t) => {
  const g = new ArithVarEval();
  const env = Env.empty().extend("x", 3).extend("y", 4);

  await t.step("evaluates variables", () => {
    assertEquals([...g.parseWith("x", env)], [3]);
    assertEquals([...g.parseWith("y", env)], [4]);
  });
  await t.step("evaluates arithmetic with variables", () => {
    assertEquals([...g.parseWith("x*y + 2", env)], [14]);
    assertEquals([...g.parseWith("(x+1)*y", env)], [16]);
    assertEquals([...g.parseWith("x*x + y*y", env)], [25]);
  });
  await t.step("evaluates pure arithmetic", () => {
    assertEquals([...g.parseWith("42", env)], [42]);
  });
});

Deno.test("ArithVarAST — AST builder (env ignored)", () => {
  const g = new ArithVarAST();
  const env = Env.empty().extend("x", 3);
  const [ast] = [...g.parseWith("x*y + 2", env)];
  assertEquals(ast, {
    tag: "add",
    left: {
      tag: "mul",
      left: { tag: "var", name: "x" },
      right: { tag: "var", name: "y" },
    },
    right: { tag: "num", value: 2 },
  });
});

/* ── stlc: one-pass type checking via chain ─────────────────────────── */

Deno.test("STLCAST — syntax builder", async (t) => {
  const g = new STLCAST();
  await t.step("parses lambda", () => {
    const [ast] = [...g.parse("\\x:Int. x")];
    assertEquals((ast as Term).print(), "(λx:Int. x)");
  });
  await t.step("parses let", () => {
    const [ast] = [...g.parse("let f : Int -> Int = \\x:Int. x in f 7")];
    assertEquals(
      (ast as Term).print(),
      "(let f:(Int → Int) = (λx:Int. x) in (f 7))",
    );
  });
  await t.step("parses application", () => {
    const [ast] = [...g.parse("(\\x:Int -> Int. x) (\\y:Int. y)")];
    assertEquals((ast as Term).print(), "((λx:(Int → Int). x) (λy:Int. y))");
  });
});

Deno.test("STLCTypeCheck — one-pass typing judgment", async (t) => {
  const tc = new STLCTypeCheck();
  const empty = TypeEnv.empty();

  await t.step("λx:Int. x : Int → Int", () => {
    const [ty] = [...tc.parseWith("\\x:Int. x", empty)];
    assertEquals(ty, new TFun(new TVar("Int"), new TVar("Int")));
  });
  await t.step("λx:Int. λy:Bool. x : Int → (Bool → Int)", () => {
    const [ty] = [...tc.parseWith("\\x:Int. \\y:Bool. x", empty)];
    assertEquals(
      ty,
      new TFun(new TVar("Int"), new TFun(new TVar("Bool"), new TVar("Int"))),
    );
  });
  await t.step("(\\x:Int -> Int. x) (\\y:Int. y) : Int → Int", () => {
    const [ty] = [...tc.parseWith("(\\x:Int -> Int. x) (\\y:Int. y)", empty)];
    assertEquals(ty, new TFun(new TVar("Int"), new TVar("Int")));
  });
  await t.step("let f : Int -> Int = \\x:Int. x in f 7 : Int", () => {
    const [ty] = [
      ...tc.parseWith("let f : Int -> Int = \\x:Int. x in f 7", empty),
    ];
    assertEquals(ty, new TVar("Int"));
  });
  await t.step("ill-typed: \\x:Int. x x is rejected", () => {
    const results = [...tc.parseWith("\\x:Int. x x", empty)];
    assertEquals(results.length, 0);
  });
  await t.step("ill-typed: \\x:Int. x true is rejected", () => {
    const results = [...tc.parseWith("\\x:Int. x true", empty)];
    assertEquals(results.length, 0);
  });
});

Deno.test("STLCEval — tree-consuming grammar evaluation", async (t) => {
  const ev = new STLCEval();
  const empty = ValEnv.empty();

  await t.step("let f = \\x:Int. x in f 7 ⇓ 7", () => {
    const [v] = [
      ...ev.parseWith("let f : Int -> Int = \\x:Int. x in f 7", empty),
    ];
    assertEquals(v, 7);
  });
  await t.step("(\\x:Int. x) 42 ⇓ 42", () => {
    const [v] = [...ev.parseWith("(\\x:Int. x) 42", empty)];
    assertEquals(v, 42);
  });
  await t.step("true evaluates to true", () => {
    const [v] = [...ev.parseWith("true", empty)];
    assertEquals(v, true);
  });
  // Higher-order attribute cases — the closure body is re-parsed under an
  // extended env via a nested tree-parse (the HOAG mechanism).
  await t.step("(\\x:Int -> Int. x) (\\y:Int. y) ⇓ closure y", () => {
    const [v] = [...ev.parseWith("(\\x:Int -> Int. x) (\\y:Int. y)", empty)];
    assert(v instanceof Closure);
    assertEquals(v.param, "y");
  });
  await t.step(
    "currying: (\\x:Int -> Int. \\y:Int. x) (\\z:Int. z) 99 ⇓ closure z",
    () => {
      const [v] = [
        ...ev.parseWith("(\\x:Int -> Int. \\y:Int. x) (\\z:Int. z) 99", empty),
      ];
      assert(v instanceof Closure);
      assertEquals(v.param, "z");
    },
  );
  await t.step(
    "sharing: let f = \\x:Int. x in let g = f in g (f 3) ⇓ 3",
    () => {
      const [v] = [
        ...ev.parseWith(
          "let f : Int -> Int = \\x:Int. x in let g : Int -> Int = f in g (f 3)",
          empty,
        ),
      ];
      assertEquals(v, 3);
    },
  );
  await t.step("nested app: (\\x:Int. x) ((\\y:Int. y) 42) ⇓ 42", () => {
    const [v] = [...ev.parseWith("(\\x:Int. x) ((\\y:Int. y) 42)", empty)];
    assertEquals(v, 42);
  });
});

Deno.test("STLCTyped — proof-bearing type checker", async (t) => {
  const tt = new STLCTyped();
  const empty = TypeEnv.empty();

  await t.step("λx:Int. x yields TypedLam with type Int → Int", () => {
    const [result] = [...tt.parseWith("\\x:Int. x", empty)];
    assertEquals(
      typeEq(result.type, new TFun(new TVar("Int"), new TVar("Int"))),
      true,
    );
  });
  await t.step("ill-typed term rejected", () => {
    const results = [...tt.parseWith("\\x:Int. x x", empty)];
    assertEquals(results.length, 0);
  });
});

/* ── proplogic: truth evaluation + proof building ────────────────────── */

Deno.test("PropAST — formula builder", async (t) => {
  const g = new PropAST();
  await t.step("parses implication", () => {
    const [f] = [...g.parse("p → p")];
    assertEquals(printFormula(f), "(p → p)");
  });
  await t.step("parses complex formula", () => {
    const [f] = [...g.parse("p ∨ q → r")];
    assertEquals(printFormula(f), "((p ∨ q) → r)");
  });
});

Deno.test("PropTruth — truth-table evaluator", async (t) => {
  const truth = new PropTruth();
  const alpha = { p: true, q: false, r: true };

  await t.step("p → p is true", () => {
    const [v] = [...truth.parseWith("p → p", alpha)];
    assertEquals(v, true);
  });
  await t.step("p ∧ ¬p is false", () => {
    const [v] = [...truth.parseWith("p ∧ ¬p", alpha)];
    assertEquals(v, false);
  });
  await t.step("⊤ is true", () => {
    const [v] = [...truth.parseWith("⊤", alpha)];
    assertEquals(v, true);
  });
  await t.step("⊥ is false", () => {
    const [v] = [...truth.parseWith("⊥", alpha)];
    assertEquals(v, false);
  });
  await t.step("unbound variable returns empty set (does not throw)", () => {
    const empty: Record<string, boolean> = {};
    const results = [...truth.parseWith("p", empty)];
    assertEquals(results.length, 0);
  });
  await t.step("unbound variable in compound formula returns empty set", () => {
    const empty: Record<string, boolean> = {};
    const results = [...truth.parseWith("p ∧ q", empty)];
    assertEquals(results.length, 0);
  });
});

Deno.test("PropProof — natural-deduction proofs", async (t) => {
  const pr = new PropProof();
  const empty = new Set<Formula>();

  await t.step("p → p is provable", () => {
    const results = [...pr.parseWith("p → p", empty)];
    assertEquals(results.length, 1);
    assertEquals(results[0]!.tag, "impIntro");
  });
  await t.step("p → (p ∧ p) is provable", () => {
    const results = [...pr.parseWith("p → (p ∧ p)", empty)];
    assertEquals(results.length, 1);
  });
  await t.step("⊤ is provable", () => {
    const results = [...pr.parseWith("⊤", empty)];
    assertEquals(results.length, 1);
    assertEquals(results[0]!.tag, "topIntro");
  });
  await t.step("p alone is NOT provable (no assumptions)", () => {
    const results = [...pr.parseWith("p", empty)];
    assertEquals(results.length, 0);
  });
});

/* ── lambda-eval: untyped evaluation ─────────────────────────────────── */

Deno.test("LambdaEval — untyped evaluation", async (t) => {
  const g = new LambdaEval();
  const empty = UTValEnv.empty();

  await t.step("\\x.x evaluates to a closure", () => {
    const [v] = [...g.parseWith("\\x.x", empty)];
    assert(v instanceof UTClosure);
    assertEquals(v.param, "x");
  });
  await t.step("let id = \\x.x in id id evaluates to a closure", () => {
    const [v] = [...g.parseWith("let id = \\x.x in id id", empty)];
    assert(v instanceof UTClosure);
    assertEquals(v.param, "x");
  });
  await t.step("(\\x.\\y.x) (\\z.z) (\\w.w) evaluates to \\z.z", () => {
    const [v] = [...g.parseWith("(\\x.\\y.x) (\\z.z) (\\w.w)", empty)];
    assert(v instanceof UTClosure);
    assertEquals(v.param, "z");
  });
});
