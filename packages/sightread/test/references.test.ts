// Exercise compiler-resolved references through the CLI and a real graph server.
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GraphResult } from "../src/model.ts";
import { createPaths } from "../src/paths.ts";
import { createReferenceIndex } from "../src/references.ts";
import { renderText } from "../src/render.ts";
import { createFixtureProject } from "./fixture.ts";

const repository = mkdtempSync(join(realpathSync("/tmp"), "sr-ref-"));
const root = join(repository, "client");
const runtime = mkdtempSync(join(realpathSync("/tmp"), "sr-run-"));
const cli = join(import.meta.dir, "../src/cli.ts");
const files: Record<string, string> = {
	"tsconfig.json":
		'{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"nodenext","moduleResolution":"nodenext"}}',
	"src/row.ts": [
		"export interface Getter { get(i: number): number; }",
		"export class Row implements Getter {",
		"  get(i: number) { return i; }",
		"}",
	].join("\n"),
	"src/barrel.ts": 'export { Row as ExportedRow } from "./row.ts";\n',
	"src/use.ts": [
		'import { Row as TableRow, type Getter } from "./row.ts";',
		'import { ExportedRow } from "./barrel.ts";',
		"const row = new TableRow();",
		"export function twice() { return row.get(1) + row.get(2); }",
		"export function multiline() { return row",
		"  .get(",
		"    3,",
		"  ); }",
		"export function optional() { return row?.get(0); }",
		"export function throughInterface(value: Getter) { return value.get(4); }",
		"export function throughExport() { return new ExportedRow().get(5); }",
		"class Cache { get(i: number) { return i; } }",
		"const get = (i: number) => i;",
		"export const decoys = new Cache().get(6) + get(7) + '.get('.length;",
	].join("\n"),
	"src/View.tsx": [
		'import { Row } from "./row.ts";',
		"type Item<T> = { id: string; value: T };",
		"export function View<T>({ items }: { items: Item<T>[] }) {",
		"  const row = new Row();",
		"  return <main data-count={row.get(8)}><header><h1>Rows</h1></header><section>",
		"    {items.map((item) => <article key={item.id}><h2>{item.id}</h2><p>{String(item.value)}</p></article>)}",
		"  </section></main>;",
		"}",
	].join("\n"),
	"src/containers.ts": [
		"export function target() { return 1; }",
		"export class Base {}",
		"export class Holder {",
		"  field = target;",
		"  constructor() { target(); }",
		"}",
		"export interface Face {",
		"  prop: typeof target;",
		"  method(): typeof target;",
		"}",
		"export namespace N { export function inner() { target(); } }",
	].join("\n"),
	"src/default-function.ts": 'import { target } from "./containers.ts";\nexport default function() { target(); }',
	"src/default-class.ts":
		'import { Base, target } from "./containers.ts";\nexport default class extends Base { method() { target(); } }',
	"src/overloads.ts": [
		"export function overloaded(value: string): string;",
		"export function overloaded(value: number): number;",
		"export function overloaded(value: string | number) { return value; }",
		"export interface Merged { first: string; }",
		"export interface Merged { second: number; }",
	].join("\n"),
};
mkdirSync(root);
for (const [name, contents] of Object.entries(files)) {
	const path = join(root, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${contents}\n`);
}

function run(...args: string[]) {
	return runIn(root, ...args);
}

function runIn(directory: string, ...args: string[]) {
	const child = Bun.spawnSync([process.execPath, cli, "--cwd", directory, ...args], {
		env: { ...Bun.env, XDG_RUNTIME_DIR: runtime },
	});
	return { code: child.exitCode, out: child.stdout.toString().trimEnd(), err: child.stderr.toString().trimEnd() };
}

const fresh = join(repository, "fresh");
mkdirSync(join(fresh, "src"), { recursive: true });
writeFileSync(join(fresh, "tsconfig.json"), '{"compilerOptions":{"strict":true,"module":"nodenext"}}\n');
writeFileSync(join(fresh, "src/row.ts"), "export class Row { get(i: number) { return i; } }\n");

afterAll(() => {
	run("stop");
	runIn(fresh, "stop");
	runIn(wide, "stop");
	rmSync(repository, { recursive: true, force: true });
	rmSync(runtime, { recursive: true, force: true });
});

test("references include each resolved occurrence and its source line", () => {
	const output = run("--json", JSON.stringify({ type: "references", symbol: "Row.get" }));
	expect(output.code).toBe(0);
	const [result] = JSON.parse(output.out) as Array<{
		type: string;
		shown: number;
		nodes: Array<{ file: string; line: number; col: number; endCol: number; text: string }>;
	}>;
	expect(result.type).toBe("references");
	expect(result.shown).toBe(7);
	expect(result.nodes.map(({ file, line, col, endCol, text }) => ({ file, line, col, endCol, text }))).toEqual([
		{
			file: "src/use.ts",
			line: 4,
			col: 38,
			endCol: 41,
			text: "export function twice() { return row.get(1) + row.get(2); }",
		},
		{
			file: "src/use.ts",
			line: 4,
			col: 51,
			endCol: 54,
			text: "export function twice() { return row.get(1) + row.get(2); }",
		},
		{ file: "src/use.ts", line: 6, col: 4, endCol: 7, text: "  .get(\n    3,\n  ); }" },
		{ file: "src/use.ts", line: 9, col: 42, endCol: 45, text: "export function optional() { return row?.get(0); }" },
		{
			file: "src/use.ts",
			line: 10,
			col: 64,
			endCol: 67,
			text: "export function throughInterface(value: Getter) { return value.get(4); }",
		},
		{
			file: "src/use.ts",
			line: 11,
			col: 60,
			endCol: 63,
			text: "export function throughExport() { return new ExportedRow().get(5); }",
		},
		{
			file: "src/View.tsx",
			line: 5,
			col: 32,
			endCol: 35,
			text: "  return <main data-count={row.get(8)}><header><h1>Rows</h1></header><section>",
		},
	]);
	expect(run(JSON.stringify({ type: "references", symbol: "Row.get" })).out).toBe(
		[
			"references to Row.get: 7 in 2 files",
			"declared at src/row.ts:3  get(i: number) { return i; }",
			"",
			"src/use.ts",
			"   4:38  in twice  export function twice() { return row.get(1) + row.get(2); }",
			"   4:51  in twice  export function twice() { return row.get(1) + row.get(2); }",
			"    6:4  in multiline  .get(",
			`${" ".repeat(25)}3,`,
			`${" ".repeat(23)}); }`,
			"   9:42  in optional  export function optional() { return row?.get(0); }",
			"  10:64  in throughInterface  export function throughInterface(value: Getter) { return value.get(4); }",
			"  11:60  in throughExport  export function throughExport() { return new ExportedRow().get(5); }",
			"",
			"src/View.tsx",
			"  5:32  in View  return <main data-count={row.get(8)}><header><h1>Rows</h1></header><section>",
		].join("\n"),
	);
});

test("declarations are included only when requested", () => {
	const [result] = JSON.parse(
		run(
			"--json",
			JSON.stringify({
				type: "references",
				symbol: "Row.get",
				includeDeclaration: true,
			}),
		).out,
	) as Array<{ nodes: Array<{ file: string; line: number; col: number; endCol: number; text: string }> }>;
	expect(
		result.nodes
			.filter(({ file }) => file === "src/row.ts")
			.map(({ file, line, col, endCol, text }) => ({ file, line, col, endCol, text })),
	).toEqual([{ file: "src/row.ts", line: 3, col: 3, endCol: 6, text: "  get(i: number) { return i; }" }]);
});

test("names, errors, help, and batches use the references request", () => {
	const help = run("--help");
	expect(help.out).toContain("references\n  symbol*");
	expect(help.out).toContain("  includeDeclaration");
	const missing = run(JSON.stringify({ type: "references", symbol: "Row.noSuchMethod" }));
	expect(missing.code).toBe(1);
	expect(missing.err).toContain("Row.noSuchMethod not found");
	const ambiguous = run(JSON.stringify({ type: "references", symbol: "get" }));
	expect(ambiguous.code).toBe(1);
	expect(ambiguous.err).toContain("get is ambiguous; use a handle:");
	const handle = run("--json", JSON.stringify({ type: "references", symbol: "src/row.ts#Row.get:method" }));
	expect((JSON.parse(handle.out) as Array<{ shown: number }>)[0].shown).toBe(7);
	const batch = run(
		"--json",
		JSON.stringify([
			{ type: "references", symbol: "Row.get" },
			{ type: "trace", from: "Row.get", direction: "reverse" },
		]),
	);
	expect(batch.code).toBe(0);
	const results = JSON.parse(batch.out) as Array<{ type: string; nodes: unknown[] }>;
	expect(results.map(({ type }) => type)).toEqual(["references", "trace"]);
	expect(results[0].nodes).toHaveLength(7);
	expect(results[1].nodes.length).toBeGreaterThan(0);
});

test("references follow edits, new files and deleted files between queries", () => {
	const write = (name: string, lines: string[]) => writeFileSync(join(fresh, name), `${lines.join("\n")}\n`);
	const sites = () =>
		(
			JSON.parse(runIn(fresh, "--json", JSON.stringify({ type: "references", symbol: "Row.get" })).out) as Array<{
				nodes: Array<{ file: string; line: number; col: number; text: string }>;
			}>
		)[0].nodes.map(({ file, line, col, text }) => `${file}:${line}:${col} ${text}`);
	write("src/a.ts", ['import { Row } from "./row.ts";', "export const a = (row: Row) => row.get(1);"]);
	write("src/b.ts", ['import { Row } from "./row.ts";', "export const b = (row: Row) => row.get(2);"]);
	expect(sites()).toEqual([
		"src/a.ts:2:36 export const a = (row: Row) => row.get(1);",
		"src/b.ts:2:36 export const b = (row: Row) => row.get(2);",
	]);
	write("src/a.ts", ['import { Row } from "./row.ts";', "", "export const a = (row: Row) => row.get(1) + row.get(3);"]);
	write("src/c.ts", ['import { Row } from "./row.ts";', "export const c = (row: Row) => row.get(4);"]);
	unlinkSync(join(fresh, "src/b.ts"));
	expect(sites()).toEqual([
		"src/a.ts:3:36 export const a = (row: Row) => row.get(1) + row.get(3);",
		"src/a.ts:3:49 export const a = (row: Row) => row.get(1) + row.get(3);",
		"src/c.ts:2:36 export const c = (row: Row) => row.get(4);",
	]);
	write("src/c.ts", ["export const c = 4;"]);
	expect(sites()).toEqual([
		"src/a.ts:3:36 export const a = (row: Row) => row.get(1) + row.get(3);",
		"src/a.ts:3:49 export const a = (row: Row) => row.get(1) + row.get(3);",
	]);
});

test("colour dims each line and keeps its own reference bright", () => {
	const text = "\treturn row.get(1) + row.get(2);";
	const node = (col: number) => ({
		handle: `src/a.ts#reference:4:${col}`,
		name: "Row.get",
		file: "src/a.ts",
		line: 4,
		col,
		endCol: col + 3,
		text,
		ranges: null,
	});
	const result: GraphResult = {
		type: "references",
		shown: 2,
		nodes: [node(13), node(26)],
		edges: [],
		sections: { symbol: "Row.get" },
	};
	const [bold, dim, reset] = ["\u001b[1m", "\u001b[2m", "\u001b[0m"];
	expect(renderText(result, { color: true }).split("\n")).toEqual([
		"references to Row.get: 2 in 1 file",
		"",
		`${bold}src/a.ts${reset}`,
		`  ${dim}4:13${reset}  ${dim}return row.${reset}${bold}get${reset}${dim}(1) + row.get(2);${reset}`,
		`  ${dim}4:26${reset}  ${dim}return row.get(1) + row.${reset}${bold}get${reset}${dim}(2);${reset}`,
	]);
	expect(renderText(result, { color: false }).split("\n").slice(2)).toEqual([
		"src/a.ts",
		"  4:13  return row.get(1) + row.get(2);",
		"  4:26  return row.get(1) + row.get(2);",
	]);
});

test("a single symbol, qualified by its file, works in details and trace", () => {
	const output = run(
		"--json",
		JSON.stringify([
			{ type: "details", symbol: "src/row.ts#Row.get" },
			{ type: "trace", symbol: "src/row.ts#Row.get", direction: "reverse" },
			{ type: "references", symbol: "src/row.ts#Row.get" },
		]),
	);
	expect(output.code).toBe(0);
	const [details, trace, references] = JSON.parse(output.out) as Array<{
		type: string;
		nodes: Array<{ handle: string; exported?: true; line?: number; endLine?: number }>;
	}>;
	expect(details.type).toBe("details");
	expect(details.nodes.map(({ handle }) => handle)).toContain("src/row.ts#Row.get:method");
	expect(trace.type).toBe("trace");
	expect(references.nodes.find(({ line }) => line === 6)?.endLine).toBe(8);
	const missing = run(JSON.stringify({ type: "details", symbol: "src/use.ts#Row.get" }));
	expect(missing.code).toBe(1);
	expect(missing.err).toContain("src/use.ts#Row.get not found");
});

test("each reference names the declaration it sits in and the call it makes", () => {
	const [result] = JSON.parse(run("--json", JSON.stringify({ type: "references", symbol: "Row.get" })).out) as Array<{
		nodes: Array<{
			line: number;
			col: number;
			in?: { handle: string; name: string; kind: string; start: number; end: number; exported?: true };
			call?: {
				line: number;
				col: number;
				endLine: number;
				endCol: number;
				arguments: Array<{ line: number; col: number; endLine: number; endCol: number }>;
			};
		}>;
		sections: { declaration: { file: string; line: number; text: string } };
	}>;
	expect(result.sections.declaration).toEqual({ file: "src/row.ts", line: 3, text: "get(i: number) { return i; }" });
	const at = (line: number, col: number) => result.nodes.find((node) => node.line === line && node.col === col)!;
	expect(at(4, 38).in).toEqual({
		handle: "src/use.ts#twice:function",
		name: "twice",
		kind: "function",
		start: 4,
		end: 4,
		exported: true,
	});
	expect(at(4, 38).call).toEqual({
		line: 4,
		col: 34,
		endLine: 4,
		endCol: 44,
		arguments: [{ line: 4, col: 42, endLine: 4, endCol: 43 }],
	});
	expect(at(6, 4).call).toEqual({
		line: 5,
		col: 38,
		endLine: 8,
		endCol: 4,
		arguments: [{ line: 7, col: 5, endLine: 7, endCol: 6 }],
	});
});

const wide = join(repository, "wide");
const wideFiles: Record<string, string> = {
	"tsconfig.json": '{"compilerOptions":{"strict":true,"module":"nodenext"}}\n',
	"src/target.ts": "export function target() { return 1; }\n",
	"src/hub.ts": `${Array.from({ length: 40 }, (_, index) => `import { direct${index} } from "./direct${index}.ts";`).join("\n")}\nexport function hub() { return ${Array.from({ length: 40 }, (_, index) => `direct${index}()`).join(" + ")}; }\n`,
};
for (let index = 0; index < 40; index++) {
	wideFiles[`src/direct${index}.ts`] =
		`import { target } from "./target.ts";\nexport function direct${index}() { return target(); }\n`;
	wideFiles[`src/outer${index}.ts`] =
		`import { direct${index} } from "./direct${index}.ts";\n${index % 2 ? "" : "export "}function outer${index}() { return direct${index}(); }\nexport const use${index} = outer${index};\n`;
}
for (const [name, contents] of Object.entries(wideFiles)) {
	mkdirSync(dirname(join(wide, name)), { recursive: true });
	writeFileSync(join(wide, name), contents);
}

test("a reverse trace past the graph's limit is walked to the end through references", () => {
	const output = runIn(wide, "--json", JSON.stringify({ type: "trace", from: "target", direction: "reverse" }));
	expect(output.code).toBe(0);
	const [result] = JSON.parse(output.out) as Array<{
		shown: number;
		raise?: string;
		note?: string;
		nodes: Array<{ name: string; exported?: true }>;
	}>;
	const names = new Set(result.nodes.map(({ name }) => name));
	expect(result.raise).toBeUndefined();
	expect(result.note).toContain("complete");
	// 40 direct callers, the hub that calls them all, 40 outer callers, and the 40 variables that use those.
	expect(result.shown).toBe(121);
	for (let index = 0; index < 40; index++)
		for (const name of [`direct${index}`, `outer${index}`, `use${index}`]) expect(names.has(name)).toBe(true);
	expect(names.has("hub")).toBe(true);
	expect(result.nodes.find(({ name }) => name === "outer1")?.exported).toBeUndefined();
	expect(result.nodes.find(({ name }) => name === "outer0")?.exported).toBe(true);
	const text = runIn(wide, JSON.stringify({ type: "trace", from: "target", direction: "reverse" })).out;
	expect(text).toStartWith("trace reverse from target: 121 shown\n");
	expect(text).toEndWith(
		"note: complete: past the graph's 32-symbol limit, callers were followed through compiler references",
	);
});

test("a forward trace at the graph's limit says so instead of advising a raise", () => {
	const [result] = JSON.parse(
		runIn(wide, "--json", JSON.stringify({ type: "trace", from: "hub", direction: "forward", maxNodes: 100 })).out,
	) as Array<{ raise?: string; note?: string }>;
	expect(result.raise).toBeUndefined();
	expect(result.note).toBe("truncated at the graph's 32-symbol limit; trace again from the symbols at its edge");
});

test("constructor callers do not abort a complete reverse walk", async () => {
	const index = createReferenceIndex({ root, tsconfig: join(root, "tsconfig.json") });
	try {
		const result = await index.walk("src/containers.ts#target:function", { maxNodes: 20 }, createPaths(root));
		expect(result.nodes.map((node) => node.handle)).toContain("src/containers.ts#Holder.__constructor:method");
		expect(result.skipped).toBe(0);
	} finally {
		await index.close();
	}
});

test("reference containers use the graph's class and interface member handles", () => {
	const [references] = JSON.parse(
		run("--json", JSON.stringify({ type: "references", symbol: "src/containers.ts#target:function" })).out,
	) as Array<{ nodes: Array<{ line: number; in?: { handle: string } }> }>;
	for (const [line, name] of [
		[4, "Holder.field"],
		[8, "Face.prop"],
		[9, "Face.method"],
	] as const) {
		const [lookup] = JSON.parse(
			run("--json", JSON.stringify({ type: "lookup", query: name, limit: 20 })).out,
		) as Array<{
			nodes: Array<{ handle: string; name: string }>;
		}>;
		const handle = lookup.nodes.find((node) => node.name === name)?.handle;
		expect(handle).toBeDefined();
		expect(references.nodes.find((node) => node.line === line)?.in?.handle).toBe(handle);
	}
});

test("anonymous default declarations are containers with graph handles", () => {
	const [functionReferences] = JSON.parse(
		run("--json", JSON.stringify({ type: "references", symbol: "src/containers.ts#target:function" })).out,
	) as Array<{ nodes: Array<{ file: string; in?: { handle: string } }> }>;
	const [classReferences] = JSON.parse(
		run("--json", JSON.stringify({ type: "references", symbol: "src/containers.ts#Base:class" })).out,
	) as Array<{ nodes: Array<{ file: string; in?: { handle: string } }> }>;
	for (const [file, kind] of [
		["src/default-function.ts", "function"],
		["src/default-class.ts", "class"],
	] as const) {
		const [lookup] = JSON.parse(
			run("--json", JSON.stringify({ type: "lookup", query: "default", limit: 20 })).out,
		) as Array<{
			nodes: Array<{ handle: string }>;
		}>;
		const handle = `${file}#default:${kind}`;
		expect(lookup.nodes.map((node) => node.handle)).toContain(handle);
		const references = kind === "class" ? classReferences : functionReferences;
		expect(references.nodes.find((node) => node.file === file && node.in)?.in?.handle).toBe(handle);
	}
});

test("namespace function containers use the graph's qualified handle", () => {
	const [lookup] = JSON.parse(run("--json", JSON.stringify({ type: "lookup", query: "N.inner" })).out) as Array<{
		nodes: Array<{ handle: string; name: string }>;
	}>;
	const handle = lookup.nodes.find((node) => node.name === "N.inner")?.handle;
	expect(handle).toBe("src/containers.ts#N.inner:function");
	const [references] = JSON.parse(
		run("--json", JSON.stringify({ type: "references", symbol: "src/containers.ts#target:function" })).out,
	) as Array<{ nodes: Array<{ line: number; in?: { handle: string } }> }>;
	expect(references.nodes.find((node) => node.line === 11)?.in?.handle).toBe(handle);
});

test("an unresolvable caller is skipped without stopping the walk", async () => {
	const fixture = createFixtureProject({
		"target.ts": "export function target() {}\nexport class C { ['odd']() { target(); } }\n",
	});
	const index = createReferenceIndex({ root: fixture.root, tsconfig: join(fixture.root, "tsconfig.json") });
	try {
		const result = await index.walk("target.ts#target:function", { maxNodes: 10 }, createPaths(fixture.root));
		expect(result.skipped).toBe(1);
		expect(result.nodes.map((node) => node.handle)).toContain("target.ts#C.['odd']:method");
	} finally {
		await index.close();
		fixture.cleanup();
	}
});

test("includeDeclaration includes every overload of the same symbol", () => {
	const [result] = JSON.parse(
		run(
			"--json",
			JSON.stringify({ type: "references", symbol: "src/overloads.ts#overloaded:function", includeDeclaration: true }),
		).out,
	) as Array<{ nodes: Array<{ file: string; line: number }> }>;
	expect(result.nodes.filter((node) => node.file === "src/overloads.ts").map((node) => node.line)).toEqual([1, 2, 3]);
	const [merged] = JSON.parse(
		run(
			"--json",
			JSON.stringify({ type: "references", symbol: "src/overloads.ts#Merged:interface", includeDeclaration: true }),
		).out,
	) as Array<{ nodes: Array<{ file: string; line: number }> }>;
	expect(merged.nodes.filter((node) => node.file === "src/overloads.ts").map((node) => node.line)).toEqual([4, 5]);
});

test("cycles retain the edge from the start symbol", async () => {
	const fixture = createFixtureProject({
		"target.ts": "export function target() { a(); }\nexport function a() { target(); }\n",
	});
	const index = createReferenceIndex({ root: fixture.root, tsconfig: join(fixture.root, "tsconfig.json") });
	try {
		const result = await index.walk("target.ts#target:function", { maxNodes: 10 }, createPaths(fixture.root));
		expect(result.edges.map(({ from, to }) => [from, to])).toEqual([
			["target.ts#a:function", "target.ts#target:function"],
			["target.ts#target:function", "target.ts#a:function"],
		]);
	} finally {
		await index.close();
		fixture.cleanup();
	}
});

test("a reverse walk checks project file stamps only once", async () => {
	const fixture = createFixtureProject({
		"target.ts": "export function target() {}\nexport function a() { target(); }\nexport function b() { a(); }\n",
	});
	const index = createReferenceIndex({ root: fixture.root, tsconfig: join(fixture.root, "tsconfig.json") });
	const stat = spyOn(fsPromises, "stat");
	try {
		const result = await index.walk("target.ts#target:function", { maxNodes: 10 }, createPaths(fixture.root));
		expect(result.nodes.map((node) => node.name)).toEqual(["a", "b"]);
		expect(stat.mock.calls.filter(([path]) => path === join(fixture.root, "target.ts"))).toHaveLength(1);
	} finally {
		stat.mockRestore();
		await index.close();
		fixture.cleanup();
	}
});

test("a walk in a project below the repository root follows callers past the first level", async () => {
	const repo = mkdtempSync(join(realpathSync("/tmp"), "sr-nested-"));
	const client = join(repo, "client");
	const nested: Record<string, string> = {
		"tsconfig.json": '{"compilerOptions":{"strict":true,"module":"nodenext"}}\n',
		"src/target.ts": "export function target() { return 1; }\n",
		"src/a.ts": 'import { target } from "./target.ts";\nexport function a() { return target(); }\n',
		"src/b.ts": 'import { a } from "./a.ts";\nexport function b() { return a(); }\n',
	};
	for (const [name, contents] of Object.entries(nested)) {
		mkdirSync(dirname(join(client, name)), { recursive: true });
		writeFileSync(join(client, name), contents);
	}
	Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
	const index = createReferenceIndex({ root: client, tsconfig: join(client, "tsconfig.json") });
	try {
		const result = await index.walk("client/src/target.ts#target:function", { maxNodes: 10 }, createPaths(client));
		expect(result.nodes.map((node) => node.handle).toSorted()).toEqual([
			"client/src/a.ts#a:function",
			"client/src/b.ts#b:function",
		]);
		expect(result.skipped).toBe(0);
	} finally {
		await index.close();
		rmSync(repo, { recursive: true, force: true });
	}
});
