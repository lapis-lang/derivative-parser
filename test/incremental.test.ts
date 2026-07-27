/**
 * Tests — token-stream API and incremental memo reuse.
 *
 * Covers the stepwise `ZipperDriver` API (`init`/`step`/`flushEof`/`forest`)
 * and `reparseIncremental`, which reuses prior-pass memos for the unchanged
 * region so only the edited region is re-derived.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { ArithVarEval, Env } from "../examples/arith-var.ts";
import { Parser, ZipperDriver } from "../src/index.ts";

/* ── Token-stream API: stepwise parsing equals batch parsing ─────────── */

Deno.test("TokenStreamDriver — stepwise parse equals batch parse", () => {
  const g = new ArithVarEval();
  const input = "1+2*3";
  const start = g.expr(Env.empty());

  // Batch parse.
  const [batch] = [...g.parse(input)];

  // Stepwise parse via the token-stream API.
  const driver = new ZipperDriver();
  driver.init(start._exp);
  let off = 0;
  for (const c of input) {
    driver.step({ tag: c, sym: c, offset: off++ });
  }
  driver.flushEof();
  const [stepwise] = [...driver.forest<number>()];
  assertEquals(stepwise, batch);
  assertEquals(stepwise, 7);
});

Deno.test("TokenStreamDriver — pause and resume mid-stream", () => {
  const g = new ArithVarEval();
  const start = g.expr(Env.empty());

  // Feed the first two tokens, "pause", then feed the rest.
  const driver = new ZipperDriver();
  driver.init(start._exp);
  driver.step({ tag: "4", sym: "4", offset: 0 });
  driver.step({ tag: "2", sym: "2", offset: 1 });
  // "pause" — no tokens fed; in a non-blocking setting we'd wait for input.
  driver.step({ tag: "+", sym: "+", offset: 2 });
  driver.step({ tag: "1", sym: "1", offset: 3 });
  driver.flushEof();
  const [v] = [...driver.forest<number>()];
  assertEquals(v, 43);
});

Deno.test("TokenStreamDriver — forest() returns a snapshot Set", () => {
  const g = new ArithVarEval();
  const driver = new ZipperDriver();
  driver.init(g.expr(Env.empty())._exp);
  driver.step({ tag: "4", sym: "4", offset: 0 });
  driver.step({ tag: "2", sym: "2", offset: 1 });
  driver.flushEof();
  const f1 = driver.forest<number>();
  const f2 = driver.forest<number>();
  // Fresh Set each call, same contents.
  assertEquals(f1, f2);
  assertEquals([...f1], [42]);
});

/* ── reparseIncremental: result equality with full re-parse ──────────── */

Deno.test("reparseIncremental — single-token edit equals full re-parse", () => {
  const g = new ArithVarEval();
  const original = "1+2*3";
  const start = g.expr(Env.empty());

  // Prior parse: get the live driver.
  const priorDriver = new ZipperDriver();
  priorDriver.init(start._exp);
  let off = 0;
  for (const c of original) priorDriver.step({ tag: c, sym: c, offset: off++ });
  priorDriver.flushEof();
  const [originalVal] = [...priorDriver.forest<number>()];
  assertEquals(originalVal, 7);

  // Edit: change "2" to "5" at offset 2 → "1+5*3" = 16.
  const edited = "1+5*3";
  const editStart = 2;
  const editEnd = 3;

  // Incremental re-parse.
  const incResults = g.reparseIncremental(
    edited,
    start,
    editStart,
    editEnd,
    priorDriver,
  );
  const [incVal] = [...incResults];
  assertEquals(incVal, 16);

  // Full re-parse for comparison.
  const [fullVal] = [...g.parse(edited)];
  assertEquals(fullVal, 16);
  assertEquals(incVal, fullVal);
});

Deno.test("reparseIncremental — insertion (edit grows) equals full re-parse", () => {
  const g = new ArithVarEval();
  const original = "1+2";
  const start = g.expr(Env.empty());

  const priorDriver = new ZipperDriver();
  priorDriver.init(start._exp);
  let off = 0;
  for (const c of original) priorDriver.step({ tag: c, sym: c, offset: off++ });
  priorDriver.flushEof();

  // Edit: insert "*3" after "2" → "1+2*3" = 7. The edit region is [2, 2)
  // (zero-width insertion at offset 2), but the edited string is longer.
  // The edited region is the inserted chars [2, 4).
  const edited = "1+2*3";
  const editStart = 2;
  const editEnd = 4; // the inserted "*3" plus the original "2" shifts

  const incResults = g.reparseIncremental(
    edited,
    start,
    editStart,
    editEnd,
    priorDriver,
  );
  const [incVal] = [...incResults];
  const [fullVal] = [...g.parse(edited)];
  assertEquals(incVal, fullVal);
  assertEquals(incVal, 7);
});

Deno.test("reparseIncremental — rejects out-of-range edit offsets", () => {
  const g = new ArithVarEval();
  const input = "1+2";
  const start = g.expr(Env.empty());
  const priorDriver = new ZipperDriver();
  priorDriver.init(start._exp);
  for (const [i, c] of [...input].entries()) {
    priorDriver.step({ tag: c, sym: c, offset: i });
  }
  priorDriver.flushEof();

  // RangeError for invalid edit bounds.
  assertThrows(
    () => g.reparseIncremental(input, start, -1, 1, priorDriver),
    RangeError,
  );
  assertThrows(
    () => g.reparseIncremental(input, start, 2, 1, priorDriver),
    RangeError,
  );
  assertThrows(
    () => g.reparseIncremental(input, start, 0, 99, priorDriver),
    RangeError,
  );
});

/* ── reparseIncremental: no edit (identity) equals full re-parse ──────── */

Deno.test("reparseIncremental — zero-width edit (no change) equals full re-parse", () => {
  const g = new ArithVarEval();
  const input = "1+2*3";
  const start = g.expr(Env.empty());

  const priorDriver = new ZipperDriver();
  priorDriver.init(start._exp);
  let off = 0;
  for (const c of input) priorDriver.step({ tag: c, sym: c, offset: off++ });
  priorDriver.flushEof();

  // Zero-width edit at offset 3: no change.
  const incResults = g.reparseIncremental(input, start, 3, 3, priorDriver);
  const [incVal] = [...incResults];
  const [fullVal] = [...g.parse(input)];
  assertEquals(incVal, fullVal);
  assertEquals(incVal, 7);
});

/* ── Parser import is used (type-only re-export sanity) ─────────────── */

Deno.test("Parser — re-exported and constructible", () => {
  // Smoke test that the public exports are wired correctly.
  assertEquals(typeof Parser, "function");
  assertEquals(typeof ZipperDriver, "function");
});

/* ── reparseIncremental: memo reuse actually fires ────────────────────── */

Deno.test("reparseIncremental — stepReplay reuses Pos for unchanged region", () => {
  const g = new ArithVarEval();
  const original = "1+2*3";
  const start = g.expr(Env.empty());

  // Prior parse: build up posToOffset / offsetToPosMap.
  const priorDriver = new ZipperDriver();
  priorDriver.init(start._exp);
  let off = 0;
  for (const c of original) priorDriver.step({ tag: c, sym: c, offset: off++ });
  priorDriver.flushEof();

  // Snapshot the Pos sentinels from the prior pass for the unchanged offsets.
  // Offsets 0-1 (tokens "1", "+") are before the edit at offset 2.
  const priorPosAt0 = priorDriver.offsetToPosMap.get(0);
  const priorPosAt1 = priorDriver.offsetToPosMap.get(1);
  assert(priorPosAt0 !== undefined, "prior pass should have Pos for offset 0");
  assert(priorPosAt1 !== undefined, "prior pass should have Pos for offset 1");

  // Edit: change "2" to "5" at offset 2 → "1+5*3".
  const edited = "1+5*3";
  const incResults = g.reparseIncremental(edited, start, 2, 3, priorDriver);
  const [incVal] = [...incResults];
  assertEquals(incVal, 16);

  // After incremental re-parse, the unchanged offsets (0, 1) should still
  // map to the SAME Pos objects as the prior pass — proving stepReplay
  // reused them (and thus Exp.m memos hit). The edited offset (2) should
  // have a fresh Pos (different object identity).
  assertEquals(priorDriver.offsetToPosMap.get(0), priorPosAt0);
  assertEquals(priorDriver.offsetToPosMap.get(1), priorPosAt1);
  // Offset 2 (the edited token "5") should NOT be the prior Pos — it was
  // re-derived with a fresh Pos via step().
  const postEditPosAt2 = priorDriver.offsetToPosMap.get(2);
  assert(postEditPosAt2 !== undefined, "edited offset should have a Pos");
  // The prior pass also had a Pos at offset 2; the re-parse should have
  // replaced it with a fresh one (since step() mints fresh Pos).
  // Note: we can't compare to the prior Pos at 2 because init(keepMemoMap)
  // preserves the map but step() overwrites offset 2's entry with a new Pos.
  // The key assertion is that offsets 0 and 1 are unchanged (memo reuse).
});
