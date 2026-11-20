#!/usr/bin/env node
// The SDK's reference page, generated from its source and doc comments with the TypeScript compiler: every exported
// class with its public methods and properties, every option and result shape, every error.
//   node scripts/reference.mjs > reference.md
import ts from "typescript";
import { readFileSync } from "node:fs";

const entry = new URL("../src/index.ts", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const program = ts.createProgram([entry], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true });
const checker = program.getTypeChecker();
const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry)));
const resolved = (s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);

const doc = (symbol) => ts.displayPartsToString(symbol.getDocumentationComment(checker)).replace(/\s*\n\s*/g, " ").trim();
const internal = (node) => ts.getJSDocTags(node).some((t) => t.tagName.text === "internal");
const isPrivate = (node) => ts.getCombinedModifierFlags(node) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected) || (node.name && ts.isPrivateIdentifier(node.name));
const isStatic = (node) => !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static);
const oneLine = (text) => text.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
// a member's heading: its signature as written, without its body
function signature(node) {
  const src = node.getSourceFile().text;
  const end = node.body ? node.body.getStart() : node.getEnd();
  return oneLine(src.slice(node.getStart(), end))
    .replace(/;$/, "")
    .replace(/^(static\s+)?(async\s+)?/, "")
    // defaulted parameters read as optional; the default client is the one made from the environment
    .replace(/(\w+): Fibre = defaultClient\(\)/g, "$1?: Fibre")
    .replace(/(\w+): ([\w<>[\]]+) = (\{\}|\[\]|"[^"]*"|\d+)/g, "$1?: $2")
    .replace(/(\w+): (\{[^}]*\}) = \{\}/g, "$1?: $2");
}

const out = [];
const add = (...lines) => out.push(...lines);
const classes = [], interfaces = [], errors = [];
for (const e of exports) {
  const s = resolved(e);
  const decl = s.declarations?.[0];
  if (!decl) continue;
  if (ts.isClassDeclaration(decl)) {
    const base = decl.heritageClauses?.[0]?.types[0]?.expression.getText();
    if (s.name === "FibreError" || base === "FibreError") errors.push({ s, base });
    else classes.push(s);
  } else if (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) interfaces.push(s);
}

add("---", "title: typescript sdk", `description: Every class, method, option and error of @fibre-dev/sdk ${pkg.version}, generated from its source.`, "order: 1", `updated: ${new Date().toISOString().slice(0, 10)}`, "---", "");
add("`npm install @fibre-dev/sdk` (Node 20 and later, Bun, Deno; no dependencies). The key comes from `FIBRE_API_KEY`",
  "(or `FIBRE_TOKEN`), the address from `FIBRE_API_URL` (https://api.fibre.dev when it is not set). Times are in seconds.",
  "This page is generated from the SDK's own doc comments; the [guide](/docs/guide/) shows each call in use.", "");

const ORDER = ["Sandbox", "Command", "Files", "Template", "Fibre"];
classes.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
for (const s of classes) {
  const decl = s.declarations[0];
  add(`## ${s.name}`, "", doc(s) || "", "");
  const members = decl.members.filter((m) => !isPrivate(m) && !internal(m) && !ts.isConstructorDeclaration(m) && m.name);
  const groups = [["static", members.filter((m) => isStatic(m))], ["instance", members.filter((m) => !isStatic(m))]];
  for (const [, list] of groups) {
    for (const m of list) {
      const sym = checker.getSymbolAtLocation(m.name);
      const name = m.name.getText();
      if (ts.isPropertyDeclaration(m)) {
        add(`### ${isStatic(m) ? `${s.name}.` : ""}${name}`, "", "```ts norun reason=\"a signature\"", oneLine(m.getText().replace(/;$/, "")), "```", "");
      } else {
        const prefix = isStatic(m) ? `${s.name}.` : ts.isGetAccessor(m) ? "" : "";
        add(`### ${prefix}${name}${ts.isGetAccessor(m) ? "" : "()"}`, "", "```ts norun reason=\"a signature\"", signature(m), "```", "");
      }
      const text = sym ? doc(sym) : "";
      if (text) add(text, "");
    }
  }
}

add("## options and results", "");
for (const s of interfaces.sort((a, b) => a.name.localeCompare(b.name))) {
  const decl = s.declarations[0];
  // the API's own shapes (SandboxData, …) are its reference's, not this page's
  if (decl.getText().includes("Schemas[")) continue;
  add(`### ${s.name}`, "");
  if (doc(s)) add(doc(s), "");
  if (ts.isInterfaceDeclaration(decl)) {
    add("| field | type | |", "|---|---|---|");
    for (const m of decl.members) {
      const sym = checker.getSymbolAtLocation(m.name);
      const type = m.type ? oneLine(m.type.getText()).replace(/\|/g, "\\|") : "";
      add(`| \`${m.name.getText()}${m.questionToken ? "?" : ""}\` | \`${type}\` | ${(sym ? doc(sym) : "").replace(/\|/g, "\\|")} |`);
    }
    add("");
  } else {
    add("```ts norun reason=\"a type\"", oneLine(decl.getText()), "```", "");
  }
}

add("## errors", "", "Every error is a `FibreError` with `status`, `code`, `requestId`, `docsUrl` and the whole answer as `body`; catch a subclass for the kind you handle. The codes are listed in [errors](/docs/reference/errors/).", "");
add("| error | when |", "|---|---|");
for (const { s } of errors) add(`| \`${s.name}\` | ${doc(s).replace(/\|/g, "\\|")} |`);
add("");

process.stdout.write(out.join("\n"));
