/**
 * Circular attribute flow — `let rec` type inference via fixpoint composition.
 *
 * Extends `STLCTypeCheck` with a `let rec` construct whose mutually recursive
 * bindings are resolved via `parseToFixpoint`. The fixpoint is a higher-order
 * attribute: the `letRecProd` production captures each binding body's source
 * span (like `STLCEval` captures `Closure.bodySpan`), then a `chain` callback
 * runs `parseToFixpoint` to iterate the body types until stable, and finally
 * parses the `in body` under the converged context.
 *
 * See `examples/stlc-fixpoint-demo.ts` for a runnable demonstration.
 */

import { rule } from "../src/index.ts";
import { char, epsilon, literal, or, seq } from "../src/index.ts";
import type { Parser, Span } from "../src/index.ts";
import { assert } from "../src/index.ts";
import {
  STLCTypeCheck,
  TFun,
  TVar,
  type Type,
  TypeEnv,
  typeEq,
} from "./stlc.ts";

/* ── Type lattice: join, bottom, top ─────────────────────────────────── */

/** The bottom type (⊥) — placeholder for unknown types during fixpoint iteration. */
export const bottomType: Type = new TVar("⊥");

/** The top type (⊤) — join of incompatible types. */
export const topType: Type = new TVar("⊤");

/**
 * Lattice join on `Type`: least upper bound.
 *
 * - `⊥ ⊑ everything` (bottom is identity).
 * - Equal types join to themselves (idempotent).
 * - Arrows join pointwise.
 * - Incompatible base types join to ⊤.
 *
 * Idempotent, commutative, associative, and monotone — required by
 * `parseToFixpoint`.
 */
export function joinType(a: Type, b: Type): Type {
  if (typeEq(a, bottomType)) return b;
  if (typeEq(b, bottomType)) return a;
  if (typeEq(a, b)) return a;
  if (a instanceof TFun && b instanceof TFun) {
    return new TFun(joinType(a.dom, b.dom), joinType(a.cod, b.cod));
  }
  return topType;
}

/* ── Sigma: the fixpoint domain (binding name → Type) ───────────────── */

/** The fixpoint domain: a map from binding name to its inferred type. */
export type Sigma = ReadonlyMap<string, Type>;

/** Join two Sigma maps pointwise (per-key `joinType`). */
export function joinSigma(a: Sigma, b: Sigma): Sigma {
  const out = new Map<string, Type>(a);
  for (const [k, v] of b) {
    out.set(k, out.has(k) ? joinType(out.get(k)!, v) : v);
  }
  return out;
}

/** Structural equality on Sigma (same keys, `typeEq` values). */
export function sigmaEq(a: Sigma, b: Sigma): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv === undefined || !typeEq(v, bv)) return false;
  }
  return true;
}

/** Build a `TypeEnv` from a Sigma (fold all entries into `outer`). */
function sigmaToTypeEnv(sigma: Sigma, outer: TypeEnv): TypeEnv {
  let env = outer;
  for (const [name, ty] of sigma) env = env.extend(name, ty);
  return env;
}

/* ── RecBinding: a captured binding (value, not mutable state) ──────── */

/**
 * A captured `let rec` binding: the name, declared type, and the body's
 * source span. Like `STLCEval`'s `Closure`, this is a value carrying a span
 * so the body can be re-parsed later under a different context.
 */
interface RecBinding {
  readonly name: string;
  readonly type: Type;
  readonly bodySpan: Span;
}

/* ── STLCRecTypeCheck: `let rec` as a higher-order attribute ─────────── */

/**
 * A type checker for STLC with `let rec` — extends `STLCTypeCheck` with
 * mutually recursive bindings resolved via fixpoint iteration.
 *
 * `let rec f:τ₁ = e₁ and g:τ₂ = e₂ in body`
 *
 * The `letRecProd` production captures each binding body's span (like
 * `STLCEval` captures `Closure.bodySpan`), then a `chain` callback runs
 * `parseToFixpoint` to iterate the body types until stable, and finally
 * parses the `in body` under the converged context. This is a higher-order
 * attribute: a semantic action that re-enters the engine via `parseSegment`
 * to re-parse binding bodies under different contexts, iterated to a fixpoint.
 *
 * Extends `STLCTypeCheck` to inherit all semantic actions (`lam`, `app`,
 * `let_`, `varRef`, etc.) and their `@requires`/`@ensures` contracts.
 */
export class STLCRecTypeCheck extends STLCTypeCheck {
  /** The source text, stored so chain callbacks can re-parse substrings. */
  private _input: string = "";
  /** Captured binding spans (populated during the first pass). */
  private _recBindings: RecBinding[] = [];
  /** The body's start offset (after `in`), for the final re-parse. */
  private _bodyStart: number = 0;

  /** Parse with an explicit type environment. */
  override parseWith(input: string, env: TypeEnv): Set<Type> {
    this._input = input;
    return this._parseWith(input, this.recExprProd(env));
  }

  override parse(input: string): Set<Type> {
    return this.parseWith(input, TypeEnv.empty());
  }

  /* ── `let rec` production (higher-order attribute) ───────────────── */

  /**
   * `expr` with `let rec` as an alternative. This is the entry production
   * that includes the fixpoint-resolved `let rec` construct.
   */
  @rule
  recExprProd(ctx: unknown): Parser<Type> {
    return or(
      this.letRecProd(ctx),
      this.lambdaProd(ctx),
      this.letProd(ctx),
      this.appProd(ctx),
    );
  }

  /**
   * `let rec f:τ₁ = e₁ and g:τ₂ = e₂ in body`
   *
   * The production captures each binding body's span (like `STLCEval`
   * captures `Closure.bodySpan`). The `chain` callback then runs
   * `parseToFixpoint` — a higher-order attribute that re-parses each binding
   * body under the current σ via `parseSegment`, joins the results, and
   * iterates until σ stabilises. Finally, the `in body` is parsed under the
   * converged context.
   */
  @rule
  protected letRecProd(ctx: unknown): Parser<Type> {
    return seq(
      literal("let"), // 0
      this.ws1, // 1
      literal("rec"), // 2
      this.ws1, // 3
    ).chain(([_a, _b, _c, _d]) => {
      this._recBindings = [];
      return this.recBindings(ctx)
        .chain(() => {
          // Extend ctx with all binding names at their declared types
          // so the `in body` parse succeeds (cross-references resolve).
          let bodyCtx = ctx as TypeEnv;
          for (const b of this._recBindings) {
            bodyCtx = bodyCtx.extend(b.name, b.type);
          }
          // Parse `in body` — capture the body's start offset.
          return seq(this.ws1, literal("in"), this.ws1)
            .chain(() =>
              this.recExprProd(bodyCtx)
                .map((bodyType, bodySpan) => {
                  this._bodyStart = bodySpan.start;
                  return bodyType;
                })
            )
            .map(([, _bodyType]) => {
              // ── Higher-order attribute: the fixpoint ──
              const bindings = this._recBindings;
              // σ₀ = all bindings at their declared types (not bottomType —
              // the declared type is the initial approximation, and the
              // fixpoint refines it by joining with the body types).
              const sigma0: Sigma = new Map(
                bindings.map((b) => [b.name, b.type] as [string, Type]),
              );

              const parseBodies = (sigma: Sigma): Sigma[] => {
                const fullCtx = sigmaToTypeEnv(sigma, ctx as TypeEnv);
                return bindings.map((b) => {
                  const forest = this.parseSegment(
                    this._input,
                    b.bodySpan.start,
                    this.recExprProd(fullCtx),
                    b.bodySpan.end,
                  );
                  const bodyType = forest.values().next().value;
                  return new Map([[b.name, (bodyType ?? bottomType) as Type]]);
                });
              };

              const convergedSigma = this.parseToFixpoint<Sigma>(
                sigma0,
                parseBodies,
                joinSigma,
                sigmaEq,
              );

              // Re-parse the `in body` under the converged context.
              const convergedCtx = sigmaToTypeEnv(
                convergedSigma,
                ctx as TypeEnv,
              );
              const bodyForest = this.parseSegment(
                this._input,
                this._bodyStart,
                this.recExprProd(convergedCtx),
              );
              return bodyForest.values().next().value as Type;
            });
        })
        .map(([, result]) => result);
    }).map(([, result]) => result);
  }

  /**
   * Parse one or more `name:type = body` bindings separated by `and`.
   * Each body's span is captured via a side-effect (pushed to
   * `this._recBindings`), like `STLCEval` captures `Closure.bodySpan`.
   */
  @rule
  protected recBindings(ctx: unknown): Parser<unknown> {
    return this.oneRecBinding(ctx)
      .chain(() =>
        or(
          seq(this.ws1, literal("and"), this.ws1)
            .chain(() => this.recBindings(ctx))
            .map(([, result]) => result),
          epsilon(undefined),
        )
      )
      .map(([, result]) => result);
  }

  /** Parse one binding: `name : type = body` (captures body span). */
  @rule
  protected oneRecBinding(ctx: unknown): Parser<unknown> {
    return seq(
      this.ident, // 0  name
      this.ws, // 1
      char(":"), // 2
      this.ws, // 3
      this.type, // 4  type
      this.ws, // 5
      char("="), // 6
      this.ws, // 7
    ).chain(([name, , , , type]) => {
      assert(typeof name === "string", "binding name must be a string");
      assert(
        type instanceof TVar || type instanceof TFun,
        "binding type must be a Type",
      );
      const extCtx = this.extendCtx(ctx, name, type) as TypeEnv;
      return this.recExprProd(extCtx)
        .map((_bodyType, bodySpan) => {
          this._recBindings.push({ name, type, bodySpan });
          return _bodyType;
        });
    }).map(([, result]) => result);
  }
}
