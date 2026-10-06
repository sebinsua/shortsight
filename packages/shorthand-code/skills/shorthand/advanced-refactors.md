# Advanced refactors

Use this guide for extraction, complex structural rewrites, syntax placement or other languages.
The everyday file and replacement operations are in [SKILL.md](SKILL.md).

## Semantic TypeScript refactors

Prefer `refactor.rename` to a structural rewrite when changing a TypeScript symbol. It asks the TypeScript
language server to rename the resolved symbol across the project, so unrelated names and strings are
left alone. `file` is the declaration's file, and `symbol` must name exactly one declaration there.
Missing names, repeated declarations and overloads are rejected without writing.

Use `refactor.renameFile` to move a whole TypeScript file. It updates imports and exports that resolve to
the file, as well as relative module paths inside the moved file, then performs the move. The source
must exist, the destination must not exist, and both paths must remain inside the repository.

Await each operation; when it resolves, all of its edits are complete. Use `sg.move` below for
moving syntax between files; it does not repair imports or bindings. `refactor.move` moves a top-level
declaration with its imports.

## Extract existing source

Select and reuse the implementation rather than copying it into the program or searching for braces.
This extracts a state-independent method, leaves a delegate, and updates its direct caller:

```ts
const pattern = { rule: { kind: "method_definition", has: { field: "name", regex: "^print$" } } };
const method = sg.one(pattern, "printer.ts");
await Bun.write(
	"invoice.ts",
	'import type { Item, PrintOptions } from "./types";\n' +
		method.text.replace(/^print\b/, "export function renderInvoice"),
);
sg.rewrite(method, (m) => m.node.field("body")!.replace("{ return renderInvoice(items, options); }"));
await Bun.write("printer.ts", 'import { renderInvoice } from "./invoice";\n' + (await Bun.file("printer.ts").text()));
sg.rewrite('import { InvoicePrinter } from "./printer"', 'import { renderInvoice } from "./invoice"', "notify.ts");
sg.rewrite("new InvoicePrinter().print($$$ARGS)", "renderInvoice($$$ARGS)", "notify.ts");
```

Preserve imports and dependencies; moving source does not remove its dependence on instance state.
`field("body")` selects the actual body even when defaults or comments contain braces.

## Structural matching details

Patterns must parse as one syntax node; a standalone class method such as
`format($$$PARAMS) { $$$BODY }` is matched as a method. `$X` captures one node, `$$$X` a sequence, and `$_`
matches without capturing. Capture text is available as `m.X` or `m.vars.X`.

Callbacks are synchronous. They can return an array of native edits, or `null`/`undefined`/`false`
to skip. `sg.rewrite` counts matches producing edits, not individual edits. Overlaps are rejected;
an empty selection returns zero. Syntax fields and node kinds depend on the language.

`sg.find` and `sg.rewrite` handle JS, TS, TSX, HTML and CSS. Scopes accept files, directories,
globs or arrays. Paths may be relative or absolute within the editing workspace; results use
repository-relative paths. String scopes use Git's tracked and non-ignored files. An explicit
`sg.file()` target can also select an ignored JS/TS file; only files Git sees are applied afterward.

## Inserting, moving and removing syntax

For JS/TS, use matches from `sg.find` or `sg.one(pattern, files)`, which requires exactly one match.
`sg.file(path)` selects a JS/TS file root for placement or for scoping `find`, `one` and `rewrite`.
Pass paths or file targets individually or in mixed arrays. Missing targets are valid insertion destinations,
but cannot be searched.

```ts
sg.insert("initialize();", { before: sg.one("run();", "src/app.ts") });
sg.move(sg.one("function helper() { $$$BODY }", "src/old.ts"), {
	endOf: sg.file("src/new.ts"),
});
sg.remove(sg.find("obsolete();", "src")); // single match or array; validates the batch before writing
```

Choose one destination: `before`/`after` a whole statement or declaration (`"run();"`), or
`startOf`/`endOf` a file root or `statement_block`. For a function, select its body explicitly.
Argument lists and class bodies aren't supported.

To copy, use `sg.insert(source.text, destination)`. `sg.move(source, destination, transform?)`
accepts an optional `(text) => string` returning non-empty replacement text.

**Rematch placement targets after each edit**; use array removal for matches from one search. A `/** … */` doc comment
directly above a statement moves or is removed with it; other adjacent comments stay in place, and interior
whitespace is preserved. Imports and bindings aren't repaired; to move a top-level
declaration with its imports, use `refactor.move`. If placement
rejects joined statement boundaries, add explicit semicolons.

## Rule objects

When a pattern alone can't say it, pass a rule instead:

```ts
sg.find({ rule: { kind: "import_statement" } }, "src");
sg.find({ rule: { pattern: "console.log($$$A)", inside: { kind: "function_declaration", stopBy: "end" } } }, "src");
sg.find(
	{ rule: { pattern: "console.log($$$A)", not: { inside: { kind: "function_declaration", stopBy: "end" } } } },
	"src",
);
// constraints restrict what a capture may match
sg.rewrite({ rule: { pattern: "$F($X)" }, constraints: { F: { regex: "^(oldApi|legacyApi)$" } } }, "newApi($X)", "src");
```

`kind` names come from tree-sitter (`function_declaration`, `call_expression`, `import_statement`,
…). `stopBy: "end"` searches all ancestors, not just the parent.

## Native ast-grep API

For transformations outside file-backed rewrites, ast-grep's JavaScript API is exposed on `sg`:

```ts
const root = sg.parse(sg.Lang.TypeScript, sourceText).root();
const edits = root.findAll("oldApi($$$ARGS)").map((node) => node.replace("newApi()"));
await Bun.write("src/app.ts", root.commitEdits(edits));
```

`import { parse, Lang } from "@ast-grep/napi"` also works. Native `replace` constructs edits;
`commitEdits` returns updated source text. Neither writes files by itself.
The bundled TypeScript 7 package does not expose the legacy compiler API (`createSourceFile`,
`ScriptTarget`); changing import syntax won't make it available.

## File discovery and commands

```ts
glob("src/**/*.ts"); // sorted paths Git sees
grep("oldApi(", "src"); // [{ file, line, text }]; accepts a RegExp too
const files = await $`git ls-files`.text();
```

`glob`, `grep` and `sg` are synchronous. Bun's `$` needs `await`; interpolated values are
quoted as single arguments, and arrays become multiple arguments. These globals and bundled CLIs
belong to shorthand programs, not necessarily ordinary shell calls. `node:fs` and ordinary Bun APIs also work.

## Execution options

Programs run in an isolated repository workspace. Use relative paths: the live checkout's absolute
path is inaccessible on macOS. On both platforms, host paths outside the workspace are read-only
(including external symlink targets). `$TMPDIR` is private to the run.
Writes to `.git` are blocked.

The default timeout is five seconds; request more for longer transformations. Time inside helpers
(`edit`, `glob`, `grep`, `sg`, `refactor`) does not count toward it, up to 60 extra seconds per run.
By default, rollback happens per file: files involved in failed or interrupted edits are discarded,
while the others are retained, including after exceptions. Unattributed failures
(such as failed checks) preserve completed edits and report the failure. A failed file loses all
its edits from this run, even if the error is caught. Multi-file operations such as moves share
one outcome. Arbitrary shell failures cannot identify failed closed
files. Open writers are inspected before failure exits and timeout termination; inspection failures
or crashes that bypass exit handling retain nothing. Cancellation still discards everything.
Use `rollback: "all"` when the whole change must be atomic.
