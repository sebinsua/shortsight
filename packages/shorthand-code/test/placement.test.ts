import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { type Destination, file, insert, move, remember, remove } from "../src/refactor/placement.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(source: string, name = "main.ts") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "shorthand-placement-")));
	roots.push(root);
	const path = join(root, name);
	writeFileSync(path, source);
	return path;
}

function match(path: string, pattern: string | { rule: { kind: string } }) {
	const source = readFileSync(path, "utf8");
	const node = parse(Lang.TypeScript, source).root().find(pattern)!;
	expect(node).not.toBeNull();
	return remember({ file: path, text: node.text(), node }, source);
}

function statements(path: string) {
	return parse(Lang.TypeScript, readFileSync(path, "utf8"))
		.root()
		.namedChildren()
		.map((node) => node.text());
}

test("inserts before and after statements, preserving Unicode offsets", () => {
	const path = fixture("// 🐈 café\nfirst();\nlast();\n");
	insert("before();", { before: match(path, "last();") });
	insert("after();", { after: match(path, "first();") });
	expect(statements(path)).toEqual(["// 🐈 café", "first();", "after();", "before();", "last();"]);
});

test("moves in both directions within one file", () => {
	const path = fixture("a();\nb();\nc();\n");
	move(match(path, "a();"), { after: match(path, "c();") });
	expect(statements(path)).toEqual(["b();", "c();", "a();"]);
	move(match(path, "a();"), { before: match(path, "b();") });
	expect(statements(path)).toEqual(["a();", "b();", "c();"]);
});

test("moves to either end of the containing file", () => {
	const path = fixture("a();\nb();\nc();\n");
	move(match(path, "a();"), { endOf: file(path) });
	expect(statements(path)).toEqual(["b();", "c();", "a();"]);
	move(match(path, "a();"), { startOf: file(path) });
	expect(statements(path)).toEqual(["a();", "b();", "c();"]);
});

test("moves between files with a transform; copying uses text", () => {
	const source = fixture("function oldName() { return 1; }\n");
	const target = fixture("export {};\n");
	const declaration = match(source, "function oldName() { $$$BODY }");
	insert(declaration.text, { endOf: file(target) });
	expect(readFileSync(source, "utf8")).toContain("oldName");
	move(declaration, { endOf: file(target) }, (text) => text.replace("oldName", "newName"));
	expect(readFileSync(source, "utf8").trim()).toBe("");
	expect(statements(target)).toEqual(["export {};", declaration.text, "function newName() { return 1; }"]);
});

test("file selection is lazy and insertion can create directories", () => {
	const source = fixture("a();");
	const path = join(source, "..", "nested", "new.ts");
	const root = file(path);
	expect(existsSync(path)).toBe(false);
	insert("export const value = 1;", { startOf: root });
	expect(statements(path)).toEqual(["export const value = 1;"]);
});

test("inserts at both ends of empty and populated blocks", () => {
	const path = fixture("function f() {}\n");
	const body = () => match(path, { rule: { kind: "statement_block" } });
	insert("a();", { startOf: body() });
	insert("b();", { endOf: body() });
	insert("first();", { startOf: body() });
	expect(
		body()
			.node.namedChildren()
			.map((node) => node.text()),
	).toEqual(["first();", "a();", "b();"]);
});

test("moves a statement into an ancestor block", () => {
	const path = fixture("function f() { a(); b(); }\n");
	move(match(path, "a();"), { endOf: match(path, { rule: { kind: "statement_block" } }) });
	expect(
		match(path, { rule: { kind: "statement_block" } })
			.node.namedChildren()
			.map((node) => node.text()),
	).toEqual(["b();", "a();"]);
});

test("remove preserves adjacent comments", () => {
	const path = fixture("// keep this\na(); // and this\nb();\n");
	remove(match(path, "a();"));
	expect(statements(path)).toEqual(["// keep this", "// and this", "b();"]);
});

test("remove and move take a statement's doc comment with it, and leave other comments", () => {
	const path = fixture(
		"// header\n\n/** About a. */\n// note\nconst a = 1;\n/** Stays: a blank line follows. */\n\nb(); // trailing\n/** About c. */ c();\n",
	);
	remove(match(path, "const a = 1;"));
	expect(readFileSync(path, "utf8")).toBe(
		"// header\n\n/** Stays: a blank line follows. */\n\nb(); // trailing\n/** About c. */ c();\n",
	);
	move(match(path, "c();"), { startOf: file(path) });
	expect(readFileSync(path, "utf8")).toBe(
		"/** About c. */ c();\n// header\n\n/** Stays: a blank line follows. */\n\nb(); // trailing\n",
	);
});

test("placement keeps comments with the code they belong to", () => {
	const path = fixture(
		"/** Adds numbers. */\nexport function add(a: number, b: number) { return a + b; }\nconst a = 1; // the answer\n// seconds, NOT ms\nconst timeout = 30;\nconst retries = 3;\nfunction f() {}\n",
	);
	insert('import { z } from "./z";', { before: match(path, "export function add($$$) { $$$ }") });
	insert("const b = 2;", { after: match(path, "const a = 1") });
	move(match(path, "const timeout = 30"), { after: match(path, "function f() {}") });
	expect(readFileSync(path, "utf8")).toBe(
		'import { z } from "./z";\n/** Adds numbers. */\nexport function add(a: number, b: number) { return a + b; }\nconst a = 1; // the answer\nconst b = 2;\nconst retries = 3;\nfunction f() {}\n// seconds, NOT ms\nconst timeout = 30;\n',
	);
});

test("remove takes a directive about the next line with its statement", () => {
	const path = fixture(
		'// keep\n// @ts-expect-error string port\nexport const port: number = "8080";\nexport const host = "x";\n',
	);
	remove(match(path, 'export const port: number = "8080";'));
	expect(readFileSync(path, "utf8")).toBe('// keep\nexport const host = "x";\n');
});

test("remove leaves a file's header and region or file-wide directives", () => {
	const path = fixture(
		'/**\n * @license MIT\n */\nimport { unused } from "./u";\nimport { used } from "./v";\nused();\n/* c8 ignore start */\ndebugOnly();\notherDebug();\n/* c8 ignore stop */\n',
	);
	remove(match(path, 'import { unused } from "./u";'));
	remove(match(path, "debugOnly();"));
	expect(readFileSync(path, "utf8")).toBe(
		'/**\n * @license MIT\n */\nimport { used } from "./v";\nused();\n/* c8 ignore start */\notherDebug();\n/* c8 ignore stop */\n',
	);
});

test("a nested statement can move out before what contains it", () => {
	const path = fixture("export function outer() {\n\tfunction inner() {\n\t\treturn 1;\n\t}\n\treturn inner();\n}\n");
	move(match(path, "function inner($$$P) { $$$B }"), { before: match(path, "export function outer($$$P) { $$$B }") });
	expect(readFileSync(path, "utf8")).toBe(
		"function inner() {\n\t\treturn 1;\n\t}\nexport function outer() {\n\treturn inner();\n}\n",
	);
});

test("without semicolons, an expression that is its whole statement can be removed and placed after", () => {
	const path = fixture("obsolete()\nfunction f() {\n\twork()\n\tobsolete()\n}\nsave(a)\n", "a.js");
	const source = readFileSync(path, "utf8");
	const calls = parse(Lang.JavaScript, source)
		.root()
		.findAll("obsolete()")
		.map((node) => remember({ file: path, text: node.text(), node }, source));
	remove(calls);
	const save = parse(Lang.JavaScript, readFileSync(path, "utf8")).root().find("save(a)")!;
	insert("log(a)", { after: remember({ file: path, text: save.text(), node: save }, readFileSync(path, "utf8")) });
	expect(readFileSync(path, "utf8")).toBe("function f() {\n\twork()\n}\nsave(a)\nlog(a)\n");
});

test("startOf a file goes after its shebang and directives", () => {
	const path = fixture('#!/usr/bin/env node\n"use client";\nmain();\n');
	insert("const a = 1;", { startOf: file(path) });
	expect(readFileSync(path, "utf8")).toBe('#!/usr/bin/env node\n"use client";\nconst a = 1;\nmain();\n');
});

test("a statement on lines of its own is removed with its line, indentation and all", () => {
	const path = fixture("function f() {\n\ta();\n\tb();\n}\nfirst();\nsecond(); third();\r\nlast();\n");
	remove([match(path, "b();"), match(path, "first();"), match(path, "third();"), match(path, "last();")]);
	expect(readFileSync(path, "utf8")).toBe("function f() {\n\ta();\n}\nsecond(); \r\n");
});

test("batch removal groups multiple matches in each file", () => {
	const first = fixture("// keep\na();\nb();\nc();\n");
	const second = fixture("a();\nb();\n");
	remove([match(first, "c();"), match(second, "a();"), match(first, "a();")]);
	expect(statements(first)).toEqual(["// keep", "b();"]);
	expect(statements(second)).toEqual(["b();"]);
	remove([]);
});

test("a stale match aborts batch removal before any writes", () => {
	const first = fixture("a();\n");
	const second = fixture("b();\n");
	const stale = match(second, "b();");
	writeFileSync(second, "b();\nc();\n");
	expect(() => remove([match(first, "a();"), stale])).toThrow("Stale match");
	expect(readFileSync(first, "utf8")).toBe("a();\n");
	expect(readFileSync(second, "utf8")).toBe("b();\nc();\n");
});

test("batch removal rejects duplicates and nested overlaps before writing any file", () => {
	const first = fixture("a();\n");
	const second = fixture("function f() { b(); }\n");
	const outer = match(second, "function f() { $$$BODY }");
	for (const overlapping of [outer, match(second, "b();")]) {
		expect(() => remove([match(first, "a();"), outer, overlapping])).toThrow("overlapping");
		expect(readFileSync(first, "utf8")).toBe("a();\n");
		expect(readFileSync(second, "utf8")).toBe("function f() { b(); }\n");
	}
});

test("rejects stale, detached and unsupported matches without writes", () => {
	const path = fixture("a();\nb();\n");
	const stale = match(path, "b();");
	insert("c();", { before: stale });
	const before = readFileSync(path, "utf8");
	expect(() => remove(stale)).toThrow("Stale match");
	expect(() => remove({ ...match(path, "b();") })).toThrow("file-backed");
	// A call that is all of its statement stands for it; part of one doesn't.
	expect(() => remove(match(path, "a"))).toThrow("whole statement");
	expect(() => insert("x();", { startOf: match(path, "a();") })).toThrow("file root or statement block");
	expect(() => insert("x();", { before: stale, after: stale } as unknown as Destination)).toThrow("exactly one");
	expect(readFileSync(path, "utf8")).toBe(before);
});

test("rejects self-moves and moving a function into its own body", () => {
	const path = fixture("function f() { a(); }\n");
	const source = match(path, "function f() { $$$BODY }");
	expect(() => move(source, { before: source })).toThrow("overlapping");
	expect(() => move(source, { endOf: match(path, { rule: { kind: "statement_block" } }) })).toThrow("overlapping");
	expect(readFileSync(path, "utf8")).toBe("function f() { a(); }\n");
});

test("validates both files before writing a cross-file move", () => {
	const source = fixture("a();\n");
	const target = fixture("b();\n");
	expect(() => move(match(source, "a();"), { endOf: file(target) }, () => "const = ;")).toThrow("invalid syntax");
	expect(readFileSync(source, "utf8")).toBe("a();\n");
	expect(readFileSync(target, "utf8")).toBe("b();\n");
});

test("rejects transforms that throw or return nonstrings", () => {
	const path = fixture("a();\nb();\n");
	const source = match(path, "a();");
	const target = { after: match(path, "b();") };
	expect(() =>
		move(source, target, () => {
			throw new Error("abort");
		}),
	).toThrow("abort");
	expect(() => move(source, target, (() => undefined) as unknown as (text: string) => string)).toThrow(
		"non-empty string",
	);
	expect(readFileSync(path, "utf8")).toBe("a();\nb();\n");
});

test("does not silently join semicolonless statements", () => {
	const path = fixture("foo()\n");
	expect(() => insert("(bar)();", { endOf: file(path) })).toThrow("statement boundaries");
	expect(readFileSync(path, "utf8")).toBe("foo()\n");
});

test("insertion preserves both neighboring boundaries for calls, arrays and templates", () => {
	for (const continuation of ["(bar)();", "[bar].forEach(run);", "`template`;"]) {
		const source = "foo()\n";
		const path = fixture(source);
		expect(() => insert(continuation, { endOf: file(path) })).toThrow("statement boundaries");
		expect(readFileSync(path, "utf8")).toBe(source);

		writeFileSync(path, continuation);
		expect(() => insert("foo()", { startOf: file(path) })).toThrow("statement boundaries");
		expect(readFileSync(path, "utf8")).toBe(continuation);

		insert("foo();", { startOf: file(path) });
		expect(statements(path)).toEqual(["foo();", continuation]);
	}
});

test("batch removal validates surviving boundaries in every file before writing", () => {
	const first = fixture("a();\n");
	for (const continuation of ["(bar)();", "[bar].forEach(run);", "`template`;"]) {
		const source = `foo()\nseparator();\n${continuation}\n`;
		const second = fixture(source);
		expect(() => remove([match(first, "a();"), match(second, "separator();")])).toThrow("statement boundaries");
		expect(readFileSync(first, "utf8")).toBe("a();\n");
		expect(readFileSync(second, "utf8")).toBe(source);
	}
});

test("move validates source and destination boundaries before either file is written", () => {
	const source = fixture("foo()\nseparator();\n(bar)();\n");
	const target = fixture("target();\n");
	expect(() => move(match(source, "separator();"), { endOf: file(target) })).toThrow("statement boundaries");
	expect(readFileSync(source, "utf8")).toBe("foo()\nseparator();\n(bar)();\n");
	expect(readFileSync(target, "utf8")).toBe("target();\n");

	writeFileSync(source, "(bar)();\n");
	writeFileSync(target, "foo()\n");
	expect(() => move(match(source, "(bar)();"), { endOf: file(target) })).toThrow("statement boundaries");
	expect(readFileSync(source, "utf8")).toBe("(bar)();\n");
	expect(readFileSync(target, "utf8")).toBe("foo()\n");
});

test("validates insertion in its function body and rejects escaping that body", () => {
	const path = fixture("function f() { existing(); }\n");
	const body = () => match(path, { rule: { kind: "statement_block" } });
	insert("if (ready) { run(); }\nreturn result;", { endOf: body() });
	expect(
		body()
			.node.namedChildren()
			.map((node) => node.text()),
	).toEqual(["existing();", "if (ready) { run(); }", "return result;"]);
	const before = readFileSync(path, "utf8");
	expect(() => insert("}\nfunction escaped() {", { endOf: body() })).toThrow("statement boundaries");
	expect(readFileSync(path, "utf8")).toBe(before);
});

test("moves between nested and outer containers, including insertion at the removal position", () => {
	const path = fixture("function f() { a(); }\nb();");
	move(match(path, "a();"), { endOf: file(path) });
	move(match(path, "b();"), { endOf: match(path, { rule: { kind: "statement_block" } }) });
	expect(statements(path).at(-1)).toBe("a();");
	expect(
		match(path, { rule: { kind: "statement_block" } })
			.node.namedChildren()
			.map((n) => n.text()),
	).toEqual(["b();"]);
	move(match(path, "function f() { $$$BODY }"), { startOf: file(path) });
	move(match(path, "a();"), { endOf: file(path) });
	expect(statements(path)).toHaveLength(2);
});

test("preserves shebangs, CRLF, and template literal contents", () => {
	const path = fixture("#!/usr/bin/env bun\r\nlast();\r\n");
	insert("first();", { startOf: file(path) });
	expect(readFileSync(path, "utf8")).toStartWith("#!/usr/bin/env bun\r\nfirst();\r\n");
	const text = "const value = `first\n  second\nthird`;";
	insert(text, { endOf: file(path) });
	expect(readFileSync(path, "utf8")).toContain(text);
});

test("prelude exposes exact matching and editing helpers together", () => {
	const path = fixture("a();\nb();\n");
	const cwd = dirname(path);
	const init = Bun.spawnSync(["git", "init", "-q"], { cwd });
	expect(init.exitCode, init.stderr.toString()).toBe(0);
	const program = `
		const path = ${JSON.stringify(path)};
		try { sg.one("missing();", path); throw new Error("did not reject"); }
		catch (e) { if (!e.message.includes("found 0")) throw e; }
		try { sg.one({ rule: { kind: "expression_statement" } }, path); throw new Error("did not reject"); }
		catch (e) { if (!e.message.includes("found 2")) throw e; }
		sg.move(sg.one("a();", path), { endOf: sg.file(path) });
		sg.insert("c();", { before: sg.one("a();", path) });
		sg.remove(sg.one("b();", path));
		sg.insert("obsolete(); obsolete();", { endOf: sg.file(path) });
		sg.remove(sg.find("obsolete();", path));
	`;
	const result = Bun.spawnSync(
		["bun", "--preload", join(import.meta.dir, "../src/program/prelude.ts"), "-e", program],
		{
			cwd,
			env: process.env,
		},
	);
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	expect(statements(path)).toEqual(["c();", "a();"]);
});

test("sg.file enforces the repository boundary but accepts missing and ignored destinations", () => {
	const path = fixture("a();\n");
	const cwd = dirname(path);
	const outside = fixture("outside();\n");
	const init = Bun.spawnSync(["git", "init", "-q"], { cwd });
	expect(init.exitCode, init.stderr.toString()).toBe(0);
	writeFileSync(join(cwd, ".gitignore"), "ignored.ts\n");
	writeFileSync(join(cwd, "ignored.ts"), "ignored();\n");
	symlinkSync(dirname(outside), join(cwd, "external"), "dir");
	symlinkSync(outside, join(cwd, "external.ts"));
	symlinkSync(join(cwd, "ignored.ts"), join(cwd, "internal.ts"));
	symlinkSync(cwd, join(cwd, "internal"), "dir");
	const program = `
		import { existsSync } from "node:fs";
		import { strict as assert } from "node:assert";
		assert.throws(() => sg.file(${JSON.stringify(outside)}), /outside the repository/);
		assert.throws(() => sg.file("../missing.ts"), /outside the repository/);
		assert.throws(() => sg.file("external.ts"), /outside the repository/);
		assert.throws(() => sg.file("external/main.ts"), /outside the repository/);
		assert.throws(() => sg.file("external/nested/new.ts"), /outside the repository/);
		const destination = sg.file("nested/new.ts");
		assert.equal(existsSync("nested"), false);
		sg.insert("created();", { endOf: destination });
		assert.equal(sg.one("created();", "nested/new.ts").text, "created();");
		assert.equal(sg.find("ignored();", "ignored.ts").length, 0);
		sg.insert("added();", { endOf: sg.file("internal.ts") });
		sg.insert("linked();", { endOf: sg.file("internal/linked/new.ts") });
	`;
	const result = Bun.spawnSync(
		["bun", "--preload", join(import.meta.dir, "../src/program/prelude.ts"), "-e", program],
		{
			cwd,
			env: process.env,
		},
	);
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	expect(statements(join(cwd, "nested/new.ts"))).toEqual(["created();"]);
	expect(statements(join(cwd, "ignored.ts"))).toEqual(["ignored();", "added();"]);
	expect(statements(join(cwd, "linked/new.ts"))).toEqual(["linked();"]);
	expect(readFileSync(outside, "utf8")).toBe("outside();\n");
	expect(existsSync(join(dirname(outside), "nested"))).toBe(false);
});
