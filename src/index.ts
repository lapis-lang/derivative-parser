/**
 * Public entry point for the `@lapis-lang/zipper-grammar` package.
 *
 * Re-exports the public API:
 * - {@link Grammar} — abstract base for executable, OO grammars; subclass it
 *   and define productions as `@rule` getters/methods.
 * - {@link rule} — decorator wrapping a production in a memoised lazy
 *   reference (getter or method form).
 * - {@link Parser} — the fluent combinator type (`map`, `or`, `then`,
 *   `chain`, `many`, `opt`).
 * - {@link GrammarShape} — shape interface mapping production names to
 *   their parse-tree types.
 * - {@link Span} — half-open `[start, end)` character-offset range passed
 *   to `.map()` callbacks.
 *
 * The parsing engine is **Parsing with Zippers** (Darragh & Adams, ICFP
 * 2020); see the package README for the full introduction.
 */

export { Grammar, rule } from "./Grammar.ts";
export type { Diagnostic, GrammarShape } from "./Grammar.ts";
export { Parser } from "./Parser.ts";
export type { Span } from "./zipper/zipper.ts";

export {
  assert,
  assertInvariants,
  AssertionError,
  ContractError,
  ensures,
  findRescueHandler,
  getCheckedMode,
  iff,
  implies,
  invariant,
  requires,
  rescue,
  setCheckedMode,
} from "./contracts.ts";
export type {
  ContractMetadata,
  EnsuresPredicate,
  InvariantPredicate,
  ParseFailure,
  RequiresPredicate,
  RescueHandler,
} from "./contracts.ts";
