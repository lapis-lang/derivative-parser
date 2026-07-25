#!/usr/bin/env -S deno run --allow-read --allow-run=deno
/**
 * CI check: fail if any exported symbol (or public class member) lacks a
 * JSDoc comment, as reported by `deno doc --json`.
 *
 * This is a lightweight guardrail for the JSR "Has docs for most symbols"
 * score, which requires ≥80% of exported symbols to be documented.
 *
 * Usage: deno run --allow-read --allow-run=deno scripts/check_docs.ts [entrypoint...]
 * Default entrypoint: src/index.ts
 */

interface DocNode {
  name: string;
  kind?: string;
  jsDoc?: JsDoc | null;
}

interface Declaration {
  declarationKind: string;
  kind: string;
  jsDoc?: JsDoc | null;
  def?: {
    properties?: DocNode[];
    methods?: DocNode[];
  };
}

/**
 * `jsDoc` in `deno doc --json` is an object (`{ doc?, tags? }`) in current
 * Deno, but has historically also been emitted as a plain string. Support
 * both to avoid false negatives or crashes across versions.
 */
type JsDoc = string | { doc?: string; tags?: unknown[] };

interface Symbol {
  name: string;
  declarations: Declaration[];
}

interface DocJson {
  version: number;
  nodes: Record<string, { symbols: Symbol[] }>;
}

const entrypoints = Deno.args.length > 0 ? Deno.args : ["src/index.ts"];

const cmd = new Deno.Command("deno", {
  args: ["doc", "--json", ...entrypoints],
  stdout: "piped",
  stderr: "piped",
});
const { stdout, stderr, success } = await cmd.output();
if (!success) {
  console.error(new TextDecoder().decode(stderr));
  Deno.exit(1);
}
const doc = JSON.parse(new TextDecoder().decode(stdout)) as DocJson;

const missing: string[] = [];

function hasDoc(node: { jsDoc?: JsDoc | null }): boolean {
  const { jsDoc } = node;
  if (jsDoc == null) return false;
  if (typeof jsDoc === "string") return jsDoc.trim().length > 0;
  return Boolean(jsDoc.doc?.trim());
}

/** Public class members: non-private, non-internal-by-convention. */
function publicMembers(def: Declaration["def"]): DocNode[] {
  const props = def?.properties ?? [];
  const methods = def?.methods ?? [];
  return [...props, ...methods].filter(
    (m) => !m.name.startsWith("#") && !m.name.startsWith("_"),
  );
}

for (const file of Object.values(doc.nodes)) {
  for (const sym of file.symbols ?? []) {
    const decl = sym.declarations.find((d) => d.declarationKind === "export");
    if (!decl) continue;
    if (!hasDoc(decl)) {
      missing.push(`${decl.kind} ${sym.name}`);
    }
    if (decl.kind === "class") {
      for (const member of publicMembers(decl.def)) {
        if (!hasDoc(member)) {
          missing.push(
            `${sym.name}.${member.name} (${member.kind ?? "member"})`,
          );
        }
      }
    }
  }
}

if (missing.length > 0) {
  console.error(`\n❌ ${missing.length} exported symbol(s) missing JSDoc:\n`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error(
    "\nJSR requires ≥80% of exported symbols to be documented. Add /** ... */ JSDoc to each.",
  );
  Deno.exit(1);
}

console.log(`✅ All exported symbols have JSDoc.`);
