# Contributing to zipper-grammar

Internal details for contributors. Consumers should see the [README](README.md)
for usage and the public API.

## Algorithm

The parsing engine is **Parsing with Zippers** (Darragh & Adams, ICFP 2020),
extended here with full semantic-action support.

Instead of computing global Brzozowski derivatives, the engine maintains a
_worklist of zippers_ — each zipper is a `(Exp, Mem, value)` triple where `Exp`
is the in-focus subexpression, `Mem` records the start/end position plus parent
contexts, and `value` carries the accumulated semantic result. One `step(token)`
advances every zipper in the current worklist:

- **Descent** (`Exp.goDown`): if a node has already been visited at the current
  position, the new parent context is threaded into its existing memo and any
  already-completed values are re-flowed — no re-traversal. Otherwise a fresh
  memo is allocated and `descend` dispatches structurally.
- **Ascent** (`Cxt.goUp`): each context type knows how to combine an incoming
  value with its accumulated state and propagate upward:
  - `SeqCxt` collects child values left-to-right, then calls `fn(vals)`.
  - `AltCxt` passes the value straight through to the parent memo.
  - `RedCxt` applies a semantic function before propagating.
  - `TopCxt` appends to the driver's result list.
- **Memos** (`Mem`): shared per `(node, startPos)` pair. `completeAt` records
  the value, sets `endPos`, and fires all registered parent contexts — enabling
  full parse forests on ambiguous grammars.

**Recognition mode**: `recognize()` enables a `recognizeOnly` flag that
suppresses duplicate completions at the same position, giving polynomial `O(n²)`
time on ambiguous grammars (the same asymptote as Earley/CYK) while full
`parse()` still returns the complete forest.

### Performance

Empirical scaling on the inherently-ambiguous worst case `S = S+S | 1`
(`recognize` mode; fresh grammar instance per iteration; mean of 5 runs with the
noisiest outlier discarded on small inputs):

| n    | input length | Grammar (PwZ) |
| ---- | ------------ | ------------- |
| 10   | 19           | ~1 ms         |
| 20   | 39           | ~3 ms         |
| 50   | 99           | ~4 ms         |
| 100  | 199          | ~15 ms        |
| 200  | 399          | ~80 ms        |
| 300  | 599          | ~218 ms       |
| 500  | 999          | ~1004 ms      |
| 1000 | 1999         | ~8.5 s        |

Run the benchmark yourself:

```bash
deno task bench
```

## Project layout

```
src/
  index.ts            — public entry point
  Grammar.ts          — OO grammar base + @rule decorator + drivers + contract Proxy
  Parser.ts           — thin Parser<T> wrapper (fluent API)
  contracts.ts        — grammar-native contracts: assert/implies/iff + @requires/@ensures/@invariant + Proxy dispatch
  util/
    tree_key.ts       — keying for @rule argument tuples: structural for primitives/arrays/plain objects, identity-based for class instances
  zipper/
    zipper.ts         — PwZ engine: Exp/Cxt/Mem hierarchy + ZipperDriver
examples/
  arith.ts           — shape-typed arithmetic + Bracha-style override
  arith-demo.ts      — runnable demo
  arith-var.ts        — arithmetic with variables; inherited attributes (read-only env)
  arith-var-demo.ts   — runnable demo
  csv.ts             — CSV parser example
  indent.ts          — significant-whitespace (indentation-sensitive) grammar; demonstrates @rule methods (parameterised productions) and Span offsets
  json.ts            — JSON parser example
  lambda-eval.ts     — untyped lambda calculus: AST builder + call-by-value evaluator (multi-pass)
  lambda-eval-demo.ts — runnable demo
  proplogic.ts       — propositional logic: formulas, truth-table evaluator, natural-deduction proofs
  proplogic-demo.ts   — runnable demo
  scaling-bench.ts   — PwZ scaling benchmark
  stlc.ts             — Simply Typed Lambda Calculus: AST, one-pass type checker, evaluator, proof-bearing type checker
  stlc-demo.ts        — runnable demo
test/
  parser-algebra.test.ts       — unit tests for Parser combinators
  recognition.test.ts          — left-recursive / ambiguous grammars
  grammar-composition.test.ts  — shape-typed grammars + Bracha override
  semantics.test.ts            — semantic examples (type checking, evaluation, proofs)
  contracts.test.ts            — grammar-native contracts (@requires/@ensures/@invariant, subcontracting, checked mode)
```

## Scripts

| Command                | Effect                                                       |
| ---------------------- | ------------------------------------------------------------ |
| `deno test`            | Type-check + run all tests with Deno's built-in test runner. |
| `deno task example`    | Run the arithmetic example.                                  |
| `deno task bench`      | Run the scaling benchmark.                                   |
| `deno task check-docs` | Verify exported symbols have JSDoc (JSR docs score).         |
| `deno publish`         | Publish a new version to JSR.                                |
