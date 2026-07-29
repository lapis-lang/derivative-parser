import {
  char,
  Grammar,
  or,
  rule,
  sepBy,
  sepByPlus,
  seq,
} from "../src/index.ts";
import { assertEquals } from "@std/assert";

// sepBy(...).opt() is redundant: empty input yields TWO distinct values ([] and undefined).
// sepByPlus(...).opt() is unambiguous: empty input yields ONE value (undefined).
// sepBy(...) alone yields ONE value for empty ([]).

class ListGrammar extends Grammar<{ r: { tag: string; xs: unknown } }> {
  @rule
  override start() {
    return or(this.sepByOpt(), this.sepByPlusOpt(), this.plainSepBy());
  }
  @rule
  protected sepByOpt() {
    return seq(char("A"), char(":"), sepBy(char("x"), char(",")).opt())
      .map(([, , xs]) => ({ tag: "sepBy.opt", xs }));
  }
  @rule
  @rule
  protected sepByPlusOpt() {
    return seq(char("B"), char(":"), sepByPlus(char("x"), char(",")).opt())
      .map(([, , xs]) => ({ tag: "sepByPlus.opt", xs }));
  }
  @rule
  protected plainSepBy() {
    return seq(char("C"), char(":"), sepBy(char("x"), char(",")))
      .map(([, , xs]) => ({ tag: "sepBy", xs }));
  }
}

Deno.test("sepBy(...).opt() is redundant — empty input yields 2 distinct values (footgun)", () => {
  const g = new ListGrammar();
  const r = [...g.parse("A:")];
  // The footgun: two distinct values ([] and undefined) for the empty list.
  assertEquals(r.length, 2);
  assertEquals(r[0], { tag: "sepBy.opt", xs: [] });
  assertEquals(r[1], { tag: "sepBy.opt", xs: undefined });
});

Deno.test("sepByPlus(...).opt() is unambiguous — empty input yields 1 value (undefined)", () => {
  const g = new ListGrammar();
  const r = [...g.parse("B:")];
  assertEquals(r.length, 1);
  assertEquals(r[0], { tag: "sepByPlus.opt", xs: undefined });
});

Deno.test("sepBy(...) alone yields 1 value for empty ([])", () => {
  const g = new ListGrammar();
  const r = [...g.parse("C:")];
  assertEquals(r.length, 1);
  assertEquals(r[0], { tag: "sepBy", xs: [] });
});

Deno.test("sepByPlus(...).opt() parses a single element", () => {
  const g = new ListGrammar();
  const r = [...g.parse("B:x")];
  assertEquals(r.length, 1);
  assertEquals(r[0], { tag: "sepByPlus.opt", xs: ["x"] });
});
