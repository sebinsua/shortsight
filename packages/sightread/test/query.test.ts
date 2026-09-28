// Check batch ordering, empty results, and output modes.
import { expect, test } from "bun:test";
import { runQuery } from "../src/query.ts";
import type { RangeIndex } from "../src/ranges.ts";
import type { ReferenceIndex } from "../src/references.ts";
import type { GraphClient, QueryResult } from "../src/upstream.ts";

const values = [{ result: { type: "lookup", hits: [] }, audit: "keep" }, [{ type: "text", text: "second" }]];
const ranges: RangeIndex = {
	declarations: async () => undefined,
	rangesFor: async () => undefined,
	exportedFor: async () => false,
	close: async () => {},
};
const client: GraphClient = {
	requestTypes: () => [],
	query: async (request): Promise<QueryResult> => {
		if (request.type === "lookup") await Bun.sleep(25);
		return { value: request.type === "lookup" ? values[0] : values[1], isError: false };
	},
	batch: async (requests) => Promise.all(requests.map((request) => client.query(request))),
	close: async () => {},
};
const requests = [{ type: "lookup" }, { type: "escape" }];
const callerHandle = (index: number) => `src/a.ts#caller${index}:function`;
const symbol = (id: string) => ({ id, name: id.split("#")[1].split(":")[0], file: "src/a.ts", kind: "function" });

test("batch returns input order with numbered headers", async () => {
	expect(await runQuery({ client, ranges }, requests, { json: false })).toBe(
		"=== 1: lookup ===\nlookup: 0 shown\n\n(none)\n\n=== 2: escape ===\nescape: 0 shown\n\n(none)",
	);
});

test("a single request has no header", async () => {
	expect(await runQuery({ client, ranges }, requests.slice(0, 1), { json: false })).toBe("lookup: 0 shown\n\n(none)");
});

test("JSON prints models and raw preserves upstream values", async () => {
	const models = JSON.parse(await runQuery({ client, ranges }, requests, { mode: "json" })) as {
		type: string;
		shown: number;
	}[];
	expect(models.map(({ type, shown }) => [type, shown])).toEqual([
		["lookup", 0],
		["escape", 0],
	]);
	expect(await runQuery({ client, ranges }, requests, { mode: "raw" })).toBe(
		values.map((value) => JSON.stringify(value)).join("\n"),
	);
});

test("unchanged input is byte deterministic", async () => {
	const first = await runQuery({ client, ranges }, requests, { mode: "text" });
	expect(await runQuery({ client, ranges }, requests, { mode: "text" })).toBe(first);
});

test("complete reverse trace follows graph handles, edges, and cycles", async () => {
	const target = "src/a.ts#target:function";
	const nested = "src/a.ts#createRouterInner.step:function";
	const override = "src/a.ts#Child.run:method";
	const seen: string[] = [];
	const traceClient: GraphClient = {
		...client,
		query: async (request) => {
			const from = String(request.from);
			if (request.maxDepth !== 1)
				return {
					value: {
						result: {
							type: "trace",
							start: { id: target, name: "target", file: "src/a.ts", kind: "function" },
							reached: [],
							truncated: true,
						},
					},
					isError: false,
				};
			seen.push(from);
			const callers = from === target ? [nested, override] : from === nested ? [target] : [];
			return {
				value: {
					result: {
						type: "trace",
						start: { id: from, name: from.split("#")[1].split(":")[0], file: "src/a.ts", kind: from.split(":")[1] },
						reached: callers.map((id) => ({
							id,
							name: id.split("#")[1].split(":")[0],
							file: "src/a.ts",
							kind: id.split(":")[1],
						})),
						hops: callers.map((caller) => ({
							from: caller,
							to: from,
							kind: caller === override ? "overrides" : "calls",
							evidence: { file: "src/a.ts", startLine: 2, startCol: 1, endLine: 2, endCol: 5 },
						})),
						truncated: false,
					},
				},
				isError: false,
			};
		},
	};
	const [result] = JSON.parse(
		await runQuery(
			{ client: traceClient, ranges, root: "/tmp" },
			[{ type: "trace", from: target, direction: "reverse" }],
			{ mode: "json" },
		),
	) as Array<{
		shown: number;
		raise?: string;
		note?: string;
		nodes: Array<{ handle: string }>;
		edges: Array<{ from: string; to: string; kind: string }>;
	}>;
	expect(result.raise).toBeUndefined();
	expect(result.shown).toBe(2);
	expect(result.nodes.map((node) => node.handle)).toContain(nested);
	expect(result.nodes.map((node) => node.handle)).toContain(override);
	expect(result.edges.map((edge) => [edge.from, edge.to, edge.kind])).toContainEqual([nested, target, "calls"]);
	expect(result.edges.map((edge) => [edge.from, edge.to, edge.kind])).toContainEqual([override, target, "overrides"]);
	expect(result.edges.map((edge) => [edge.from, edge.to, edge.kind])).toContainEqual([target, nested, "calls"]);
	expect(seen).toEqual([target, nested, override]);
	expect(result.note).toContain("complete");
});

test("reverse trace honors maxNodes, maxDepth, and counts unresolved symbols", async () => {
	const target = "src/a.ts#target:function";
	const missing = "src/a.ts#missing:function";
	const calls: string[] = [];
	const traceClient: GraphClient = {
		...client,
		query: async (request) => {
			if (request.maxDepth !== 1)
				return {
					value: {
						result: {
							type: "trace",
							start: { id: target, name: "target", file: "src/a.ts", kind: "function" },
							reached: [],
							truncated: true,
						},
					},
					isError: false,
				};
			const from = String(request.from);
			calls.push(from);
			if (from === missing) throw new Error("symbol not found");
			if (from.includes("#leaf"))
				return { value: { result: { type: "trace", reached: [], hops: [] } }, isError: false };
			const index = from === target ? -1 : Number(/caller(\d+)/.exec(from)?.[1]);
			const next = index < 39 ? [callerHandle(index + 1)] : [];
			// The target is a hub: forty leaf callers besides the chain, so the node limit can be reached.
			if (from === target)
				next.push(missing, ...Array.from({ length: 40 }, (_, leaf) => `src/a.ts#leaf${leaf}:function`));
			return {
				value: {
					result: {
						type: "trace",
						start: { id: from, name: from.split("#")[1].split(":")[0], file: "src/a.ts", kind: "function" },
						reached: next.map((id) => ({
							id,
							name: id.split("#")[1].split(":")[0],
							file: "src/a.ts",
							kind: "function",
						})),
						hops: next.map((caller) => ({ from: caller, to: from, kind: "calls" })),
						truncated: false,
					},
				},
				isError: false,
			};
		},
	};
	const references: ReferenceIndex = {
		query: async () => {
			throw new Error("unexpected references query");
		},
		close: async () => {},
	};
	const context = { client: traceClient, ranges, references, root: "/tmp" };
	const ask = async (maxNodes?: number, maxDepth?: number) =>
		(
			JSON.parse(
				await runQuery(
					context,
					[
						{
							type: "trace",
							from: target,
							direction: "reverse",
							...(maxNodes === undefined ? {} : { maxNodes }),
							...(maxDepth === undefined ? {} : { maxDepth }),
						},
					],
					{ mode: "json" },
				),
			) as Array<{ shown: number; note?: string; raise?: string }>
		)[0];
	expect((await ask(8)).raise).toBe("trace.maxNodes");
	expect((await ask(32)).raise).toBe("trace.maxNodes");
	expect(calls).toEqual([]);
	expect((await ask(35)).shown).toBe(35);
	expect((await ask(35)).note).toContain("stopped at 35 symbols");
	// One level: the chain's first caller, the missing symbol and the forty leaves.
	expect((await ask(undefined, 1)).shown).toBe(42);
	expect((await ask(undefined, 2)).shown).toBe(43);
	// With more direct users than the graph's limit, the default is one level; asked, never more than eight.
	expect((await ask()).shown).toBe(42);
	expect((await ask()).note).toContain("only direct users are shown");
	const complete = await ask(undefined, 3);
	expect(complete.shown).toBe(44);
	expect(complete.note).toContain("1 symbol skipped");
	expect((await ask(undefined, 20)).shown).toBe(49);
});

test("a start with exactly the graph's limit of direct users keeps the default depth", async () => {
	const target = "src/a.ts#target:function";
	const direct = Array.from({ length: 32 }, (_, index) => `src/a.ts#direct${index}:function`);
	const traceClient: GraphClient = {
		...client,
		query: async (request) => {
			const from = String(request.from);
			if (request.maxDepth !== 1)
				return {
					value: { result: { type: "trace", start: symbol(target), reached: [], truncated: true } },
					isError: false,
				};
			// Each direct user has a caller of its own, so the graph flags the one-level trace as truncated.
			const callers = from === target ? direct : from.includes("#direct") ? [from.replace("direct", "outer")] : [];
			return {
				value: {
					result: {
						type: "trace",
						reached: callers.map(symbol),
						hops: callers.map((caller) => ({ from: caller, to: from, kind: "calls" })),
						truncated: from === target,
					},
				},
				isError: false,
			};
		},
	};
	const [result] = JSON.parse(
		await runQuery(
			{ client: traceClient, ranges, root: "/tmp" },
			[{ type: "trace", from: target, direction: "reverse" }],
			{ mode: "json" },
		),
	) as Array<{ nodes: Array<{ name: string }>; note?: string }>;
	expect(result.nodes.map(({ name }) => name)).toContain("outer0");
	expect(result.note).not.toContain("only direct users");
});

test("--in keeps each details neighbour list pointing at its own edges", async () => {
	const neighbour = (id: string, relation: string, line: number) => ({
		...symbol(id),
		file: id.split("#")[0],
		relation,
		evidence: { file: id.split("#")[0], startLine: line, startCol: 1, endLine: line, endCol: 2 },
	});
	const detailsClient: GraphClient = {
		...client,
		query: async () => ({
			value: {
				result: {
					type: "details",
					nodes: [
						{
							...symbol("src/a.ts#get:function"),
							calls: [neighbour("src/a.ts#normalise:function", "calls", 2)],
							dependedOnBy: [
								neighbour("src/b.ts#outside:function", "calls", 3),
								neighbour("src/a.ts#inside:function", "calls", 4),
							],
						},
					],
				},
			},
			isError: false,
		}),
	};
	const [result] = JSON.parse(
		await runQuery(
			{ client: detailsClient, ranges, root: "/tmp" },
			[{ type: "details", handles: ["src/a.ts#get:function"], neighbors: true }],
			{ mode: "json", in: "src/a.ts" },
		),
	) as Array<{ edges: Array<{ from: string; to: string }>; sections: Record<string, number[]> }>;
	const named = (key: string) =>
		result.sections[key].map((index) => `${result.edges[index].from} → ${result.edges[index].to}`);
	expect(named("calls")).toEqual(["src/a.ts#get:function → src/a.ts#normalise:function"]);
	expect(named("dependedOnBy")).toEqual(["src/a.ts#inside:function → src/a.ts#get:function"]);
});
