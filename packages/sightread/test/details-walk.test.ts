// Pin what completed reverse traces rely on when they read a level's callers from one `details` request.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createFixtureProject } from "./fixture.ts";
import { type GraphClient, startGraphClient } from "../src/upstream.ts";

const fixture = createFixtureProject({
	"tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve", strict: true } }),
	"src/a.tsx": [
		"export type Id = string;",
		"export interface Shape { area(): number }",
		"export class Square implements Shape { constructor(public side: number) {} area() { return this.side ** 2; } static unit = 1; }",
		"export const settings = { size: 2 };",
		"export function Badge(props: { id: Id }) { return <span>{props.id}</span>; }",
		'export function Panel() { return <div><Badge id="a" /></div>; }',
		"export function build(id: Id): Shape { return new Square(settings.size + Square.unit + id.length); }",
		'export const handler = () => build("x");',
		"export function withCallback(fn: () => void) { fn(); }",
		"export function register() { withCallback(handler); }",
		"export function popular() { return 1; }",
		...Array.from({ length: 5 }, (_, index) => `export function user${index}() { return popular(); }`),
		"register();",
	].join("\n"),
});
const handle = (name: string) => `src/a.tsx#${name}`;
let client: GraphClient;

beforeAll(async () => {
	client = await startGraphClient({ root: fixture.root, tsconfig: join(fixture.root, "tsconfig.json") });
});

afterAll(async () => {
	if (client) await client.close();
	fixture.cleanup();
});

type Item = Record<string, unknown> & { evidence?: { startLine?: number; startCol?: number } };
const result = (value: unknown) => {
	const outer = value as { result?: Record<string, unknown> };
	return (outer.result ?? value) as Record<string, unknown>;
};

async function dependents(handles: string[], neighborLimit = 3): Promise<Map<string, string[]>> {
	const answer = await client.query({ type: "details", handles, neighbors: true, neighborLimit });
	const nodes = result(answer.value).nodes as Array<{ id: string; dependedOnBy?: Item[] }>;
	return new Map(
		nodes.map((node) => [
			node.id,
			(node.dependedOnBy ?? [])
				.map(({ id, relation, evidence }) => `${id} ${relation} ${evidence?.startLine}:${evidence?.startCol}`)
				.toSorted(),
		]),
	);
}

async function callers(target: string): Promise<string[]> {
	const answer = await client.query({ type: "trace", from: target, direction: "reverse", maxDepth: 1, maxNodes: 32 });
	return ((result(answer.value).hops ?? []) as Item[])
		.filter(({ to }) => to === target)
		.map(({ from, kind, evidence }) => `${from} ${kind} ${evidence?.startLine}:${evidence?.startCol}`)
		.toSorted();
}

test("details lists at most three dependents, however many are asked for, and doesn't flag the rest", async () => {
	const popular = handle("popular:function");
	const [listed] = [...(await dependents([popular], 1000)).values()];
	expect(listed).toHaveLength(3);
	expect(await callers(popular)).toHaveLength(5);
});

test("details dependents match a one-level reverse trace for the kinds a completed trace asks it about", async () => {
	const handles = [
		"Id:type",
		"settings:variable",
		"Badge:function",
		"Panel:function",
		"build:function",
		"handler:variable",
		"withCallback:function",
		"register:function",
	].map(handle);
	const listed = await dependents(handles);
	// Module-level code is listed under its file, which a reverse trace leaves out, so a completed trace skips it.
	const register = handle("register:function");
	expect(listed.get(register)).toEqual(["src/a.tsx calls 17:1"]);
	expect(await callers(register)).toEqual([]);
	listed.set(register, []);
	for (const target of handles)
		expect({ target, callers: listed.get(target) }).toEqual({ target, callers: await callers(target) });
});

test("details leaves out the dispatch edges a reverse trace follows to an implementation", async () => {
	const area = handle("Square.area:method");
	expect(await callers(area)).toEqual([`${handle("Shape.area:method")} dispatches 3:76`]);
	expect((await dependents([area])).get(area)).toEqual([]);
});
