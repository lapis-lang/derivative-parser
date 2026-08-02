# Contributing to lang-forma

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

**Token-stream API**: `ZipperDriver` exposes a stepwise interface (`init` /
`step` / `flushEof` / `forest`) — the derivative-as-continuation primitive. The
live driver state _is_ the resumable parse: feed tokens as they arrive, pause
when input is exhausted, resume when more arrives. `withInitialOffset` sets the
base offset so a segment parse of a larger source reports spans in absolute
coordinates.

**Incremental memo reuse**: `stepReplay(token)` reuses the existing `Pos`
sentinel for a token's offset if the driver visited it in a prior pass (via an
`offsetToPos` reverse-lookup), so `Exp.m` memos hit on the unchanged region.
`Grammar.reparseIncremental` feeds the unchanged prefix/suffix via `stepReplay`
and the edited region via `step` (fresh `Pos`), yielding O(affected region)
re-parsing.

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
