import { expect, test } from "bun:test";
import { Lang, parse } from "@ast-grep/napi";
import { discardedEdits, outsideRepositoryHint, typeScriptApiHint } from "../src/runner/program-lint.ts";

const warnings = (program: string) => discardedEdits(parse(Lang.TypeScript, program).root());

test("warns for the benchmark's discarded body edit through const aliases", () => {
	const result = warnings(`const method = sg.one(pattern, "policy.ts");
const body = method.node.field("body");
if (!body) throw new Error("no body");
body.replace("{ return computeDelay(attempt, settings); }");`);
	expect(result).toHaveLength(1);
	expect(result[0]).toContain("line 4:");
	expect(result[0]).toContain("this result was discarded");
});

test("recognizes native node chains and non-null assertions", () => {
	expect(warnings('sg.one(pattern).node.getMatch("A")!.replace("x");')).toHaveLength(1);
	expect(warnings('const root = sg.parse("TypeScript", source).root(); root.find(pattern).replace("x");')).toHaveLength(
		1,
	);
});

test("does not warn for returned, stored or committed edits", () => {
	for (const program of [
		'sg.rewrite(pattern, m => m.node.replace("x"));',
		'const node = sg.one(pattern).node; const edit = node.replace("x");',
		'const node = sg.one(pattern).node; node.getRoot().root().commitEdits([node.replace("x")]);',
		'const node = sg.one(pattern).node; function edit() { return node.replace("x"); }',
	])
		expect(warnings(program)).toEqual([]);
});

test("does not confuse string or application methods with native nodes", () => {
	for (const program of [
		'const s = "old"; s.replace("old", "new");',
		"const app = { replace() {} }; app.replace();",
		'const sg = application; sg.one(pattern).node.replace("x");',
		'function edit(sg) { sg.one(pattern).node.replace("x"); }',
		'const node = sg.one(pattern).node; function edit(node) { node.replace("x"); }',
		'let node = sg.one(pattern).node; node = application; node.replace("x");',
		'const { node } = application; node.replace("x");',
		'const { sg } = application; sg.one(pattern).node.replace("x");',
		'function edit({sg}) { sg.one(pattern).node.replace("x"); }',
		'for (const sg of applications) { sg.one(pattern).node.replace("x"); }',
		'for (const sg in applications) { sg.one(pattern).node.replace("x"); }',
		'class sg { static one() { return application; } } sg.one(pattern).node.replace("x");',
		'const C = class sg { edit() { sg.one(pattern).node.replace("x"); } };',
		'function* edit(sg) { sg.one(pattern).node.replace("x"); }',
		'import {sg} from "app"; sg.one(pattern).node.replace("x");',
		'try {} catch ({sg}) { sg.one(pattern).node.replace("x"); }',
	])
		expect(warnings(program)).toEqual([]);
});

test("the TypeScript API hint needs a TypeScript import, a TypeError and TypeScript 7", () => {
	const program = 'import ts from "typescript";\nts.createSourceFile("a.ts", "", 99);';
	const error = "TypeError: ts.createSourceFile is not a function";
	expect(typeScriptApiHint(program, error, "7.0.2")).toEqual([
		expect.stringContaining("7.0.2 here, which no longer has the classic compiler API"),
	]);
	expect(typeScriptApiHint(program, error, "5.9.3")).toEqual([]);
	expect(typeScriptApiHint(program, "Error: missing file", "7.0.2")).toEqual([]);
	expect(typeScriptApiHint('const ts = require("typescript");', error, "7.0.2")).toHaveLength(1);
	expect(typeScriptApiHint('import { x } from "typescript-helper";', error, "7.0.2")).toEqual([]);
});

const insideRepo = (file: string) => file.startsWith("/repo/");
const hint = (output: string) => outsideRepositoryHint(output, "/repo", insideRepo);

test("the outside-repository hint names the refused path from the error, not from stack frames", () => {
	expect(hint("EPERM: operation not permitted, open '/home/me/.zshrc'\n    path: \"/home/me/.zshrc\",")).toEqual([
		"/home/me/.zshrc is outside the repository, /repo. Programs can only change files inside it; edit files outside it directly.",
	]);
	// Bun's shell prints its error with no newline before the next line's source excerpt.
	expect(hint("bun: Operation not permitted: /tmp/z.txt1 | await $`echo hi > /tmp/z.txt`;")).toEqual([
		expect.stringMatching(/^\/tmp\/z\.txt is outside/),
	]);
	expect(hint("EROFS: read-only file system, open '/etc/a'\nEROFS: read-only file system, open '/etc/b'")).toEqual([
		expect.stringMatching(/^\/etc\/a \(and 1 more\) is outside/),
	]);
	expect(hint("EPERM: operation not permitted, open '/repo/.git/hooks/x'")).toEqual([]);
	expect(hint("Error: boom\n    at run (/opt/bun/prelude.ts:12:3)")).toEqual([]);
	expect(hint("EACCES: permission denied, open '/root/secret'")).toEqual([]);
});
