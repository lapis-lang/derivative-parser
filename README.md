# @lapis-lang/derivative-parser

A TypeScript implementation of **Parsing with Zippers** (Darragh & Adams,
ICFP 2020) with full semantic actions, an object-oriented front-end inspired
by Bracha's *executable grammars* and Magi's Pratt parser.

Grammars are written as **classes**; productions are methods. Recursion —
including left-recursion and ambiguity — is handled by lazy references and
the PwZ zipper engine.

```ts
import { Grammar, rule } from '@lapis-lang/derivative-parser';

class BalancedParens extends Grammar<{ s: string }> {
    start() { return this.s; }
    @rule get s() {
        return this.or(
            this.seq(this.char('('), this.s, this.char(')'), this.s).map(() => 'ok'),
            this.epsilon('ok'),
        );
    }
}

new BalancedParens().recognize('(()())'); // true
new BalancedParens().parse('()');         // Set { 'ok' }
```

## Installation

```bash
npm install github:lapis-lang/derivative-parser#v1.0.0
```

Replace `v1.0.0` with the desired [tagged release](https://github.com/lapis-lang/derivative-parser/releases).

## Why "executable grammars"?

A grammar class **is** the parser. Productions are real methods, so they can
be **overridden** in subclasses to extend or wrap behaviour:

```ts
class Traced extends MathEval {
    readonly trace: number[] = [];
    @rule override get expr() {
        return super.expr.map((n) => { this.trace.push(n); return n; });
    }
}
```

Composition by inheritance, not by re-defining the grammar from scratch. See
[examples/arith.mts](examples/arith.mts).

## Shape-typed grammars

For grammars with multiple productions returning different parse-tree types,
parameterise the grammar by a **shape interface** mapping production names to
their parse-tree types:

```ts
interface MathShape { [k: string]: unknown; expr: unknown; term: unknown; factor: unknown }

abstract class AbstractMath<S extends MathShape> extends Grammar<S> {
    protected abstract add(l: S['expr'], r: S['term']): S['expr'];
    protected abstract num(s: string): S['factor'];
    @rule get expr(): Parser<S['expr']> { /* ... */ }
    @rule get term(): Parser<S['term']> { /* ... */ }
    @rule get factor(): Parser<S['factor']> { /* ... */ }
}

class MathEval extends AbstractMath<{ expr: number; term: number; factor: number }> {
    protected add(l: number, r: number) { return l + r; }
    /* ... */
}

class MathAST  extends AbstractMath<{ expr: Exp; term: Exp; factor: Exp }> {
    protected add(l: Exp, r: Exp): Exp { return { tag: 'add', left: l, right: r }; }
    /* ... */
}
```

The shape generalises the Pratt-parser `Grammar<T>` pattern (one global result
type) to per-production result types while keeping subclass overrides
type-safe.

## API

```ts
import { Grammar, Parser } from '@lapis-lang/derivative-parser';
```

### `Grammar<S>` — abstract base

Subclass and define productions as `@rule` getters (or methods) returning
`Parser<T>`. All of these are protected helpers on `Grammar`:

| Method                              | Effect                                     |
| ----------------------------------- | ------------------------------------------ |
| `char(c)`                           | Match one literal character.               |
| `pred(p, label?)`                   | Match a character predicate.               |
| `literal(s)`                        | Match a multi-character literal.           |
| `epsilon(value)`                    | ε — always succeeds, yielding `value`.     |
| `empty()`                           | ∅ — the failing parser.                    |
| `or(...parsers)`                    | Variadic alternation.                      |
| `seq(...parsers)`                   | Variadic concatenation; returns tuple.     |
| `parse(input)` / `recognize(input)` | Drivers — full forest / boolean.           |

The `@rule` decorator wraps a getter or method so each instance returns the
same `Parser` (backed by a `DelayedExp`) per `(this, getter)` slot, making
the grammar graph properly recursive without manual thunks.

### `Parser<T>` — fluent algebra

| Method      | Effect                                          |
| ----------- | ----------------------------------------------- |
| `or(other)` | A ∪ B                                           |
| `then(other)`| A ○ B — parse trees are pairs `[T, U]`.        |
| `map(f)`    | Semantic action / reduction.                    |
| `many()`    | A\* — parse trees are arrays `T[]`.             |
| `opt()`     | A ∪ ε — parse trees are `T \| undefined`.       |

## Algorithm

The parsing engine is **Parsing with Zippers** (Darragh & Adams, ICFP 2020),
extended here with full semantic-action support.

Instead of computing global Brzozowski derivatives, the engine maintains a
*worklist of zippers* — each zipper is a `(Exp, Mem, value)` triple where
`Exp` is the in-focus subexpression, `Mem` records the start/end position
plus parent contexts, and `value` carries the accumulated semantic result.
One `step(token)` advances every zipper in the current worklist:

- **Descent** (`Exp.goDown`): if a node has already been visited at the
  current position, the new parent context is threaded into its existing
  memo and any already-completed values are re-flowed — no re-traversal.
  Otherwise a fresh memo is allocated and `descend` dispatches structurally.
- **Ascent** (`Cxt.goUp`): each context type knows how to combine an
  incoming value with its accumulated state and propagate upward:
  - `SeqCxt` collects child values left-to-right, then calls `fn(vals)`.
  - `AltCxt` passes the value straight through to the parent memo.
  - `RedCxt` applies a semantic function before propagating.
  - `TopCxt` appends to the driver's result list.
- **Memos** (`Mem`): shared per `(node, startPos)` pair. `completeAt`
  records the value, sets `endPos`, and fires all registered parent
  contexts — enabling full parse forests on ambiguous grammars.

**Recognition mode**: `recognize()` enables a `recognizeOnly` flag that
suppresses duplicate completions at the same position, giving polynomial
`O(n²)` time on ambiguous grammars (the same asymptote as Earley/CYK)
while full `parse()` still returns the complete forest.

### Performance

Empirical scaling on the inherently-ambiguous worst case `S = S+S | 1`
(`recognize` mode; fresh grammar instance per iteration; `--stack-size=8192`):

| n    | input length | Grammar (PwZ) |
| ---- | ------------ | ------------- |
| 10   | 19           | <1 ms         |
| 20   | 39           | ~2 ms         |
| 50   | 99           | ~4 ms         |
| 100  | 199          | ~20 ms        |
| 200  | 399          | ~55 ms        |
| 300  | 599          | ~165 ms       |
| 500  | 999          | ~700 ms       |
| 1000 | 1999         | ~5.8 s        |

Run the benchmark yourself:

```bash
npm run bench
```

## Project layout

```
src/
  index.mts           — public entry point
  Grammar.mts         — OO grammar base + @rule decorator + drivers
  Parser.mts          — thin Parser<T> wrapper (fluent API)
  zipper/
    zipper.mts        — PwZ engine: Exp/Cxt/Mem hierarchy + ZipperDriver
examples/
  arith.mts           — shape-typed arithmetic + Bracha-style override
  arith-demo.mts      — runnable demo
  csv.mts             — CSV parser example
  json.mts            — JSON parser example
  lambda.mts          — lambda-calculus parser example
  scaling-bench.mts   — PwZ scaling benchmark
test/
  parser-algebra.test.mts       — unit tests for Parser combinators
  recognition.test.mts          — left-recursive / ambiguous grammars
  grammar-composition.test.mts  — shape-typed grammars + Bracha override
```

## Scripts

| Command                | Effect                                      |
| ---------------------- | ------------------------------------------- |
| `npm test`             | Type-check + run all tests with node:test.  |
| `npm run build`        | Emit publish-ready `dist/`.                 |
| `npm run example`      | Run the arithmetic example.                 |
| `npm run bench`        | Run the scaling benchmark.                  |

## References

- Pierce Darragh & Michael D. Adams,
  [*"Parsing with Zippers"*](https://michaeldadams.org/papers/parsing-with-zippers/parsing-with-zippers.pdf), ICFP 2020.
- Gilad Bracha,
  [*"Executable Grammars in Newspeak"*](https://bracha.org/executableGrammars.pdf), ENTCS 2007.
- Matthew Might, David Darais & Daniel Spiewak,
  [*"Parsing with Derivatives — A Functional Pearl"*](https://matt.might.net/papers/might2011derivatives.pdf), ICFP 2011.

## License

MPL-2.0.
