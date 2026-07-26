/**
 * Untyped lambda calculus — AST builder + one-pass evaluator.
 * The evaluator is a grammar subclass (like the type checker), with no
 * separate recursive function.
 */

import { Grammar, rule } from "../src/index.ts";
import {
  char,
  empty,
  epsilon,
  ident as identLexeme,
  literal,
  or,
  seq,
  ws as wsLexeme,
  ws1 as ws1Lexeme,
} from "../src/index.ts";
import type { Parser, Span } from "../src/index.ts";

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

/** Sentinel placeholder for span-capture parses (must be non-null; see ValEnv.lookup). A unique symbol avoids confusion with real values. */
const UT_PLACEHOLDER = Symbol("UT_PLACEHOLDER") as unknown as UTValue;

/**
 * A closure capturing the body's **input span** (not a pre-evaluated body).
 * The body is re-evaluated on demand by re-parsing its source substring under
 * the extended environment — the higher-order attribute mechanism for
 * one-pass evaluation.
 */
export class UTClosure {
  constructor(
    readonly param: string,
    readonly bodySpan: Span,
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

/**
 * Base lambda grammar — productions, lexemes, and context threading.
 *
 * The semantic-action methods (`lam`, `app`, `let_`, `varRef`, `paren`) have
 * **throwing default implementations**. They are reachable only via the base
 * `lambdaProd`/`letProd`/`appProd`/`atomProd` productions. Subclasses that
 * **override productions** (like `LambdaEval`) extend this class directly and
 * never call the actions. Subclasses that **override actions** (like
 * `LambdaAST`) extend {@link AbstractLambdaActions}, which re-declares the
 * actions as abstract for compile-time safety.
 */
export abstract class AbstractLambda<S extends LambdaShape> extends Grammar<S> {
  /* ── semantic actions (throwing defaults — overridden by action subclasses) ── */

  protected lam(_param: string, _body: S["expr"]): S["expr"] {
    throw new Error(
      "lam() unreachable — override the action or the production",
    );
  }
  protected app(_fn: S["atom"], _arg: S["atom"]): S["expr"] {
    throw new Error(
      "app() unreachable — override the action or the production",
    );
  }
  protected let_(
    _name: string,
    _def: S["expr"],
    _body: S["expr"],
  ): S["expr"] {
    throw new Error(
      "let_() unreachable — override the action or the production",
    );
  }
  protected varRef(_name: string, _ctx: unknown): S["atom"] {
    throw new Error(
      "varRef() unreachable — override the action or the production",
    );
  }
  protected paren(_e: S["expr"]): S["atom"] {
    throw new Error(
      "paren() unreachable — override the action or the production",
    );
  }

  /** Context extension hook — default no-op (for `LambdaAST`). Semantic subclasses override. */
  protected extendCtx(ctx: unknown, _name: string): unknown {
    return ctx;
  }

  @rule
  exprProd(ctx: unknown): Parser<S["expr"]> {
    return or(this.letProd(ctx), this.lambdaProd(ctx), this.appProd(ctx));
  }

  @rule
  protected letProd(ctx: unknown): Parser<S["expr"]> {
    return seq(
      literal("let"),
      this.ws1,
      this.ident,
      this.ws,
      char("="),
      this.ws,
    ).chain(([, , name]) =>
      // Parse def under outer ctx.
      this.exprProd(ctx)
        .map((def) => ({ name, def }))
        .chain(({ name, def }) =>
          seq(this.ws1, literal("in"), this.ws1)
            .chain(() =>
              this.exprProd(this.extendCtx(ctx, name))
                .map((body) => this.let_(name, def, body))
            )
            .map(([, result]) => result)
        )
        .map(([, result]) => result)
    ).map(([, result]) => result);
  }

  @rule
  protected lambdaProd(ctx: unknown): Parser<S["expr"]> {
    return this.sseq(
      this.lambdaHead,
      this.ident,
      char("."),
    ).chain(([, param]) =>
      this.exprProd(this.extendCtx(ctx, param))
        .map((body) => this.lam(param, body))
    );
  }

  @rule
  protected appProd(ctx: unknown): Parser<S["expr"]> {
    return or(
      seq(this.appProd(ctx), this.ws1, this.atomProd(ctx))
        .map(([fn, , arg]) => this.app(fn, arg)),
      this.atomProd(ctx) as Parser<S["expr"]>,
    );
  }

  @rule
  protected atomProd(ctx: unknown): Parser<S["atom"]> {
    // `sseq` auto-inserts `ws` between terms — no manual `this.ws` threading.
    return or(
      this.sseq(char("("), this.exprProd(ctx), char(")"))
        .map(([, e]) => this.paren(e)),
      this.ident.map((name) => this.varRef(name, ctx)),
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

/**
 * Action layer — re-declares the semantic actions as abstract for
 * compile-time safety. Subclasses that **override actions** (not
 * productions) extend this class: `LambdaAST`. They must implement every
 * action, and the base productions call them.
 *
 * Subclasses that **override productions** (like `LambdaEval`) extend
 * {@link AbstractLambda} directly, bypassing the actions entirely.
 */
export abstract class AbstractLambdaActions<S extends LambdaShape>
  extends AbstractLambda<S> {
  protected abstract override lam(param: string, body: S["expr"]): S["expr"];
  protected abstract override app(fn: S["atom"], arg: S["atom"]): S["expr"];
  protected abstract override let_(
    name: string,
    def: S["expr"],
    body: S["expr"],
  ): S["expr"];
  protected abstract override varRef(name: string, ctx: unknown): S["atom"];
  protected abstract override paren(e: S["expr"]): S["atom"];
}

/* ─── Concrete: AST builder ──────────────────────────────────────────── */

export class LambdaAST
  extends AbstractLambdaActions<{ expr: UTTerm; atom: UTTerm }> {
  override start(): Parser<UTTerm> {
    return this.exprProd(null);
  }

  protected lam(param: string, body: UTTerm): UTTerm {
    return new UTLam(param, body);
  }
  protected app(fn: UTTerm, arg: UTTerm): UTTerm {
    return new UTApp(fn, arg);
  }
  protected let_(name: string, def: UTTerm, body: UTTerm): UTTerm {
    return new UTLet(name, def, body);
  }
  protected varRef(name: string, _ctx: unknown): UTTerm {
    return new UTVar(name);
  }
  protected paren(e: UTTerm): UTTerm {
    return e;
  }
}

/* ─── Evaluator (one-pass grammar) ───────────────────────────────────── */

/**
 * One-pass evaluator — the same shape as the AST builder but with overridden
 * semantic actions. Extends `AbstractLambda` directly; no intermediate AST,
 * no separate recursive function. The evaluation judgment `ρ ⊢ e ⇓ v` is a
 * parameterised production, with `ρ` (`UTValEnv`) threaded as inherited
 * context via `chain`.
 *
 * The higher-order step — applying a closure to an argument — is realised
 * by capturing the body's **input span** in the closure and re-parsing that
 * substring under the extended environment via `_forward`. Per-pass memo
 * isolation makes the nested re-entry safe.
 */
export class LambdaEval
  extends AbstractLambda<{ expr: UTValue; atom: UTValue }> {
  private _input: string = "";
  private _inputOffset: number = 0;

  parseWith(input: string, env: UTValEnv): Set<UTValue> {
    this._input = input;
    this._inputOffset = 0;
    return this._parseWith(input, this.exprProd(env));
  }

  override start(): Parser<UTValue> {
    return this.exprProd(UTValEnv.empty());
  }

  protected override extendCtx(ctx: unknown, name: string): unknown {
    // Bind name to a placeholder so the body parses (span capture only).
    return (ctx as UTValEnv).extend(name, UT_PLACEHOLDER);
  }

  protected override app(fn: UTValue, arg: UTValue): UTValue {
    if (!(fn instanceof UTClosure)) {
      throw new Error(`cannot apply non-function`);
    }
    const bodyEnv = fn.env.extend(fn.param, arg);
    const savedOffset = this._inputOffset;
    this._inputOffset = fn.bodySpan.start;
    try {
      const results = [...this._forward(
        this._input,
        fn.bodySpan,
        this.exprProd(bodyEnv),
      )];
      if (results.length === 0) throw new Error(`stuck application`);
      return results[0]!;
    } finally {
      this._inputOffset = savedOffset;
    }
  }

  protected override varRef(name: string, ctx: unknown): UTValue {
    const v = (ctx as UTValEnv).lookup(name);
    if (v === undefined) throw new Error(`unbound variable: ${name}`);
    return v;
  }

  protected override paren(e: UTValue): UTValue {
    return e;
  }

  /** Override `lambdaProd` to capture the body's span in a closure. */
  @rule
  protected override lambdaProd(ctx: unknown): Parser<UTValue> {
    return this.sseq(
      this.lambdaHead,
      this.ident,
      char("."),
    ).chain(([, param]) => {
      const placeholderCtx = this.extendCtx(ctx, param);
      return this.exprProd(placeholderCtx)
        .map((_body, span) =>
          new UTClosure(
            param,
            {
              start: span.start + this._inputOffset,
              end: span.end + this._inputOffset,
            },
            ctx as UTValEnv,
          )
        );
    }).map(([, result]) => result);
  }

  /** Override `letProd` to parse the body under the real env (with def's value). */
  @rule
  protected override letProd(ctx: unknown): Parser<UTValue> {
    return seq(
      literal("let"),
      this.ws1,
      this.ident,
      this.ws,
      char("="),
      this.ws,
    ).chain(([, , name]) =>
      this.exprProd(ctx)
        .map((def) => ({ name, def }))
        .chain(({ name, def }) =>
          seq(this.ws1, literal("in"), this.ws1)
            .chain(() => {
              const bodyCtx = (ctx as UTValEnv).extend(name, def);
              return this.exprProd(bodyCtx)
                .map((body) => body);
            })
            .map(([, result]) => result)
        )
        .map(([, result]) => result)
    ).map(([, result]) => result);
  }
}
