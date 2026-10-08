---
name: shorthand
description: Edit repository files with Bun programs using plain text edits or structural matching. Covers renames, file and declaration moves, and call-site migrations; the advanced guide covers extracting code, moving syntax and rule objects.
---

# Shorthand

Use text replacement for known source; use structural matching when it saves enumerating
occurrences or preserves varying syntax. Ordinary JavaScript strings, loops and Bun APIs work.
Tests, type-checks and builds belong outside the program: in a shell call, or, when your agent calls
code from a script, later in that script.

## Replace known text

```ts
edit({ path: "src/settings.ts", oldText: "pageSize: 20", newText: "pageSize: 50" });
```

`edit` replaces exactly one literal occurrence, throwing if it is missing or ambiguous. Include
surrounding text to distinguish repeated occurrences. Replacement text is literal, including `$`.
Line-ending differences are accepted when matching.
`edit` calls are synchronous and can be combined in one program; later calls see earlier changes.

## Refactors

Rename symbols, move files, or move a declaration to another file, updating the project to match:

```ts
await refactor.rename({ file: "src/users.ts", symbol: "parseUser", to: "decodeUser" });
await refactor.renameFile({ from: "src/users.ts", to: "src/models/users.ts" });
await refactor.move({ file: "src/api.ts", symbol: "parseUser", to: "src/users/parse.ts" });
```

`refactor.rename` leaves unrelated symbols alone. Use a qualified `symbol` such as `Session.refresh` when a
file has several declarations named `refresh`; an unqualified name works when it identifies one
declaration. A parameter or local is named through its function, as `load.id`. `rename` and
`references` also take a place with `at` instead: an `sg` match (a declaration's match acts on its
name, so `sg.one("function load($$$P) { $$$B }")` is `load`) or `{ file, line, column }`; without a
column, give the name to find on that line as `symbol`, as for a `grep` result. Each refactor checks
its result with TypeScript and, if it would add a type error or make a renamed name mean something
else, puts the files back and says why. `rename`, `move` and `references` also accept a graph node as
`file` and use its name when `symbol` is omitted. `refactor.renameFile` moves the file and updates imports and exports that
resolve to it. Read
[Semantic TypeScript refactors](advanced-refactors.md#semantic-typescript-refactors) for selection
rules, updated paths and failure conditions.

`refactor.move` appends the top-level declaration of `symbol` to `to`, which may be a new file. The
target imports what the declaration uses, exporting helpers from the source when needed; the source
imports it back if it still uses it; and files importing it from the source import it from the target.
Importers keep their style, including `tsconfig` path aliases. Default exports, overloads, namespace
imports that use it and dynamic imports of the source are refused before anything is written.

## Exact references

`refactor.references` returns every reference TypeScript resolves to a symbol, including calls through
import aliases and a second call in the same function, and leaves same-named methods on other types
alone. Matches go straight to `sg.rewrite`, and text returned for a reference replaces the name only:

```ts
const refs = await refactor.references({ file: "src/session.ts", symbol: "Session.refresh" });
sg.rewrite(refs, () => "renew");
```

References leave out the declaration unless you pass `includeDeclaration: true`, and an import's name
is a reference only where it's used. To rename a symbol, use `refactor.rename`, which also updates
declarations, imports and re-exports.

When a reference is being called, `match.call` is the whole call or `new` expression. To replace the
call, return `m.call.replace(...)`: returning `"logger.info(m)"` for `log("info", m)` would give
`logger.info(m)("info", m)`. To add an argument, append it to the last one, which keeps calls split
over lines with a trailing comma valid:

```ts
sg.rewrite(refs, (m) => {
	const last = m.call?.field("arguments")?.namedChildren().at(-1);
	return last ? last.replace(`${last.text()}, { force: true }`) : null;
});
```

Every match, from `refactor.references` or `sg.find`, has the same shape: `file`, `line` and `text`
are plain values (`m.file.startsWith("src/")`, not `m.file()`), while `node`, and `call` when there
is one, are syntax nodes with methods such as `text()`, `field()` and `replace()`.

## Code graph

When sightread is installed, `graph.query` asks the TypeScript compiler how code connects. It takes
one request or an array, and names work wherever a symbol is expected:

```ts
const [found, callers] = await graph.query([
	{ type: "lookup", query: "hashPassword" },
	{ type: "trace", from: "hashPassword", direction: "reverse" },
]);
```

Each result has `nodes`, symbols with `file` and line `ranges`, and `edges`, with `from`, `to`,
`kind` and `at` for where each relationship happens. `lookup` finds symbols by name, `trace` follows
callers (`direction: "reverse"`) or callees (`"forward"`), and `details` shows what a symbol uses.
`sightread --help` lists every field.

Pass nodes to `sg` as its scope to search only those symbols' lines:

```ts
sg.rewrite("hashPassword($A)", "hashPassword($A, pepper)", callers.nodes);
```

A trace's nodes are symbols, so a call at a file's top level, including inside a test's `describe`
or `it`, isn't among them. To change every call, use `refactor.references` instead.

The graph shows the repository before this program's edits: query first, then pass all the nodes
to one `sg` call. Scoping `sg` to a node in a file the program already edited throws. A caller that
calls a symbol twice is one edge, and `sg` inside a caller can also match a same-named call on
another type; use `refactor.references` when every call site must be exact.

## Insert before or after a statement

Validate an order immediately before saving it:

```ts
const save = sg.one("await saveOrder(order);", "checkout.ts");
sg.insert("validateOrder(order);", { before: save });
```

Use `{ after: save }` to insert after it instead. `sg.one(pattern, files?)` requires exactly one
match. Select the whole statement, including its semicolon, for before/after insertion in JS/TS.

## Replace calls while keeping their arguments

Switch timer calls without reproducing their arguments:

```ts
sg.rewrite("setTimeout($$$ARGS)", "scheduler.delay($$$ARGS)", "src");
```

`sg.rewrite(pattern, replacement, files?)` discovers, parses and writes matching files. Omit the
scope for the working directory, or pass a file, directory or glob. `$X` captures one syntax node;
`$$$X` captures a sequence. Captures can appear in the replacement text.

## Change one argument and preserve the rest

Migrate numeric image qualities to options objects, leaving existing options alone:

```ts
sg.rewrite("thumbnail($IMAGE, $QUALITY)", (m) => {
	const quality = m.node.getMatch("QUALITY")!;
	return quality.kind() === "number" ? quality.replace(`{ quality: ${quality.text()} }`) : null;
});
```

A callback returns text to replace the whole match, a native edit for part of it, or `null` to skip.
Rewrites apply one after another. A pattern rewrite skips places an earlier rewrite produced, so one
rewrite per call shape is safe in any order; select them with `sg.find` to rewrite them again.
**`node.replace()` constructs an edit; return it from the callback so `sg.rewrite` applies it.**

## Replace an implementation while keeping its signature

Make `calculateTotal` sum its prices, preserving parameter and return types:

```ts
const fn = sg.one(
	{ rule: { kind: "function_declaration", has: { field: "name", regex: "^calculateTotal$" } } },
	"prices.ts",
);
sg.rewrite(fn, (m) => m.node.field("body")!.replace("{ return prices.reduce((total, price) => total + price, 0); }"));
```

Use `kind: "method_definition"` with the same `has` to select a class method; match names with
`regex`, since a method's name is not an identifier pattern. `sg.rewrite(match, "new source")`
replaces the whole selected node instead. `sg.find` returns an
array: pass it once to `sg.rewrite(matches, callback)` for independent edits. Each call writes
immediately within the editing workspace; select again if a later edit depends on that write.

## Write files or replace plain text

```ts
await Bun.write("src/defaults.ts", "export const maxPageSize = 100;\n");
const source = await Bun.file("src/settings.ts").text();
await Bun.write("src/settings.ts", source.replace("pageSize: 20", "pageSize: 50"));
```

Use repository-relative paths. Changes apply on successful exit by default; the tool reports the
diff, preserves existing UTF-8 BOMs and uniform line endings across write methods, then uses a
detected project formatter. Counters and console summaries aren't required.

This page covers renames, file and declaration moves, and call-site migrations. Read
[advanced-refactors.md](advanced-refactors.md) only to extract code into a new function or file,
insert, move or remove other statements, or use rule objects or the native ast-grep API. The bundled
TypeScript 7 package has no legacy compiler API; use the supplied structural tools instead.
