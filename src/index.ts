/**
 * Public entry point for the `@lapis-lang/zipper-grammar` package.
 * See the README for the full API documentation.
 */

export { Grammar, rule } from "./Grammar.ts";
export type { Diagnostic, GrammarShape } from "./Grammar.ts";
export {
  FixpointDivergenceError,
  MonotonicityViolationError,
} from "./Grammar.ts";
export { Parser, parserOf } from "./Parser.ts";
export type { AttributionKind, Checkpoint } from "./Parser.ts";
export { ZipperDriver } from "./zipper.ts";
export type { Pos, Span, Tok } from "./zipper.ts";

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
  chainMetadata,
  collectMetadata,
  ContractError,
  ensures,
  findRescueHandler,
  getCheckedMode,
  iff,
  implies,
  invariant,
  metadataOf,
  requires,
  rescue,
  setCheckedMode,
} from "./contracts.ts";
export type {
  ContractMeta,
  ContractMetadata,
  ContractMetadataReport,
  EnsuresContract,
  EnsuresPredicate,
  InvariantContract,
  InvariantPredicate,
  MethodMetadataReport,
  OldSnapshot,
  ParseFailure,
  RequiresContract,
  RequiresPredicate,
  RescueHandler,
} from "./contracts.ts";

/* ── Tree-consuming grammars (higher-order attribute grammars) ── */
export { flattenTree, TreeExp } from "./zipper.ts";
export type { TreeTok } from "./zipper.ts";

/* ── Retained derivation trees ── */
export {
  buildDerivationTrees,
  DerivationNode,
  derivationToTreeToks,
  DerivationTree,
  ExactArityTreeExp,
  exactTreeExp,
  foldTree,
  treeExp,
} from "./derivation.ts";
export type { DerivationRecord, FoldHandlers } from "./derivation.ts";
