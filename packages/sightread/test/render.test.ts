// Check complete text for live lookup, trace, details, tour, and overview results.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeResult, type GraphResult } from "../src/model.ts";
import { createRangeIndex, parseDeclarations, type RangeIndex } from "../src/ranges.ts";
import { renderText } from "../src/render.ts";
import { startGraphClient, type GraphClient } from "../src/upstream.ts";
import { createFixtureProject } from "./fixture.ts";

const fixture = createFixtureProject({
	"client/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve" } }),
	"client/src/model.ts": [
		"export function greet(name: string) { return `Hi ${name}`; }",
		'export function caller() { return greet("Ada"); }',
		"export class Greeter {",
		"  sayHello(value: string): string;",
		"  sayHello(value: number): number;",
		"  sayHello(value: string | number) { return value; }",
		"}",
	].join("\n"),
	"client/src/View.tsx": [
		"type Row<T> = { id: string; value: T };",
		"export function View<T>({ rows }: { rows: Row<T>[] }) {",
		'  return <main className="list"><h1>Rows</h1><section>{rows.map((row) =>',
		"    <article key={row.id}><header>{row.id}</header><p>{String(row.value)}</p></article>",
		"  )}</section></main>;",
		"}",
	].join("\n"),
});
const root = join(fixture.root, "client");
let client: GraphClient;
let ranges: RangeIndex;
const outputs = new Map<string, string>();

beforeAll(async () => {
	client = await startGraphClient({ root, tsconfig: join(root, "tsconfig.json") });
	ranges = createRangeIndex(root);
	for (const request of [
		{ type: "lookup", query: "greet", limit: 3 },
		{ type: "trace", from: "src/model.ts#greet:function", direction: "reverse", maxNodes: 6 },
		{ type: "details", handles: ["src/model.ts#greet:function", "src/model.ts#Greeter:class"], neighbors: true },
		{ type: "tour", reinterpretations: ["greet"], limit: 2 },
		{ type: "overview", aspect: "all" },
	]) {
		const value = (await client.query(request)).value;
		outputs.set(request.type, renderText(await normalizeResult(request, value, ranges), { color: false }));
	}
});

afterAll(async () => {
	await ranges?.close();
	await client?.close();
	fixture.cleanup();
});

test("lookup ranked text is complete", () => {
	expect(outputs.get("lookup")).toBe(
		[
			"lookup for greet: 2 shown",
			"",
			"hits",
			"  = greet    exported function  src/model.ts:1-1",
			"    Greeter  exported class     src/model.ts:3-7",
		].join("\n"),
	);
});

test("reverse trace text is complete, with each link on the row of the symbol it starts from", () => {
	expect(outputs.get("trace")).toBe(
		[
			"trace reverse from greet: 1 shown in 1 file",
			"",
			"src/model.ts",
			"  1-1  greet   exported function",
			"  2-2  caller  exported function  calls greet :2",
		].join("\n"),
	);
});

test("details text is complete, with members and what uses each symbol", () => {
	expect(outputs.get("details")).toBe(
		[
			"details: 2 shown",
			"",
			"src/model.ts",
			"            1-1  greet             exported function",
			"            2-2  caller            exported function",
			"            3-7  Greeter           exported class",
			"  4-4, 5-5, 6-6  Greeter.sayHello  method",
			"",
			"dependedOnBy",
			"  caller → greet  calls at model.ts:2",
			"",
			"members",
			"  Greeter.sayHello",
		].join("\n"),
	);
});

test("tour text is complete, including sites and nested flow", () => {
	expect(outputs.get("tour")).toBe(
		[
			"tour for greet: 2 shown",
			"",
			"entrypoints",
			"    greet   exported function  src/model.ts:1-1",
			"    caller  exported function  src/model.ts:2-2",
			"",
			"src/model.ts",
			"  2  caller  reference",
			"  2  greet   reference",
			"",
			"primaryFlow",
			"  start: caller",
			"  steps",
			"    caller → greet  calls at model.ts:2",
			"",
			"nearby",
			"  caller",
			"  greet",
		].join("\n"),
	);
});

test("overview text is complete", () => {
	expect(outputs.get("overview")).toBe(
		[
			"overview: 2 files, 9 symbols, 13 relationships",
			"",
			"layers",
			"  src  2 files  4 exported",
			"",
			"hotspots",
			"  1. View    exported function  src/View.tsx:2-6  fan-in 0, fan-out 2",
			"  2. Row     type               src/View.tsx:1-1  fan-in 1, fan-out 0",
			"  3. caller  exported function  src/model.ts:2-2  fan-in 0, fan-out 1",
			"  4. greet   exported function  src/model.ts:1-1  fan-in 1, fan-out 0",
			"",
			"publicApi",
			"  1. View     exported function  src/View.tsx:2-6",
			"  2. caller   exported function  src/model.ts:2-2",
			"  3. greet    exported function  src/model.ts:1-1",
			"  4. Greeter  exported class     src/model.ts:3-7",
		].join("\n"),
	);
});

test("overview keeps ranked sections, relationship counts, and omits the absolute project", async () => {
	const request = { type: "overview" };
	const value = {
		result: {
			type: "overview",
			project: root,
			counts: { files: 2, nodes: 9, edges: 13, byKind: { function: 3 } },
			layers: [{ dir: "src", files: 2, exported: 4 }],
			hotspots: [
				{
					id: "src/model.ts#caller:function",
					name: "caller",
					kind: "function",
					file: "src/model.ts",
					line: 2,
					fanIn: 5,
					fanOut: 1,
				},
				{
					id: "src/model.ts#greet:function",
					name: "greet",
					kind: "function",
					file: "src/model.ts",
					line: 1,
					fanIn: 2,
					fanOut: 0,
				},
			],
			publicApi: [
				{ id: "src/model.ts#greet:function", name: "greet", kind: "function", file: "src/model.ts", line: 1 },
			],
		},
	};
	const model = await normalizeResult(request, value, ranges);
	expect(model.sections.hotspots).toEqual(["src/model.ts#caller:function", "src/model.ts#greet:function"]);
	expect(model.sections.publicApi).toEqual(["src/model.ts#greet:function"]);
	expect(renderText(model, { color: false })).toBe(
		[
			"overview: 2 files, 9 symbols, 13 relationships",
			"",
			"layers",
			"  src  2 files  4 exported",
			"",
			"hotspots",
			"  1. caller  exported function  src/model.ts:2-2  fan-in 5, fan-out 1",
			"  2. greet   exported function  src/model.ts:1-1  fan-in 2, fan-out 0",
			"",
			"publicApi",
			"  1. greet  exported function  src/model.ts:1-1",
		].join("\n"),
	);
});

test("TSX ranges use JSX parsing, which differs from TS parsing", async () => {
	const source = readFileSync(join(root, "src/View.tsx"), "utf8");
	const tsx = await parseDeclarations("View.tsx", source);
	const ts = await parseDeclarations("View.ts", source);
	expect(tsx.find(({ name }) => name === "View")?.end).toBe(6);
	expect(ts.find(({ name }) => name === "View")?.end).toBe(5);
	expect(outputs.get("overview")).toContain("src/View.tsx:2-6");
});

test("test sites use their line and kind in a file group, and file:line in sections", () => {
	const result: GraphResult = {
		type: "tour",
		shown: 1,
		nodes: [
			{
				handle: "src/long.ts#thing:function",
				name: "thing",
				kind: "function",
				file: "src/long.ts",
				ranges: [{ start: 12000, end: 12345 }],
			},
			{
				handle: "test/thing.test.ts#thing.test.ts:site:8-8",
				name: "thing.test.ts",
				file: "test/thing.test.ts",
				ranges: null,
				site: { start: 8, end: 8 },
			},
		],
		edges: [],
		sections: { tests: ["test/thing.test.ts#thing.test.ts:site:8-8"] },
	};
	expect(renderText(result, { color: false })).toBe(
		[
			"tour: 1 shown",
			"",
			"src/long.ts",
			"  12000-12345  thing  function",
			"test/thing.test.ts",
			"  8    test",
			"",
			"tests",
			"  thing.test.ts:8",
		].join("\n"),
	);
});

test("numbered lists stay aligned past nine rows", () => {
	const nodes = Array.from({ length: 10 }, (_, i) => ({
		handle: `src/a.ts#f${i}:function`,
		name: `f${i}`,
		kind: "function",
		file: "src/a.ts",
		ranges: [{ start: i * 10 + 1, end: i * 10 + 1 }],
		fanIn: 10 - i,
		fanOut: 0,
	}));
	const result = {
		type: "overview",
		shown: 10,
		nodes,
		edges: [],
		sections: { hotspots: nodes.map((node) => node.handle) },
	} as unknown as GraphResult;
	const rows = renderText(result, { color: false })
		.split("\n")
		.filter((line) => /^\s+\d+\. /.test(line));
	expect(rows).toHaveLength(10);
	expect(new Set(rows.map((row) => row.indexOf("f")))).toEqual(new Set([rows[0].indexOf("f")]));
	expect(new Set(rows.map((row) => row.indexOf("fan-in")))).toEqual(new Set([rows[0].indexOf("fan-in")]));
	expect(rows[9].startsWith("  10. f9")).toBe(true);
	expect(rows[0].startsWith("   1. f0")).toBe(true);
});

const symbol = (name: string, file = "src/model.ts") => ({
	id: `${file}#${name}:function`,
	name,
	file,
	kind: "function",
});
const hop = (from: string, to: string, file: string, line: number) => ({
	from: `src/model.ts#${from}:function`,
	to: `src/model.ts#${to}:function`,
	kind: "calls",
	evidence: { file, startLine: line, endLine: line },
});

test("a trace keeps a link on its own line when its call is in another file, and a path keeps its links in order", async () => {
	const value = {
		result: {
			type: "trace",
			start: symbol("greet"),
			direction: "reverse",
			reached: [symbol("caller")],
			hops: [hop("caller", "greet", "src/model.ts", 2), hop("caller", "greet", "src/View.tsx", 1)],
		},
	};
	const open = renderText(
		await normalizeResult({ type: "trace", from: "greet", direction: "reverse" }, value, ranges),
		{ color: false },
	);
	expect(open).toContain("  2-2  caller  exported function  calls greet :2\n");
	expect(open).toEndWith("hops\n  caller → greet  calls at View.tsx:1");
	const path = renderText(await normalizeResult({ type: "trace", from: "caller", to: "greet" }, value, ranges), {
		color: false,
	});
	expect(path).toContain("  2-2  caller  exported function\n");
	expect(path).toContain("hops\n  caller → greet  calls at model.ts:2\n  caller → greet  calls at View.tsx:1");
	const noted = await normalizeResult({ type: "trace", from: "caller", to: "greet" }, value, ranges);
	noted.note = "truncated at the graph's 32-symbol limit";
	expect(renderText(noted, { color: false })).toContain("hops\n  caller → greet  calls at model.ts:2");
});
