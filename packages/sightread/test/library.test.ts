// Exercise the library through the real background server.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openGraph } from "../src/index.ts";
import { renderText } from "../src/render.ts";
import { listServers, stopServer } from "../src/server/client.ts";
import { startGraphClient } from "../src/upstream.ts";
import { createFixtureProject } from "./fixture.ts";

const edgeSource = [
	"export function useTable(x: unknown) {}",
	"export function tabs(x: unknown) {\tuseTable(x); }",
	"export function bmp(x: unknown) { const é = 1; useTable(x); }",
	'export function astral(x: unknown) { const face = "😀"; useTable(x); }',
	"export function first(x: unknown) { useTable(x); } export function second(x: unknown) { useTable(x); }",
	"",
].join("\r\n");
const runtime = mkdtempSync("/tmp/sightread-library-runtime-");
process.env.XDG_RUNTIME_DIR = runtime;
const fixture = createFixtureProject({
	"app/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve" } }),
	"app/src/x.ts": "export function greet() {}\nexport function caller() { greet(); }",
	"app/src/edges.ts": edgeSource,
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

afterAll(async () => {
	await stopServer({ root, tsconfig: join(root, "tsconfig.json") });
	fixture.cleanup();
	rmSync(runtime, { recursive: true, force: true });
});

test("openGraph returns models, resolves names, and leaves the server running on close", async () => {
	const graph = await openGraph({ cwd: root });
	const single = await graph.query({ type: "lookup", query: "greet" });
	expect(single.type).toBe("lookup");
	expect(single.nodes.some(({ name }) => name === "greet")).toBe(true);
	const [trace, details] = await graph.query([
		{ type: "trace", from: "greet", direction: "reverse" },
		{ type: "details", handles: ["greet"] },
	]);
	expect(trace.edges.some(({ kind }) => kind === "calls")).toBe(true);
	expect(details.nodes.some(({ name }) => name === "greet")).toBe(true);
	const [missing, found] = await graph.query([
		{ type: "trace", from: "NoSuchNameAtAll" },
		{ type: "lookup", query: "greet" },
	]);
	expect(missing.type).toBe("trace");
	expect(missing.error).toStartWith("NoSuchNameAtAll not found");
	expect(found.nodes.some(({ name }) => name === "greet")).toBe(true);
	await graph.close();
	expect((await listServers()).some(({ project }) => project === root)).toBe(true);
	await expect(graph.query({ type: "lookup", query: "greet" })).rejects.toThrow("Graph is closed");
}, 30_000);

test("edge spans slice call names with UTF-16 columns after tabs, BMP, astral, and CRLF text", async () => {
	const direct = await startGraphClient({ root, tsconfig: join(root, "tsconfig.json") });
	try {
		const raw = (await direct.query({ type: "trace", from: "useTable", direction: "reverse" })).value as {
			result: { hops: { from: string; evidence: unknown }[] };
		};
		expect(raw.result.hops.map(({ from, evidence }) => [from, evidence])).toEqual([
			["src/edges.ts#tabs:function", { file: "src/edges.ts", startLine: 2, startCol: 36, endLine: 2, endCol: 44 }],
			["src/edges.ts#bmp:function", { file: "src/edges.ts", startLine: 3, startCol: 49, endLine: 3, endCol: 57 }],
			["src/edges.ts#astral:function", { file: "src/edges.ts", startLine: 4, startCol: 59, endLine: 4, endCol: 67 }],
			["src/edges.ts#first:function", { file: "src/edges.ts", startLine: 5, startCol: 37, endLine: 5, endCol: 45 }],
			["src/edges.ts#second:function", { file: "src/edges.ts", startLine: 5, startCol: 89, endLine: 5, endCol: 97 }],
		]);
	} finally {
		await direct.close();
	}
	const graph = await openGraph({ cwd: root });
	try {
		const result = await graph.query({ type: "trace", from: "useTable", direction: "reverse" });
		const edges = result.edges.filter(({ kind, to }) => kind === "calls" && to === "src/edges.ts#useTable:function");
		expect(edges).toHaveLength(5);
		const lines = edgeSource.split("\r\n");
		for (const edge of edges) {
			const at = edge.at;
			expect(at?.file).toBe("src/edges.ts");
			expect(at?.col).toBeNumber();
			expect(at?.endLine).toBeNumber();
			expect(at?.endCol).toBeNumber();
			if (!at?.col || !at.endLine || !at.endCol) throw new Error("missing edge span");
			const start = lines.slice(0, at.line - 1).join("\n").length + (at.line > 1 ? 1 : 0) + at.col - 1;
			const end = lines.slice(0, at.endLine - 1).join("\n").length + (at.endLine > 1 ? 1 : 0) + at.endCol - 1;
			expect(lines.join("\n").slice(start, end)).toBe("useTable");
		}
		const sameLine = edges.filter(({ at }) => at?.line === 5);
		expect(sameLine).toHaveLength(2);
		expect(sameLine[0].at?.col).not.toBe(sameLine[1].at?.col);
		expect(renderText(result, { color: false }).match(/calls useTable :5/g)).toHaveLength(2);
		expect(JSON.parse(JSON.stringify(result)).edges).toEqual(result.edges);
	} finally {
		await graph.close();
	}
}, 30_000);
