/**
 * Arithmetic with variables — a warm-up for *semantics as grammar*.
 *
 * This is the surface language of `arith.ts` (numbers, `+`, `*`,
 * parentheses) extended with **identifiers**:
 *
 *   expr  →  add
 *   add   →  add + mul | mul
 *   mul   →  mul * atom | atom
 *   atom  →  ( expr ) | id | digits
 *
 * The new idea — compared with `arith.ts` — is that every production is
 * **parameterised by an environment**:
 *
 *   @rule expr(env: Env): Parser<S["expr"]>
 *
 * `env` is an *inherited attribute*: it flows downward from the grammar's
 * entry point into every sub-term.  This is exactly the pattern the ChatGPT
 * discussion calls "productions as parameterised methods": the production is
 * no longer merely `Input → ParseTree` but `Context × Input → Result`,
 * turning a context-free grammar into a context-sensitive one without any
 * extra machinery.
 *
 * The environment here is *read-only* — it is supplied at the top level and
 * only consulted by variable references.  This keeps the example honest:
 * inherited attributes that depend on *synthesised* results (e.g. evaluating
 * `let x = def in body` needs `def`'s value before parsing `body`) cannot be
 * threaded in a single pass without a monadic bind, so we defer that to the
 * STLC example where the context is extended with *syntactic* annotations
 * (types) that are known before the body is parsed.
 *
 * Two concrete interpretations (the Bracha / initial-algebra pattern from
 * `arith.ts`) are supplied by choosing the shape `S`:
 *
 *   • `ArithVarEval`  ⇒ everything is `number`  — evaluator under `env`.
 *   • `ArithVarAST`   ⇒ everything is `Exp`      — AST builder; `env` is
 *                       threaded but ignored, demonstrating that the *same*
 *                       parameterised grammar supports an interpretation that
 *                       does not use the inherited context.
 *
 * Usage:
 *   const g = new ArithVarEval();
 *   const env = Env.empty().extend("x", 3).extend("y", 4);
 *   const [v] = g.parseWith("x*y + 2", env);   // v === 14
 */

import { Grammar, rule } from "../src/index.ts";
import type { Parser } from "../src/index.ts";

/* ─── Environment ────────────────────────────────────────────────────── */

/**
 * A persistent environment mapping names to values.
 *
 * `lookup` returns `undefined` for unbound names; `extend` returns a *new*
 * environment (structural sharing via a parent link), so the same `env` can be
 * reused across sibling sub-terms without mutation.
 */
export class Env {
  constructor(
    readonly name: string | null,
    readonly value: unknown,
    readonly parent: Env | null,
  ) {}

  static empty(): Env {
    return new Env(null, undefined, null);
  }

  extend(name: string, value: unknown): Env {
    return new Env(name, value, this);
  }

  lookup(name: string): unknown {
    if (this.name === name) return this.value;
    return this.parent?.lookup(name);
  }
}

/* ─── Shape ──────────────────────────────────────────────────────────── */

export interface ArithVarShape {
  [k: string]: unknown;
  expr: unknown;
  term: unknown;
  factor: unknown;
}

/* ─── Abstract grammar ───────────────────────────────────────────────── */

export abstract class AbstractArithVar<S extends ArithVarShape>
  extends Grammar<S> {
  /* semantic actions — subclasses choose representation */
  protected abstract add(l: S["expr"], r: S["term"]): S["expr"];
  protected abstract mul(l: S["term"], r: S["factor"]): S["term"];
  protected abstract num(s: string): S["factor"];
  protected abstract paren(e: S["expr"]): S["factor"];
  /** Reference to a bound identifier, looked up in `env`. */
  protected abstract ref(name: string, env: Env): S["factor"];

  /**
   * Parse `input` under environment `env`.  The environment is the inherited
   * context threaded through every production.
   */
  parseWith(input: string, env: Env): Set<S["expr"]> {
    return this._parseWith(input, this.expr(env));
  }

  override parse(input: string): Set<S["expr"]> {
    return this.parseWith(input, Env.empty());
  }

  /* ── expr (parameterised by env) ─────────────────────────────────── */

  @rule
  expr(env: Env): Parser<S["expr"]> {
    return this.addProd(env);
  }

  /** Production: `add → add + mul | mul` (left-recursive, parameterised). */
  @rule
  protected addProd(env: Env): Parser<S["expr"]> {
    return this.or(
      this.seq(
        this.addProd(env),
        this.ws,
        this.char("+"),
        this.ws,
        this.mulProd(env),
      )
        .map(([l, , , , r]) => this.add(l, r)),
      this.mulProd(env) as Parser<S["expr"]>,
    );
  }

  /** Production: `mul → mul * atom | atom` (left-recursive, parameterised). */
  @rule
  protected mulProd(env: Env): Parser<S["term"]> {
    return this.or(
      this.seq(
        this.mulProd(env),
        this.ws,
        this.char("*"),
        this.ws,
        this.atomProd(env),
      )
        .map(([l, , , , r]) => this.mul(l, r)),
      this.atomProd(env) as Parser<S["term"]>,
    );
  }

  /** Production: `atom → ( expr ) | id | digits` (parameterised). */
  @rule
  protected atomProd(env: Env): Parser<S["factor"]> {
    return this.or(
      this.seq(this.char("("), this.ws, this.expr(env), this.ws, this.char(")"))
        .map(([, , e]) => this.paren(e)),
      this.ident.map((name) => this.ref(name, env)),
      this.digits.map((s) => this.num(s)),
    );
  }

  /* ── lexemes ─────────────────────────────────────────────────────── */

  @rule
  protected get digits(): Parser<string> {
    return this.or(
      this.seq(this.digit, this.digits).map(([d, ds]) => d + ds),
      this.digit,
    );
  }

  protected get digit(): Parser<string> {
    return this.pred((c) => c >= "0" && c <= "9", "<digit>");
  }

  @rule
  protected get ident(): Parser<string> {
    return this.seq(this.identFirst, this.identRest)
      .map(([h, t]) => h + t);
  }

  protected get identFirst(): Parser<string> {
    return this.pred((c) => c >= "a" && c <= "z", "<letter>");
  }

  @rule
  protected get identRest(): Parser<string> {
    return this.or(
      this.seq(this.identChar, this.identRest).map(([c, cs]) => c + cs),
      this.epsilon(""),
    );
  }

  protected get identChar(): Parser<string> {
    return this.pred(
      (c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_",
      "<id-char>",
    );
  }

  protected get wsChar(): Parser<string> {
    return this.pred(
      (c) => c === " " || c === "\t" || c === "\n" || c === "\r",
      "<ws>",
    );
  }

  @rule
  protected get ws(): Parser<string> {
    return this.or(
      this.seq(this.wsChar, this.ws).map(([c, cs]) => c + cs),
      this.epsilon(""),
    );
  }
}

/* ─── Concrete: evaluator (numbers) ─────────────────────────────────── */

export class ArithVarEval
  extends AbstractArithVar<{ expr: number; term: number; factor: number }> {
  override start(): Parser<number> {
    return this.expr(Env.empty());
  }

  protected add(l: number, r: number): number {
    return l + r;
  }
  protected mul(l: number, r: number): number {
    return l * r;
  }
  protected num(s: string): number {
    return Number(s);
  }
  protected paren(e: number): number {
    return e;
  }
  protected ref(name: string, env: Env): number {
    const v = env.lookup(name);
    if (typeof v !== "number") {
      throw new Error(`unbound variable: ${name}`);
    }
    return v;
  }
}

/* ─── Concrete: AST builder ─────────────────────────────────────────── */

export type ArithVarExp =
  | { tag: "num"; value: number }
  | { tag: "var"; name: string }
  | { tag: "add"; left: ArithVarExp; right: ArithVarExp }
  | { tag: "mul"; left: ArithVarExp; right: ArithVarExp };

export class ArithVarAST extends AbstractArithVar<
  { expr: ArithVarExp; term: ArithVarExp; factor: ArithVarExp }
> {
  override start(): Parser<ArithVarExp> {
    return this.expr(Env.empty());
  }

  protected add(l: ArithVarExp, r: ArithVarExp): ArithVarExp {
    return { tag: "add", left: l, right: r };
  }
  protected mul(l: ArithVarExp, r: ArithVarExp): ArithVarExp {
    return { tag: "mul", left: l, right: r };
  }
  protected num(s: string): ArithVarExp {
    return { tag: "num", value: Number(s) };
  }
  protected paren(e: ArithVarExp): ArithVarExp {
    return e;
  }
  /** AST ignores the env — the same parameterised grammar, different algebra. */
  protected ref(name: string, _env: Env): ArithVarExp {
    return { tag: "var", name };
  }
}
