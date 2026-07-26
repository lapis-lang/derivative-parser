/**
 * Untyped lambda calculus — AST builder + call-by-value evaluator.
 * The evaluator is a tree-consuming grammar (no separate recursive function).
 */

import { Grammar, rule } from "../src/index.ts";
import {
  char,
  empty,
  epsilon,
  flattenTree,
  ident as identLexeme,
  literal,
  or,
  parserOf,
  seq,
  TreeExp,
  ws as wsLexeme,
  ws1 as ws1Lexeme,
} from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ─── AST ────────────────────────────────────────────────────────────── */

export abstract class UTTerm {
  abstract print(): string;
}

export class UTVar extends UTTerm {
  constructor(readonly name: string) {
    super();
  }
  override print(): string {
    return this.name;
  }
}

export class UTLam extends UTTerm {
  constructor(readonly param: string, readonly body: UTTerm) {
    super();
  }
  override print(): string {
    return `(λ${this.param}.${this.body.print()})`;
  }
}

export class UTApp extends UTTerm {
  constructor(readonly fn: UTTerm, readonly arg: UTTerm) {
    super();
  }
  override print(): string {
    return `(${this.fn.print()} ${this.arg.print()})`;
  }
}

export class UTLet extends UTTerm {
  constructor(
    readonly name: string,
    readonly def: UTTerm,
    readonly body: UTTerm,
  ) {
    super();
  }
  override print(): string {
    return `(let ${this.name} = ${this.def.print()} in ${this.body.print()})`;
  }
}

/* ─── Values ─────────────────────────────────────────────────────────── */

export type UTValue = UTClosure | number | boolean;

export class UTClosure {
  constructor(
    readonly param: string,
    readonly body: UTTerm,
    readonly env: UTValEnv,
  ) {}
}

/* ─── Environments ───────────────────────────────────────────────────── */

export class UTValEnv {
  private constructor(
    readonly name: string | null,
    readonly value: UTValue | null,
    readonly parent: UTValEnv | null,
  ) {}

  static empty(): UTValEnv {
    return new UTValEnv(null, null, null);
  }

  extend(name: string, value: UTValue): UTValEnv {
    return new UTValEnv(name, value, this);
  }

  lookup(name: string): UTValue | undefined {
    if (this.name === name) return this.value ?? undefined;
    return this.parent?.lookup(name);
  }
}

/* ─── Shape & abstract grammar ───────────────────────────────────────── */

export interface LambdaShape {
  [k: string]: unknown;
  expr: unknown;
  atom: unknown;
}

export abstract class AbstractLambda<S extends LambdaShape> extends Grammar<S> {
  protected abstract lam(param: string, body: S["expr"]): S["expr"];
  protected abstract app(fn: S["atom"], arg: S["atom"]): S["expr"];
  protected abstract let_(
    name: string,
    def: S["expr"],
    body: S["expr"],
  ): S["expr"];
  protected abstract varRef(name: string): S["atom"];
  protected abstract paren(e: S["expr"]): S["atom"];

  override start(): Parser<S["expr"]> {
    return this.exprProd;
  }

  @rule
  get exprProd(): Parser<S["expr"]> {
    return or(this.letProd, this.lambdaProd, this.appProd);
  }

  @rule
  protected get letProd(): Parser<S["expr"]> {
    // `ws1` is used explicitly where at least one space is required (after
    // keywords, before the body); `ws` (zero-or-more) suffices elsewhere.
    return seq(
      literal("let"),
      this.ws1,
      this.ident,
      this.ws,
      char("="),
      this.ws,
      this.exprProd,
      this.ws1,
      literal("in"),
      this.ws1,
      this.exprProd,
    ).map(([, , name, , , , def, , , , body]) => this.let_(name, def, body));
  }

  @rule
  protected get lambdaProd(): Parser<S["expr"]> {
    // `sseq` auto-inserts `ws` (zero-or-more) between terms — no manual
    // `this.ws` threading needed between the head, param, dot, and body.
    return this.sseq(
      this.lambdaHead,
      this.ident,
      char("."),
      this.exprProd,
    ).map(([, param, , body]) => this.lam(param, body));
  }

  @rule
  protected get appProd(): Parser<S["expr"]> {
    return or(
      seq(this.appProd, this.ws1, this.atomProd)
        .map(([fn, , arg]) => this.app(fn, arg)),
      this.atomProd as Parser<S["expr"]>,
    );
  }

  @rule
  protected get atomProd(): Parser<S["atom"]> {
    // `sseq` auto-inserts `ws` between terms — no manual `this.ws` threading.
    return or(
      this.sseq(char("("), this.exprProd, char(")"))
        .map(([, e]) => this.paren(e)),
      this.ident.map((name) => this.varRef(name)),
    );
  }

  /* ── lexemes ─────────────────────────────────────────────────────── */
  //
  // `ident`, `ws`, and `ws1` come from the shared lexeme library
  // (`src/lexemes.ts`). The reserved-word guard for `let`/`in` is handled
  // inline via `.chain()` below.

  @rule
  protected get ident(): Parser<string> {
    return identLexeme().chain((name) => {
      if (name === "let" || name === "in") return empty<string>();
      return epsilon(name);
    }).map(([, name]) => name);
  }

  protected get lambdaHead(): Parser<string> {
    return or(char("λ"), char("\\"));
  }

  @rule
  protected override get ws(): Parser<string> {
    return wsLexeme();
  }

  @rule
  protected get ws1(): Parser<string> {
    return ws1Lexeme();
  }
}

/* ─── Concrete: AST builder ──────────────────────────────────────────── */

export class LambdaAST extends AbstractLambda<{ expr: UTTerm; atom: UTTerm }> {
  protected lam(param: string, body: UTTerm): UTTerm {
    return new UTLam(param, body);
  }
  protected app(fn: UTTerm, arg: UTTerm): UTTerm {
    return new UTApp(fn, arg);
  }
  protected let_(name: string, def: UTTerm, body: UTTerm): UTTerm {
    return new UTLet(name, def, body);
  }
  protected varRef(name: string): UTTerm {
    return new UTVar(name);
  }
  protected paren(e: UTTerm): UTTerm {
    return e;
  }
}

/* ─── Evaluator (tree-consuming grammar) ─────────────────────────────── */

/** Children extractor for {@link UTTerm} trees, used by {@link LambdaEval}. */
function utTermChildren(node: unknown, tag: string): readonly unknown[] {
  switch (tag) {
    case "UTVar":
      return [];
    case "UTLam":
      return [(node as UTLam).body];
    case "UTApp":
      return [(node as UTApp).fn, (node as UTApp).arg];
    case "UTLet":
      return [(node as UTLet).def, (node as UTLet).body];
    default:
      return [];
  }
}

/**
 * Evaluator as a **tree-consuming grammar**.  Instead of extending
 * `LambdaAST` and bolting on a recursive `lambdaEval`, this is a grammar
 * whose input is a flattened {@link UTTerm} tree and whose semantic actions
 * are the evaluation rules `ρ ⊢ e ⇓ v`.  Each production is a {@link TreeExp}
 * matching a `UTTerm` node by class name; the inherited context `ρ`
 * (`UTValEnv`) is threaded via the parameterised `@rule` method `evalExpr(env)`.
 *
 * The higher-order step — applying a closure to an argument — is a nested
 * tree-parse: `app` re-parses the closure's body subtree under the extended
 * environment.  Per-pass memo isolation (Layer 0) makes the nested re-entry
 * safe.
 */
export class LambdaEval extends Grammar<{ expr: UTValue }> {
  /** Parse source to AST (via `LambdaAST`), then evaluate each AST as a tree. */
  parseWith(input: string, env: UTValEnv): Set<UTValue> {
    const asts = [...new LambdaAST().parse(input)] as UTTerm[];
    const results = new Set<UTValue>();
    for (const ast of asts) {
      try {
        const toks = flattenTree(ast, utTermChildren);
        for (const v of this._parseTreeWith(toks, this.evalExpr(env))) {
          results.add(v);
        }
      } catch {
        // stuck term — skip
      }
    }
    return results;
  }

  override start(): Parser<UTValue> {
    return this.evalExpr(UTValEnv.empty());
  }

  /** `ρ ⊢ e ⇓ v` — the evaluation judgment, parameterised by the value env. */
  @rule
  evalExpr(env: UTValEnv): Parser<UTValue> {
    return or(
      this.evalVar(env),
      this.evalLam(env),
      this.evalApp(env),
      this.evalLet(env),
    );
  }

  /** Var: `ρ ⊢ x ⇓ ρ(x)`. */
  protected evalVar(env: UTValEnv): Parser<UTValue> {
    return parserOf<UTValue>(
      new TreeExp("UTVar", [], (node: unknown) => {
        const v = env.lookup((node as UTVar).name);
        if (v === undefined) throw new Error(`unbound variable`);
        return v;
      }),
    );
  }

  /** Lam: `ρ ⊢ λx. body ⇓ ⟨x, body, ρ⟩` (capture the body unevaluated). */
  protected evalLam(env: UTValEnv): Parser<UTValue> {
    return parserOf<UTValue>(
      new TreeExp(
        "UTLam",
        [],
        (node: unknown) =>
          new UTClosure((node as UTLam).param, (node as UTLam).body, env),
      ),
    );
  }

  /**
   * App: `ρ ⊢ e₁ e₂ ⇓ v` where `ρ ⊢ e₁ ⇓ ⟨x,body,ρ'⟩`, `ρ ⊢ e₂ ⇓ v₂`,
   * and `ρ' ⊢ body[x:=v₂] ⇓ v`.  The body re-evaluation is a nested
   * tree-parse over the closure's body subtree — the higher-order attribute.
   */
  protected evalApp(env: UTValEnv): Parser<UTValue> {
    return parserOf<UTValue>(
      new TreeExp(
        "UTApp",
        [this.evalExpr(env)._exp, this.evalExpr(env)._exp],
        (_node: unknown, [fnVal, argVal]: unknown[]) => {
          if (!(fnVal instanceof UTClosure)) {
            throw new Error(`cannot apply non-function`);
          }
          const bodyEnv = fnVal.env.extend(fnVal.param, argVal as UTValue);
          const bodyToks = flattenTree(fnVal.body, utTermChildren);
          const results = [
            ...this._parseTreeWith(bodyToks, this.evalExpr(bodyEnv)),
          ];
          if (results.length === 0) throw new Error(`stuck application`);
          return results[0]!;
        },
      ),
    );
  }

  /** Let: `ρ ⊢ let x = def in body ⇓ v` where `ρ ⊢ def ⇓ v₁`, `ρ ⊢ body[x:=v₁] ⇓ v`. */
  protected evalLet(env: UTValEnv): Parser<UTValue> {
    return parserOf<UTValue>(
      new TreeExp(
        "UTLet",
        [this.evalExpr(env)._exp],
        (node: unknown, [defVal]: unknown[]) => {
          const bodyEnv = env.extend((node as UTLet).name, defVal as UTValue);
          const bodyToks = flattenTree((node as UTLet).body, utTermChildren);
          const results = [
            ...this._parseTreeWith(bodyToks, this.evalExpr(bodyEnv)),
          ];
          if (results.length === 0) throw new Error(`stuck let`);
          return results[0]!;
        },
      ),
    );
  }
}
