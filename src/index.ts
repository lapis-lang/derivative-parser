/**
 * Public entry point for the `@lapis-lang/zipper-grammar` package.
 * See the README for the full API documentation.
 */

export { Grammar, rule } from "./Grammar.ts";
export type { Diagnostic, GrammarShape } from "./Grammar.ts";
export { Parser, parserOf } from "./Parser.ts";
export type { Span } from "./zipper.ts";

export {
  between,
  chain,
  char,
  diagnostic,
  empty,
  epsilon,
  keyword,
  literal,
  or,
  plus,
  pred,
  sepBy,
  seq,
  sseq,
  trim,
} from "./combinators.ts";

export {
  digit,
  digits,
  ident,
  identChar,
  identFirst,
  identRest,
  ws,
  ws1,
  wsChar,
} from "./lexemes.ts";

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
  OldSnapshot,
  ParseFailure,
  RequiresPredicate,
  RescueHandler,
} from "./contracts.ts";

/* ── Tree-consuming grammars (higher-order attribute grammars) ── */
export { flattenTree, TreeExp } from "./zipper.ts";
export type { TreeTok } from "./zipper.ts";
