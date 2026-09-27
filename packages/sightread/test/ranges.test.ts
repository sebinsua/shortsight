// Test syntax and cache behavior for source ranges.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { API } from "typescript/unstable/async";
import { createDeclarationParser, createRangeIndex, parseDeclarations, type Declaration } from "../src/ranges.ts";
import { startGraphClient } from "../src/upstream.ts";

const directories: string[] = [];
const itemListFixture = new URL("./item-list.tsx.txt", import.meta.url);

async function project() {
	const root = await mkdtemp(join(tmpdir(), "sightread-ranges-"));
	directories.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const source = [
	"/** function docs",
	" * second line */",
	"export function outer() {",
	"\tconst inner = 1;",
	"\treturn inner;",
	"}",
	"export class Row {",
	"\tfield = 1;",
	"\tconstructor() {}",
	"\tmethod(x: string): string;",
	"\tmethod(x: number): number;",
	"\tmethod(x: string | number) { return x; }",
	"\tget value() { return this.field; }",
	"}",
	"export interface Shape {",
	"\tarea(): number;",
	"\tname: string;",
	"}",
	"export type Alias = string;",
	"export enum Colour { Red, Blue }",
	"export const Memoed = memo(",
	"\t() => 1,",
	"\t(a, b) => a === b,",
	");",
].join("\n");

function entry(declarations: Declaration[], name: string, kind: Declaration["kind"]) {
	return declarations.filter((declaration) => declaration.name === name && declaration.kind === kind);
}

test("parses every supported declaration and exact source ranges", async () => {
	const declarations = await parseDeclarations("sample.ts", source);
	expect(entry(declarations, "outer", "function")).toEqual([
		{ name: "outer", kind: "function", start: 1, codeStart: 3, end: 6, exported: true },
	]);
	expect(entry(declarations, "outer.inner", "variable")).toEqual([
		{ name: "outer.inner", kind: "variable", start: 4, codeStart: 4, end: 4 },
	]);
	expect(entry(declarations, "Row", "class")[0]?.end).toBe(14);
	expect(entry(declarations, "Row.field", "property")[0]?.start).toBe(8);
	expect(entry(declarations, "Row.__constructor", "method")[0]?.start).toBe(9);
	expect(entry(declarations, "Row.value", "method")[0]?.start).toBe(13);
	expect(entry(declarations, "Row.method", "method").map(({ start }) => start)).toEqual([10, 11, 12]);
	expect(entry(declarations, "Shape", "interface")[0]?.end).toBe(18);
	expect(entry(declarations, "Shape.area", "method")[0]?.start).toBe(16);
	expect(entry(declarations, "Shape.name", "property")[0]?.start).toBe(17);
	expect(entry(declarations, "Alias", "type")[0]?.start).toBe(19);
	expect(entry(declarations, "Colour", "enum")[0]?.start).toBe(20);
	expect(entry(declarations, "Memoed", "variable")).toEqual([
		{ name: "Memoed", kind: "variable", start: 21, codeStart: 21, end: 24, exported: true },
	]);
});

test("preserves function overloads and merged interface declarations in source order", async () => {
	const declarations = await parseDeclarations(
		"sample.ts",
		"function call(x: string): string;\nfunction call(x: number): number;\nfunction call(x: string | number) { return x; }\ninterface Item { a: string }\ninterface Item { b: number }\nenum Flag { One }\nenum Flag { Two }",
	);
	expect(entry(declarations, "call", "function").map(({ start }) => start)).toEqual([1, 2, 3]);
	expect(entry(declarations, "Item", "interface").map(({ start }) => start)).toEqual([4, 5]);
	expect(entry(declarations, "Flag", "enum").map(({ start }) => start)).toEqual([6, 7]);
});

test("a file's @module comment isn't part of the first declaration, but its own doc comment is", async () => {
	const declarations = await parseDeclarations(
		"sample.ts",
		"/**\n * @module\n * MIME utility.\n */\n\nexport const first = 1;\n\n/** The second. */\nexport const second = 2;\n/**\n * @packageDocumentation\n */\n/** Documented. */\nexport function third() {}",
	);
	expect(entry(declarations, "first", "variable").map(({ start }) => start)).toEqual([6]);
	expect(entry(declarations, "second", "variable").map(({ start }) => start)).toEqual([8]);
	expect(entry(declarations, "third", "function").map(({ start }) => start)).toEqual([13]);
});

test("marks exactly the top-level declarations a module exports", async () => {
	const declarations = await parseDeclarations(
		"sample.ts",
		[
			"export function modified() {}",
			"function listed() {}",
			"function renamed() {}",
			"function hidden() {}",
			"const byDefault = 1;",
			"export class Box { method() {} }",
			"export { listed, renamed as alias };",
			"export default byDefault;",
		].join("\n"),
	);
	const exported = (name: string) => declarations.find((declaration) => declaration.name === name)?.exported ?? false;
	expect(["modified", "listed", "renamed", "byDefault", "Box"].map(exported)).toEqual([true, true, true, true, true]);
	expect(["hidden", "Box.method"].map(exported)).toEqual([false, false]);
});

test("one parser gives each of many .tsx and .ts files its own declarations", async () => {
	const parser = createDeclarationParser();
	try {
		for (let index = 0; index < 6; index++)
			for (const extension of [".tsx", ".ts"]) {
				const expected = `Item${index}${extension === ".tsx" ? "View" : "Model"}`;
				const contents =
					extension === ".tsx"
						? `export function ${expected}() { return <main><h1>{${index}}</h1></main>; }\n`
						: `export function ${expected}() { return ${index}; }\n`;
				expect(
					(await parser.parse(`file${index}${extension}`, contents)).map((declaration) => declaration.name),
				).toEqual([expected]);
			}
	} finally {
		await parser.close();
	}
});

test("ranges anonymous default declarations using names and kinds from the live graph", async () => {
	const repository = await project();
	const root = join(repository, "client");
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "tsconfig.json"), '{"include":["src/**/*"]}');
	await writeFile(join(root, "src/Function.ts"), "export default function (pi: number) {\n\treturn pi + 1;\n}\n");
	await writeFile(join(root, "src/Class.ts"), "export default class {\n\tvalue = 1;\n}\n");
	await writeFile(join(root, "src/Arrow.ts"), "export default (value: number) => value + 1;\n");
	await writeFile(join(root, "src/Expression.ts"), "const value = 1;\nexport default value;\n");
	await writeFile(join(root, "src/View.tsx"), "export function View() { return <main><h1>Hello</h1></main>; }\n");
	const index = createRangeIndex(root);
	let client;
	try {
		client = await startGraphClient({ root, tsconfig: join(root, "tsconfig.json") });
		const value = (await client.query({ type: "lookup", query: "default", limit: 30 })).value;
		const hits = (value as { result: { hits: Array<{ name: string; kind: string; file: string }> } }).result.hits;
		expect(hits.filter(({ name }) => name === "default").map(({ file, kind }) => ({ file, kind }))).toEqual([
			{ file: "src/Class.ts", kind: "class" },
			{ file: "src/Function.ts", kind: "function" },
		]);
		expect(await index.rangesFor({ file: "src/Function.ts", name: "default", kind: "function" })).toEqual([
			{ start: 1, end: 3 },
		]);
		expect(await index.rangesFor({ file: "src/Class.ts", name: "default", kind: "class" })).toEqual([
			{ start: 1, end: 3 },
		]);
		expect(await index.rangesFor({ file: "src/Class.ts", name: "default.value", kind: "variable" })).toEqual([
			{ start: 2, end: 2 },
		]);
	} finally {
		await index.close();
		await client?.close();
	}
});

test("keeps the TSX extension when parsing a realistic JSX component", async () => {
	const fixtureText = await readFile(itemListFixture, "utf8");
	const tsx = await parseDeclarations("ItemList.tsx", fixtureText);
	expect(entry(tsx, "ItemList", "function")).toEqual([
		{ name: "ItemList", kind: "function", start: 5, codeStart: 6, end: 25, exported: true },
	]);
	expect(entry(tsx, "after", "function")).toEqual([
		{ name: "after", kind: "function", start: 29, codeStart: 29, end: 31, exported: true },
	]);
	const ts = await parseDeclarations("ItemList.ts", fixtureText);
	expect(entry(ts, "ItemList", "function")[0]?.end).toBe(11);
});

test("reuses one parser for concurrent TSX files without mixing their declarations", async () => {
	const fixtureText = await readFile(itemListFixture, "utf8");
	const other = fixtureText.replaceAll("ItemList", "OtherList").replace("function after()", "function later()");
	const parser = createDeclarationParser();
	try {
		const [first, second] = await Promise.all([
			parser.parse("ItemList.tsx", fixtureText),
			parser.parse("OtherList.tsx", other),
		]);
		expect(entry(first, "ItemList", "function")[0]?.end).toBe(25);
		expect(entry(first, "after", "function")[0]?.end).toBe(31);
		expect(entry(first, "OtherList", "function")).toEqual([]);
		expect(entry(second, "OtherList", "function")[0]?.end).toBe(25);
		expect(entry(second, "later", "function")[0]?.end).toBe(31);
		expect(entry(second, "ItemList", "function")).toEqual([]);
	} finally {
		await parser.close();
	}
});

test("finds the full TSX range through a project index", async () => {
	const root = await project();
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src/ItemList.tsx"), await readFile(itemListFixture, "utf8"));
	const index = createRangeIndex(root);
	try {
		expect(await index.rangesFor({ file: "src/ItemList.tsx", name: "ItemList", kind: "function" })).toEqual([
			{ start: 5, end: 25 },
		]);
	} finally {
		await index.close();
	}
});

test("shares one parse across concurrent declarations and ranges requests", async () => {
	const root = await project();
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src/ItemList.tsx"), await readFile(itemListFixture, "utf8"));
	const update = spyOn(API.prototype, "updateSnapshot");
	const index = createRangeIndex(root);
	try {
		const [first, second, ranges] = await Promise.all([
			index.declarations("src/ItemList.tsx"),
			index.declarations("src/ItemList.tsx"),
			index.rangesFor({ file: "src/ItemList.tsx", name: "ItemList", kind: "function" }),
		]);
		expect(update).toHaveBeenCalledTimes(1);
		expect(first).toBe(second);
		expect(ranges).toEqual([{ start: 5, end: 25 }]);
	} finally {
		await index.close();
		update.mockRestore();
	}
});

test("matches graph aliases, overloads, and line-selected nonmerged declarations", async () => {
	const root = await project();
	await writeFile(join(root, "sample.ts"), source);
	await writeFile(join(root, "duplicates.ts"), "const same = 1;\nconst same = 2;");
	await writeFile(
		join(root, "overloads.ts"),
		"function call(x: string): string;\nfunction call(x: number): number;\nfunction call(x: string | number) { return x; }",
	);
	const index = createRangeIndex(root);
	try {
		expect(await index.rangesFor({ file: "sample.ts", name: "Row.field", kind: "variable", line: 8 })).toEqual([
			{ start: 8, end: 8 },
		]);
		expect(await index.rangesFor({ file: "sample.ts", name: "Shape.name", kind: "variable" })).toEqual([
			{ start: 17, end: 17 },
		]);
		expect(await index.rangesFor({ file: "sample.ts", name: "Memoed", kind: "property" })).toEqual([
			{ start: 21, end: 24 },
		]);
		expect(await index.rangesFor({ file: "sample.ts", name: "Row.method", kind: "method", line: 12 })).toEqual([
			{ start: 10, end: 10 },
			{ start: 11, end: 11 },
			{ start: 12, end: 12 },
		]);
		expect(await index.rangesFor({ file: "overloads.ts", name: "call", kind: "function", line: 3 })).toEqual([
			{ start: 1, end: 1 },
			{ start: 2, end: 2 },
			{ start: 3, end: 3 },
		]);
		expect(await index.rangesFor({ file: "duplicates.ts", name: "same", kind: "variable", line: 2 })).toEqual([
			{ start: 2, end: 2 },
		]);
		expect(await index.rangesFor({ file: "duplicates.ts", name: "same", kind: "variable", line: 99 })).toEqual([
			{ start: 1, end: 1 },
			{ start: 2, end: 2 },
		]);
	} finally {
		await index.close();
	}
});

test("skips unsafe and unreadable paths", async () => {
	const root = await project();
	const outside = await project();
	await writeFile(join(outside, "secret.ts"), "export const secret = 1;");
	await symlink(join(outside, "secret.ts"), join(root, "escape.ts"));
	const index = createRangeIndex(root);
	try {
		for (const path of ["/tmp/a.ts", "../secret.ts", "sub/../a.ts", "bad\\path.ts", "escape.ts", "missing.ts"])
			expect(await index.declarations(path)).toBeUndefined();
	} finally {
		await index.close();
	}
});

test("reuses unchanged cached declarations and reparses changed files", async () => {
	const root = await project();
	const file = join(root, "a.ts");
	await writeFile(file, "export const First = 1;");
	const index = createRangeIndex(root);
	try {
		const first = await index.declarations("a.ts");
		expect(await index.declarations("a.ts")).toBe(first);
		await writeFile(file, "export const Second = 123;");
		const second = await index.declarations("a.ts");
		expect(second).not.toBe(first);
		expect(second?.[0]?.name).toBe("Second");
	} finally {
		await index.close();
	}
});

test("logs a dead parser and recovers on the next file", async () => {
	const root = await project();
	await writeFile(join(root, "first.ts"), "export const First = 1;");
	await writeFile(join(root, "second.ts"), "export const Second = 2;");
	const index = createRangeIndex(root);
	let parserProcess: ChildProcess | undefined;
	const logged = spyOn(console, "error").mockImplementation(() => undefined);
	const originalUpdate = API.prototype.updateSnapshot;
	const update = spyOn(API.prototype, "updateSnapshot").mockImplementation(async function (this: API, ...args) {
		const snapshot = await originalUpdate.apply(this, args);
		parserProcess = (this as unknown as { client: { process?: ChildProcess } }).client.process;
		return snapshot;
	});
	try {
		expect((await index.declarations("first.ts"))?.[0]?.name).toBe("First");
		const exited = new Promise<void>((resolve) => parserProcess?.once("exit", () => resolve()));
		parserProcess?.stdin?.end();
		parserProcess?.kill();
		await exited;
		expect(await index.declarations("second.ts")).toBeUndefined();
		expect(logged).toHaveBeenCalledTimes(1);
		expect(String(logged.mock.calls[0]?.[0])).toContain("TypeScript parser process exited");
		expect((await index.declarations("second.ts"))?.[0]?.name).toBe("Second");
	} finally {
		update.mockRestore();
		await index.close();
		logged.mockRestore();
	}
});

test("evicts the oldest cached file after maxFiles", async () => {
	const root = await project();
	await writeFile(join(root, "a.ts"), "export const a = 1;");
	await writeFile(join(root, "b.ts"), "export const b = 2;");
	const index = createRangeIndex(root, { maxFiles: 1 });
	try {
		const first = await index.declarations("a.ts");
		expect(await index.declarations("a.ts")).toBe(first);
		await index.declarations("b.ts");
		expect(await index.declarations("a.ts")).not.toBe(first);
	} finally {
		await index.close();
	}
});
