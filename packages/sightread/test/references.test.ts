// Exercise compiler-resolved references through the CLI and a real graph server.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphResult } from "../src/model.ts";
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
	"src/special.ts":
		'import { direct0 } from "./direct0.ts";\nimport { direct1 } from "./direct1.ts";\nexport function createRouterInner() { function step() { direct0(); } return step; }\nexport class Base { run() { direct1(); } }\nexport class Child extends Base { override run() { return super.run(); } }\n',
};
for (let index = 0; index < 40; index++) {
	wideFiles[`src/direct${index}.ts`] =
		`import { target } from "./target.ts";\nexport function direct${index}() { ${index === 0 ? 'const label = "💡"; ' : ""}return target(); }\n`;
	wideFiles[`src/outer${index}.ts`] =
		`import { direct${index} } from "./direct${index}.ts";\n${index % 2 ? "" : "export "}function outer${index}() { return direct${index}(); }\nexport const use${index} = outer${index};\n`;
}
for (const [name, contents] of Object.entries(wideFiles)) {
	mkdirSync(dirname(join(wide, name)), { recursive: true });
	writeFileSync(join(wide, name), contents);
}

test("a reverse trace past the graph's limit follows graph callers after its hub", () => {
	const output = runIn(
		wide,
		"--json",
		JSON.stringify({ type: "trace", from: "target", direction: "reverse", maxDepth: 3 }),
	);
	expect(output.code).toBe(0);
	const [result] = JSON.parse(output.out) as Array<{
		shown: number;
		raise?: string;
		note?: string;
		nodes: Array<{ name: string; handle: string; exported?: true }>;
		edges: Array<{ from: string; to: string; kind: string; at?: { file: string; line: number; col?: number } }>;
	}>;
	const names = new Set(result.nodes.map(({ name }) => name));
	expect(result.raise).toBeUndefined();
	expect(result.note).toContain("complete");
	// Calls from references complete the 40-caller hub; graph traces follow each later level.
	expect(result.shown).toBeGreaterThanOrEqual(83);
	for (let index = 0; index < 40; index++)
		for (const name of [`direct${index}`, `outer${index}`]) expect(names.has(name)).toBe(true);
	expect(names.has("hub")).toBe(true);
	expect(result.nodes.map(({ handle }) => handle)).toContain("src/special.ts#createRouterInner.step:function");
	expect(result.nodes.map(({ handle }) => handle)).toContain("src/special.ts#Child.run:method");
	expect(result.edges).toContainEqual(
		expect.objectContaining({
			from: "src/special.ts#Child.run:method",
			to: "src/special.ts#Base.run:method",
			kind: "overrides",
		}),
	);
	expect(result.edges.find(({ from }) => from === "src/direct0.ts#direct0:function")?.at?.col).toBe(
		'export function direct0() { const label = "💡"; return target(); }'.indexOf("target()") + 1,
	);
	expect(result.nodes.find(({ name }) => name === "outer1")?.exported).toBeUndefined();
	expect(result.nodes.find(({ name }) => name === "outer0")?.exported).toBe(true);
	const text = runIn(wide, JSON.stringify({ type: "trace", from: "target", direction: "reverse", maxDepth: 3 })).out;
	expect(text).toStartWith(`trace reverse from target: ${result.shown} shown\n`);
	expect(text).toEndWith(
		"note: complete: past the graph's 32-symbol limit, callers were followed through graph traces",
	);
});

test("a reverse trace from a hub shows its direct users unless asked to go deeper", () => {
	const [result] = JSON.parse(
		runIn(wide, "--json", JSON.stringify({ type: "trace", from: "target", direction: "reverse" })).out,
	) as Array<{ nodes: Array<{ name: string }>; note?: string }>;
	const names = new Set(result.nodes.map(({ name }) => name));
	for (let index = 0; index < 40; index++) {
		expect(names.has(`direct${index}`)).toBe(true);
		expect(names.has(`outer${index}`)).toBe(false);
	}
	expect(result.note).toBe(
		"complete: past the graph's 32-symbol limit, callers were followed through graph traces; only direct users are shown, since there are more than 32; pass maxDepth to follow their users too",
	);
});

test("a hub's references fallback keeps every use of a class, as the graph's trace does", () => {
	const fixture = createFixtureProject({
		"src/Widget.ts": "export class Widget {}\n",
		"src/uses.ts": [
			'import { Widget } from "./Widget.ts";',
			...Array.from({ length: 40 }, (_, index) => `export function create${index}() { return new Widget(); }`),
			...Array.from({ length: 40 }, (_, index) => `export function typed${index}(value: Widget) { return value; }`),
		].join("\n"),
	});
	const trace = (from: string) =>
		JSON.parse(runIn(fixture.root, "--json", JSON.stringify({ type: "trace", from, direction: "reverse" })).out)[0] as {
			shown: number;
			nodes: Array<{ name: string }>;
			edges: Array<{ kind: string }>;
		};
	try {
		// The graph's own trace follows type references, so the class's typed uses are callers too.
		const widget = trace("src/Widget.ts#Widget:class");
		expect(widget.shown).toBe(80);
		expect(widget.nodes.map(({ name }) => name)).toEqual(expect.arrayContaining(["create0", "typed0"]));
		expect(widget.edges.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["instantiates", "references"]));
	} finally {
		runIn(fixture.root, "stop");
		fixture.cleanup();
	}
});

test("a nested project keeps repository handles through the complete graph walk", () => {
	const repo = mkdtempSync(join(realpathSync("/tmp"), "sr-nested-"));
	const client = join(repo, "client");
	const nestedFiles: Record<string, string> = {
		"tsconfig.json": "{}\n",
		"src/target.ts": "export function target() {}\n",
		"src/callers.ts": [
			'import { target } from "./target.ts";',
			...Array.from({ length: 40 }, (_, index) => `export function direct${index}() { target(); }`),
			"export function outer() { direct0(); }",
		].join("\n"),
	};
	for (const [name, contents] of Object.entries(nestedFiles)) {
		mkdirSync(dirname(join(client, name)), { recursive: true });
		writeFileSync(join(client, name), contents);
	}
	Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
	try {
		const output = runIn(
			client,
			"--json",
			JSON.stringify({ type: "trace", from: "target", direction: "reverse", maxDepth: 2 }),
		);
		expect(output.code).toBe(0);
		const [result] = JSON.parse(output.out) as Array<{ nodes: Array<{ handle: string }> }>;
		expect(result.nodes.map(({ handle }) => handle)).toContain("client/src/callers.ts#outer:function");
	} finally {
		runIn(client, "stop");
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a forward trace at the graph's limit says so instead of advising a raise", () => {
	const [result] = JSON.parse(
		runIn(wide, "--json", JSON.stringify({ type: "trace", from: "hub", direction: "forward", maxNodes: 100 })).out,
	) as Array<{ raise?: string; note?: string }>;
	expect(result.raise).toBeUndefined();
	expect(result.note).toBe("truncated at the graph's 32-symbol limit; trace again from the symbols at its edge");
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

test("a completed trace from a hub stops at its direct users unless maxDepth says how deep", () => {
	const fixture = createFixtureProject({
		"src/target.ts": "export function target() {}\n",
		"src/callers.ts": [
			'import { target } from "./target.ts";',
			...Array.from({ length: 40 }, (_, index) => `export function direct${index}() { target(); }`),
			"export function second() { direct0(); }",
			"export function third() { second(); }",
			"export function fourth() { third(); }",
		].join("\n"),
	});
	const names = (request: Record<string, unknown>) =>
		(
			JSON.parse(
				runIn(
					fixture.root,
					"--json",
					JSON.stringify({ type: "trace", from: "target", direction: "reverse", ...request }),
				).out,
			)[0] as { nodes: Array<{ name: string }> }
		).nodes.map(({ name }) => name);
	try {
		const standard = names({});
		expect(standard).toContain("direct0");
		expect(standard).not.toContain("second");
		const three = names({ maxDepth: 3 });
		expect(three).toEqual(expect.arrayContaining(["direct0", "second", "third"]));
		expect(three).not.toContain("fourth");
		expect(names({ maxDepth: 4 })).toContain("fourth");
	} finally {
		runIn(fixture.root, "stop");
		fixture.cleanup();
	}
});
