// Check batch ordering, empty results, and output modes.
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

// A graph that walks callers as the real one does: breadth first, to a depth, within a symbol and hop budget.
function callerGraph(callers: Record<string, Array<{ id: string; kind?: string }>>) {
	const sent: Record<string, unknown>[] = [];
	const graph: GraphClient = {
		...client,
		query: async (request) => {
			sent.push(request);
			const from = String(request.from);
			const maxDepth = typeof request.maxDepth === "number" ? request.maxDepth : 3;
			const maxNodes = typeof request.maxNodes === "number" ? request.maxNodes : 12;
			const reached = new Map<string, Record<string, unknown>>();
			const hops: Record<string, unknown>[] = [];
			let truncated = false;
			for (let level = 0, frontier = [from]; frontier.length; level++) {
				const next: string[] = [];
				for (const target of frontier) {
					const users = callers[target] ?? [];
					if (level >= maxDepth) {
						if (users.length) truncated = true;
						continue;
					}
					for (const { id, kind } of users) {
						const hop = { from: id, to: target, kind: kind ?? "calls", depth: level + 1 };
						if (id === from || reached.has(id)) {
							if (hops.length >= maxNodes * 2) truncated = true;
							else hops.push(hop);
							continue;
						}
						if (reached.size >= maxNodes || hops.length >= maxNodes * 2) {
							truncated = true;
							continue;
						}
						reached.set(id, { ...symbol(id), kind: id.split(":")[1], depth: level + 1 });
						hops.push(hop);
						next.push(id);
					}
				}
				frontier = next;
			}
			return {
				value: {
					result: {
						type: "trace",
						start: { ...symbol(from), kind: from.split(":")[1] },
						direction: request.direction,
						reached: [...reached.values()],
						hops,
						truncated,
					},
				},
				isError: false,
			};
		},
	};
	return { graph, sent };
}

type TraceModel = {
	shown: number;
	raise?: string;
	note?: string;
	nodes: Array<{ handle: string; name: string }>;
	edges: Array<{ from: string; to: string; kind: string }>;
};

const traceWith = async (context: Parameters<typeof runQuery>[0], request: Record<string, unknown>) =>
	(
		JSON.parse(
			await runQuery(context, [{ type: "trace", direction: "reverse", ...request }], { mode: "json" }),
		) as TraceModel[]
	)[0]!;

test("a reverse trace is one graph request with sightread's budget, and keeps cycles and dispatch edges", async () => {
	const target = "src/a.ts#target:function";
	const nested = "src/a.ts#createRouterInner.step:function";
	const override = "src/a.ts#Child.run:method";
	const { graph, sent } = callerGraph({
		[target]: [{ id: nested }, { id: override, kind: "overrides" }],
		[nested]: [{ id: target }],
	});
	const result = await traceWith({ client: graph, ranges, root: "/tmp" }, { from: target });
	expect(sent).toEqual([{ type: "trace", from: target, direction: "reverse", maxNodes: 1000, maxDepth: 3 }]);
	expect(result.raise).toBeUndefined();
	expect(result.note).toBeUndefined();
	expect(result.shown).toBe(2);
	expect(result.edges.map((edge) => [edge.from, edge.to, edge.kind])).toEqual(
		expect.arrayContaining([
			[nested, target, "calls"],
			[override, target, "overrides"],
			[target, nested, "calls"],
		]),
	);
	// Raw output stays the graph's own answer to the request as given.
	sent.length = 0;
	await runQuery({ client: graph, ranges, root: "/tmp" }, [{ type: "trace", from: target, direction: "reverse" }], {
		mode: "raw",
	});
	expect(sent).toEqual([{ type: "trace", from: target, direction: "reverse" }]);
});

test("reverse trace honors maxNodes and maxDepth, and says which bound cut it", async () => {
	const target = "src/a.ts#target:function";
	// A chain of forty callers, and forty leaves besides it on the target, so it's a hub.
	const chain = Array.from({ length: 40 }, (_, index) => callerHandle(index));
	const { graph } = callerGraph({
		[target]: [
			{ id: chain[0]! },
			...Array.from({ length: 40 }, (_, leaf) => ({ id: `src/a.ts#leaf${leaf}:function` })),
		],
		...Object.fromEntries(chain.slice(0, -1).map((id, index) => [id, [{ id: chain[index + 1]! }]])),
	});
	const context = { client: graph, ranges, root: "/tmp" };
	const ask = (maxNodes?: number, maxDepth?: number) =>
		traceWith(context, {
			from: target,
			...(maxNodes === undefined ? {} : { maxNodes }),
			...(maxDepth === undefined ? {} : { maxDepth }),
		});
	const eight = await ask(8);
	expect([eight.shown, eight.raise]).toEqual([8, "trace.maxNodes"]);
	const many = await ask(35);
	expect([many.shown, many.raise]).toEqual([35, "trace.maxNodes"]);
	expect(many.note).toBe(
		"stopped at 35 symbols; trace from a narrower symbol; only direct users are shown, since there are more than 32; pass maxDepth to follow their users too",
	);
	// A walk that reached the depth asked for, with users beyond it, says to raise the depth.
	const one = await ask(undefined, 1);
	expect([one.shown, one.raise, one.note]).toEqual([41, "trace.maxDepth", undefined]);
	expect((await ask(undefined, 2)).shown).toBe(42);
	// With more direct users than 32, the default is one level; asked, never more than eight.
	const hub = await ask();
	expect([hub.shown, hub.raise]).toEqual([41, "trace.maxDepth"]);
	expect(hub.note).toBe(
		"only direct users are shown, since there are more than 32; pass maxDepth to follow their users too",
	);
	expect((await ask(undefined, 3)).shown).toBe(43);
	expect((await ask(undefined, 20)).shown).toBe(48);
});

test("a hub past the symbol limit says the limit stopped it", async () => {
	const target = "src/a.ts#target:function";
	const { graph } = callerGraph({
		[target]: Array.from({ length: 1001 }, (_, index) => ({ id: callerHandle(index) })),
	});
	const result = await traceWith({ client: graph, ranges, root: "/tmp" }, { from: target });
	expect([result.shown, result.raise]).toEqual([1000, "trace.maxNodes"]);
	expect(result.note).toBe(
		"stopped at 1000 symbols; trace from a narrower symbol; only direct users are shown, since there are more than 32; pass maxDepth to follow their users too",
	);
});

test("a start with exactly 32 direct users keeps the default depth", async () => {
	const target = "src/a.ts#target:function";
	const direct = Array.from({ length: 32 }, (_, index) => `src/a.ts#direct${index}:function`);
	const { graph } = callerGraph({
		[target]: direct.map((id) => ({ id })),
		...Object.fromEntries(direct.map((id) => [id, [{ id: id.replace("direct", "outer") }]])),
	});
	const result = await traceWith({ client: graph, ranges, root: "/tmp" }, { from: target });
	expect(result.nodes.map(({ name }) => name)).toContain("outer0");
	expect(result.note).toBeUndefined();
	// Asking for exactly as many symbols as there are leaves none out.
	const exact = await traceWith({ client: graph, ranges, root: "/tmp" }, { from: target, maxNodes: 64 });
	expect([exact.shown, exact.raise, exact.note]).toEqual([64, undefined, undefined]);
	expect((await traceWith({ client: graph, ranges, root: "/tmp" }, { from: target, maxNodes: 63 })).raise).toBe(
		"trace.maxNodes",
	);
});

test("a forward or path trace names the bound that cut it", async () => {
	const start = "src/a.ts#start:function";
	const chain = Array.from({ length: 6 }, (_, index) => callerHandle(index));
	// Forward along a chain: each symbol "calls" the next, which the fake graph walks the same way.
	const { graph } = callerGraph({
		[start]: [{ id: chain[0]! }],
		...Object.fromEntries(chain.slice(0, -1).map((id, index) => [id, [{ id: chain[index + 1]! }]])),
	});
	const context = { client: graph, ranges, root: "/tmp" };
	const forward = (request: Record<string, unknown>) =>
		traceWith(context, { from: start, direction: "forward", ...request });
	expect((await forward({})).raise).toBe("trace.maxDepth");
	expect((await forward({ maxNodes: 2 })).raise).toBe("trace.maxNodes");
	expect((await forward({ maxDepth: 10 })).raise).toBeUndefined();
});

test("a member with no graph node starts from its references, then follows each user's callers together", async () => {
	const root = mkdtempSync(join(realpathSync("/tmp"), "sr-nodeless-"));
	writeFileSync(
		join(root, "a.ts"),
		"export function first() { return box.prop; }\nexport function second() { box.prop(); }\n",
	);
	const start = "a.ts#Box.prop:variable";
	const first = "a.ts#first:function";
	const second = "a.ts#second:function";
	const outer = "a.ts#outer:function";
	const top = "a.ts#top:function";
	const nodeless: RangeIndex = {
		...ranges,
		declarations: async () => [
			{ name: "Box.prop", kind: "property", start: 1, end: 1, codeStart: 1, unindexed: "member" },
		],
	};
	const references: ReferenceIndex = {
		query: async () => ({
			type: "references",
			shown: 2,
			edges: [],
			sections: {},
			nodes: [
				{
					handle: "a.ts#ref:1",
					name: "prop",
					file: "a.ts",
					ranges: null,
					line: 1,
					col: 38,
					endCol: 42,
					in: { handle: first },
				},
				{
					handle: "a.ts#ref:2",
					name: "prop",
					file: "a.ts",
					ranges: null,
					line: 2,
					col: 31,
					endCol: 35,
					text: "export function second() { box.prop(); }",
					call: { line: 2, col: 27, endLine: 2, endCol: 37, arguments: [] },
					in: { handle: second },
				},
			],
		}),
		reexport: async () => undefined,
		close: async () => {},
	} as unknown as ReferenceIndex;
	const { graph, sent } = callerGraph({ [first]: [{ id: outer }], [second]: [{ id: outer }], [outer]: [{ id: top }] });
	try {
		const result = await traceWith({ client: graph, ranges: nodeless, references, root }, { from: start, maxDepth: 2 });
		expect(sent.map(({ from, maxDepth }) => [from, maxDepth])).toEqual([
			[first, 1],
			[second, 1],
		]);
		expect(result.nodes.map(({ handle }) => handle).toSorted()).toEqual([start, first, outer, second].toSorted());
		expect(result.edges.map((edge) => [edge.from, edge.to, edge.kind])).toEqual(
			expect.arrayContaining([
				[first, start, "accesses"],
				[second, start, "calls"],
				[outer, first, "calls"],
				[outer, second, "calls"],
			]),
		);
		expect(result.note).toBe("Box.prop has no graph node, so its direct users come from its references");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const neighbour = (id: string, relation: string, line: number) => ({
	...symbol(id),
	file: id.split("#")[0],
	relation,
	evidence: { file: id.split("#")[0], startLine: line, startCol: 1, endLine: line, endCol: 2 },
});

test("--in keeps each details neighbour list pointing at its own edges", async () => {
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

const tourSeed = (id: string, line: number) => ({ ...symbol(id), file: id.split("#")[0], line });

test("--in keeps a tour's steps pointing at its own edges", async () => {
	const tourClient: GraphClient = {
		...client,
		query: async () => ({
			value: {
				result: {
					type: "tour",
					seeds: [
						tourSeed("src/b.ts#outside:function", 3),
						tourSeed("src/a.ts#inside:function", 4),
						tourSeed("src/a.ts#target:function", 1),
					],
					primaryFlow: {
						steps: ["outside -[calls at src/b.ts:3]-> target", "inside -[calls at src/a.ts:4]-> target"],
					},
				},
			},
			isError: false,
		}),
	};
	const [result] = JSON.parse(
		await runQuery({ client: tourClient, ranges, root: "/tmp" }, [{ type: "tour" }], { mode: "json", in: "src/a.ts" }),
	) as Array<{ edges: Array<{ from: string; to: string }>; sections: { primaryFlow: { steps: number[] } } }>;
	expect(
		result.sections.primaryFlow.steps.map((index) => `${result.edges[index].from} → ${result.edges[index].to}`),
	).toEqual(["src/a.ts#inside:function → src/a.ts#target:function"]);
});

test("a reverse trace reads maxNodes as the graph does, and says when the graph withheld a dispatch", async () => {
	const target = "src/a.ts#target:function";
	const { graph } = callerGraph({ [target]: [{ id: callerHandle(0) }, { id: callerHandle(1) }] });
	for (const maxNodes of [0, -1]) {
		const result = await traceWith({ client: graph, ranges, root: "/tmp" }, { from: target, maxNodes });
		expect([result.shown, result.raise]).toEqual([1, "trace.maxNodes"]);
		expect(result.note).toBe("stopped at 1 symbol; trace from a narrower symbol");
	}
	// The graph marks a walk truncated when it leaves out a dispatch to 12 or more implementations, with neither its
	// budget full nor its depth reached; only `complete` follows it.
	const withholding: GraphClient = {
		...client,
		query: async (request) => {
			const { value } = await graph.query({ ...request, maxDepth: 1 });
			return { value: { result: { ...(value as { result: object }).result, truncated: true } }, isError: false };
		},
	};
	const withheld = await traceWith({ client: withholding, ranges, root: "/tmp" }, { from: target });
	expect([withheld.shown, withheld.raise]).toEqual([2, "trace.complete"]);
	expect(withheld.note).toBe("the graph left out a dispatch to 12 or more implementations; pass complete to follow it");
});

// A reference to `box.prop` on a line of a.ts, inside `handle`.
const reference = (line: number, handle: string) => ({
	handle: `a.ts#ref:${line}`,
	name: "prop",
	file: "a.ts",
	ranges: null,
	line,
	col: 38,
	endCol: 42,
	in: { handle },
});

test("a member with no node keeps the request's options, follows complete, and says which users it couldn't trace", async () => {
	const root = mkdtempSync(join(realpathSync("/tmp"), "sr-nodeless-options-"));
	writeFileSync(
		join(root, "a.ts"),
		"export function first() { return box.prop; }\nexport function second() { return box.prop; }\n",
	);
	const start = "a.ts#Box.prop:variable";
	const first = "a.ts#first:function";
	const second = "a.ts#second:function";
	const nodeless: RangeIndex = {
		...ranges,
		declarations: async () => [
			{ name: "Box.prop", kind: "property", start: 1, end: 1, codeStart: 1, unindexed: "member" },
		],
	};
	const references = {
		query: async () => ({
			type: "references",
			shown: 2,
			edges: [],
			sections: {},
			nodes: [reference(1, first), reference(2, second)],
		}),
		reexport: async () => undefined,
		close: async () => {},
	} as unknown as ReferenceIndex;
	const { graph, sent } = callerGraph({ [first]: [{ id: "a.ts#outer:function" }] });
	// The second user's own trace fails.
	const failing: GraphClient = {
		...graph,
		query: async (request) => {
			if (request.from === second) throw new Error("graph went away");
			return graph.query(request);
		},
	};
	try {
		const context = { client: failing, ranges: nodeless, references, root };
		const focused = await traceWith(context, { from: start, maxDepth: 2, focus: "execution" });
		expect(sent.map(({ from, focus, maxDepth }) => [from, focus, maxDepth])).toEqual([[first, "execution", 1]]);
		expect(focused.nodes.map(({ name }) => name).toSorted()).toEqual(["Box.prop", "first", "outer", "second"]);
		expect(focused.note).toBe(
			"Box.prop has no graph node, so its direct users come from its references; 1 symbol skipped",
		);
		sent.length = 0;
		await traceWith(context, { from: start, complete: true });
		expect(sent.map(({ from, complete, maxDepth }) => [from, complete, maxDepth])).toEqual([[first, true, undefined]]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a reverse trace whose hop budget ran out on its direct users says it left some out", async () => {
	const target = "src/a.ts#target:function";
	// Forty-one callers, each calling the target fifty times: 2,050 hops before any second level, past the hop budget
	// of 2,000 that comes with 1,000 symbols.
	const callers = Array.from({ length: 41 }, (_, index) => callerHandle(index));
	const { graph } = callerGraph({ [target]: callers.flatMap((id) => Array.from({ length: 50 }, () => ({ id }))) });
	const result = await traceWith({ client: graph, ranges, root: "/tmp" }, { from: target });
	expect(result.shown).toBe(40);
	expect(result.raise).toBe("trace.maxNodes");
	expect(result.note).toStartWith("stopped at the graph's limit of 2000 hops");
});

test("a member with no node follows focus from its first hop", async () => {
	const root = mkdtempSync(join(realpathSync("/tmp"), "sr-nodeless-focus-"));
	writeFileSync(
		join(root, "a.ts"),
		"export function reads() { return box.prop; }\nexport type Typed = typeof box.prop;\n",
	);
	const start = "a.ts#Box.prop:variable";
	const nodeless: RangeIndex = {
		...ranges,
		declarations: async () => [
			{ name: "Box.prop", kind: "property", start: 1, end: 1, codeStart: 1, unindexed: "member" },
		],
	};
	const references = {
		query: async () => ({
			type: "references",
			shown: 2,
			edges: [],
			sections: {},
			nodes: [reference(1, "a.ts#reads:function"), { ...reference(2, "a.ts#Typed:type"), inType: true }],
		}),
		reexport: async () => undefined,
		close: async () => {},
	} as unknown as ReferenceIndex;
	const { graph } = callerGraph({});
	try {
		const kinds = async (focus?: string) =>
			(
				await traceWith(
					{ client: graph, ranges: nodeless, references, root },
					{ from: start, maxDepth: 1, ...(focus ? { focus } : {}) },
				)
			).edges.map(({ kind }) => kind);
		expect(await kinds()).toEqual(["accesses", "type_ref"]);
		expect(await kinds("execution")).toEqual(["accesses"]);
		expect(await kinds("types")).toEqual(["type_ref"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const usedBy = (dependents: unknown[]): GraphClient => ({
	...client,
	query: async (request) => ({
		value: {
			result: { type: request.type, nodes: [{ ...symbol("a.ts#first:function"), dependedOnBy: dependents }] },
		},
		isError: false,
	}),
});

test("a member with no node, traced one level, says when its users have users of their own", async () => {
	const root = mkdtempSync(join(realpathSync("/tmp"), "sr-nodeless-depth-"));
	writeFileSync(join(root, "a.ts"), "export function first() { return box.prop; }\n");
	const nodeless: RangeIndex = {
		...ranges,
		declarations: async () => [
			{ name: "Box.prop", kind: "property", start: 1, end: 1, codeStart: 1, unindexed: "member" },
		],
	};
	const references = {
		query: async () => ({
			type: "references",
			shown: 1,
			edges: [],
			sections: {},
			nodes: [reference(1, "a.ts#first:function")],
		}),
		reexport: async () => undefined,
		close: async () => {},
	} as unknown as ReferenceIndex;
	try {
		const trace = (graph: GraphClient) =>
			traceWith({ client: graph, ranges: nodeless, references, root }, { from: "a.ts#Box.prop:variable", maxDepth: 1 });
		expect((await trace(usedBy([{ ...symbol("a.ts#outer:function"), relation: "calls" }]))).raise).toBe(
			"trace.maxDepth",
		);
		expect((await trace(usedBy([]))).raise).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
