// Check generic normalisation of fields, symbols, edges, and source ranges.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { normalizeResult, omittedKeys } from "../src/model.ts";
import { resolveNames } from "../src/names.ts";
import { createRangeIndex, type RangeIndex } from "../src/ranges.ts";
import { renderText } from "../src/render.ts";
import { startGraphClient, type GraphClient } from "../src/upstream.ts";
import { createFixtureProject } from "./fixture.ts";

const fixture = createFixtureProject({
	"app/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve" } }),
	"app/src/x.ts": "export function greet() {}\nexport class A { sayHello() {} }\nexport class B { sayHello() {} }",
	"app/src/View.tsx": [
		"type Row<T> = { id: string; value: T };",
		"export function View<T>({ rows }: { rows: Row<T>[] }) {",
		"  return <main><h1>Rows</h1><section>{rows.map((row) =>",
		"    <article key={row.id}><p>{String(row.value)}</p></article>",
		"  )}</section></main>;",
		"}",
	].join("\n"),
});
const root = join(fixture.root, "app");
let client: GraphClient;
let ranges: RangeIndex;

beforeAll(async () => {
	client = await startGraphClient({ root, tsconfig: join(root, "tsconfig.json") });
	ranges = createRangeIndex(root);
});

afterAll(async () => {
	await ranges?.close();
	await client?.close();
	fixture.cleanup();
});

test("unknown symbol lists and scalar fields survive without request-specific mapping", async () => {
	const result = await normalizeResult(
		{ type: "experimental" },
		{
			result: {
				type: "experimental",
				extraSymbols: [
					{ name: "greet", kind: "function", file: "src/x.ts", line: 1 },
					{ name: "View", kind: "function", file: "src/View.tsx", line: 2 },
				],
				unknownScalar: "survives",
				empty: [],
				audit: "omit",
			},
		},
		ranges,
	);
	expect(result.sections.extraSymbols).toEqual(["src/x.ts#greet:function", "src/View.tsx#View:function"]);
	expect(result.sections.unknownScalar).toBe("survives");
	expect(result.sections).not.toHaveProperty("empty");
	expect(result.sections).not.toHaveProperty("audit");
	expect(result.nodes.find(({ name }) => name === "View")?.ranges).toEqual([{ start: 2, end: 6 }]);
	expect(omittedKeys).toContain("sourceSpan");
});

test("handle-only symbols, sites, edges, and empty fields normalise", async () => {
	const result = await normalizeResult(
		{ type: "trace", from: "greet" },
		{
			result: {
				type: "trace",
				start: { id: "src/x.ts#greet:function", name: "greet" },
				hops: [
					{
						from: "src/x.ts#A.sayHello:method",
						to: "src/x.ts#greet:function",
						kind: "calls",
						evidence: { file: "src/x.ts", startLine: 2, startCol: 10, endLine: 2, endCol: 18 },
					},
				],
				sites: [{ name: "greet", file: "src/x.ts", startLine: 2, endLine: 2 }],
				steps: ["duplicate"],
				unknown: {},
			},
		},
		ranges,
	);
	expect(result.nodes.map(({ handle }) => handle)).toContain("src/x.ts#A.sayHello:method");
	expect(result.nodes.find(({ site }) => site)?.site).toEqual({ start: 2, end: 2 });
	expect(result.edges).toEqual([
		{
			from: "src/x.ts#A.sayHello:method",
			to: "src/x.ts#greet:function",
			kind: "calls",
			at: { file: "src/x.ts", line: 2 },
		},
	]);
	expect(result.sections.hops).toEqual([0]);
	expect(result.sections).not.toHaveProperty("steps");
	expect(result.sections).not.toHaveProperty("unknown");
});

test("tour steps become edges only when both declaration names resolve uniquely", async () => {
	const request = { type: "tour", reinterpretations: ["greet"] };
	const result = await normalizeResult(
		request,
		{
			result: {
				type: "tour",
				entrypoints: [{ id: "src/x.ts#greet:function", name: "greet", file: "src/x.ts" }],
				nearby: [{ id: "src/x.ts#A.sayHello:method", name: "A.sayHello", file: "src/x.ts" }],
				primaryFlow: [
					{
						steps: [
							"A.sayHello -[calls at src/x.ts:2]-> greet",
							"unknown -[calls at src/x.ts:2]-> greet",
							"malformed step",
						],
					},
				],
			},
		},
		ranges,
	);
	expect(result.edges).toEqual([
		{
			from: "src/x.ts#A.sayHello:method",
			to: "src/x.ts#greet:function",
			kind: "calls",
			at: { file: "src/x.ts", line: 2 },
		},
	]);
	expect((result.sections.primaryFlow as { steps: unknown[] }[])[0].steps).toEqual([
		0,
		"unknown -[calls at src/x.ts:2]-> greet",
		"malformed step",
	]);
	expect(renderText(result, { color: false })).toContain("A.sayHello → greet  calls at x.ts:2");
	expect(renderText(result, { color: false })).toContain("unknown -[calls at src/x.ts:2]-> greet");
});

test("names resolve in one live lookup batch; ambiguous and unknown names suggest handles", async () => {
	let batches = 0;
	const counted: GraphClient = {
		...client,
		batch: async (requests) => {
			batches++;
			return client.batch(requests);
		},
	};
	const resolved = await resolveNames(counted, [
		{ type: "details", handles: ["greet"] },
		{ type: "trace", from: "greet", to: "src/x.ts#A.sayHello:method" },
	]);
	expect(batches).toBe(1);
	expect(resolved[0].handles).toEqual(["src/x.ts#greet:function"]);
	expect(resolved[1].from).toBe("src/x.ts#greet:function");
	expect(resolved[1].to).toBe("src/x.ts#A.sayHello:method");
	expect(await resolveNames(counted, [{ type: "trace", from: "src/x.ts#greet:function" }])).toEqual([
		{ type: "trace", from: "src/x.ts#greet:function" },
	]);
	await expect(resolveNames(client, [{ type: "trace", from: "sayHello" }])).rejects.toThrow(
		"sayHello is ambiguous; use a handle: src/x.ts#A.sayHello:method, src/x.ts#B.sayHello:method",
	);
	await expect(resolveNames(client, [{ type: "trace", from: "gret" }])).rejects.toThrow(
		"gret not found; nearest: src/x.ts#greet:function",
	);
	await expect(resolveNames(client, [{ type: "trace", from: "Missing.greet" }])).rejects.toThrow(
		"Missing.greet not found; nearest: src/x.ts#greet:function",
	);
});

test("unknown names in an empty project have no empty nearest suffix", async () => {
	const empty = createFixtureProject({
		"client/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve" } }),
		"client/src/View.tsx": "export {};",
	});
	const project = join(empty.root, "client");
	const graph = await startGraphClient({ root: project, tsconfig: join(project, "tsconfig.json") });
	try {
		await expect(resolveNames(graph, [{ type: "trace", from: "DefinitelyMissing" }])).rejects.toThrow(
			/^DefinitelyMissing not found$/,
		);
	} finally {
		await graph.close();
		empty.cleanup();
	}
});

test("file-qualified names resolve past ten matches and suggest from their own file", async () => {
	const files: Record<string, string> = {};
	for (let index = 0; index < 15; index++)
		files[`src/${index.toString().padStart(2, "0")}.ts`] = "export class C { get() {} }\n";
	files["src/14.ts"] = "export class C { get() {} getter() {} }\n";
	const wide = createFixtureProject(files);
	const graph = await startGraphClient({ root: wide.root, tsconfig: join(wide.root, "tsconfig.json") });
	try {
		expect((await resolveNames(graph, [{ type: "trace", from: "src/14.ts#C.get" }]))[0].from).toBe(
			"src/14.ts#C.get:method",
		);
		await expect(resolveNames(graph, [{ type: "trace", from: "src/14.ts#C.gett" }])).rejects.toThrow(
			"nearest: src/14.ts#C.get:method",
		);
	} finally {
		await graph.close();
		wide.cleanup();
	}
});

test("repository lookup has exact full text", async () => {
	const repo = join(import.meta.dir, "../../..");
	const project = { root: repo, tsconfig: join(repo, "tsconfig.json") };
	const live = await startGraphClient(project);
	const index = createRangeIndex(repo);
	try {
		const request = { type: "lookup", query: "createDeclarationParser", limit: 1 };
		const value = (await live.query(request)).value;
		const result = await normalizeResult(request, value, index);
		expect(renderText(result, { color: false })).toMatch(
			/^lookup for createDeclarationParser: 1 shown \(truncated; raise lookup.limit\)\n\nhits\n  = createDeclarationParser  exported function  packages\/sightread\/src\/ranges\.ts:\d+-\d+$/,
		);
	} finally {
		await index.close();
		await live.close();
	}
}, 30_000);
