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

test("reverse trace honors explicit maxNodes and reports skipped symbols", async () => {
	const calls: number[] = [];
	const traceClient: GraphClient = {
		...client,
		query: async () => ({
			value: { result: { type: "trace", start: { id: "src/a.ts#target:function" }, reached: [], truncated: true } },
			isError: false,
		}),
	};
	const references: ReferenceIndex = {
		query: async () => {
			throw new Error("unexpected references query");
		},
		walk: async (_start, limits) => {
			calls.push(limits.maxNodes);
			return { nodes: [], edges: [], truncated: false, skipped: 2 };
		},
		close: async () => {},
	};
	const context = { client: traceClient, ranges, references, root: "/tmp" };
	const ask = async (maxNodes?: number) =>
		(
			JSON.parse(
				await runQuery(
					context,
					[
						{
							type: "trace",
							from: "src/a.ts#target:function",
							direction: "reverse",
							...(maxNodes === undefined ? {} : { maxNodes }),
						},
					],
					{ mode: "json" },
				),
			) as Array<{ note?: string; raise?: string }>
		)[0];
	expect((await ask(8)).raise).toBe("trace.maxNodes");
	expect((await ask(32)).raise).toBe("trace.maxNodes");
	expect(calls).toEqual([]);
	expect((await ask(45)).note).toContain("2 symbols skipped");
	expect(calls).toEqual([45]);
	await ask();
	expect(calls).toEqual([45, 1000]);
});
