// Every declaration shape gets the graph's name everywhere, and a member it has no node for still resolves.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fromHandle, handleSeparator, toHandle } from "../src/model.ts";
import { createPaths } from "../src/paths.ts";
import { handleFor, parseDeclarations } from "../src/ranges.ts";
import { startGraphClient } from "../src/upstream.ts";
import { createFixtureProject } from "./fixture.ts";

const shapes = [
	"export interface Iface { iprop: number; imethod(): void }",
	"export type Lit = { lprop: number; lmethod(): void; nested: { deep: number } };",
	"type Base = { bprop: number };",
	"export type Inter = Base & { xprop: string };",
	"export enum Color { Red, Green }",
	"export const obj = { omethod() { return 1; }, ofield: 2 };",
	"export class Cls {",
	"  #priv = 1;",
	"  static stat = 2;",
	"  constructor(public paramProp: number) {}",
	"  get acc() { return this.#priv; }",
	"  method() { const methodLocal = () => this.#priv; return methodLocal(); }",
	"}",
	"export namespace NS { export const nv = 1; export function nf() { return nv; } function hidden() { return 2; } }",
	"export default function () { const inDefault = () => 1; return inDefault(); }",
	"export const arrow = () => { const inner = () => 1; const plain = 2; return inner() + plain; };",
	"export function fn(options: { inline: number }) { if (options.inline) { const blockLocal = () => 1; return blockLocal(); } return 0; }",
	"export const ClassExpr = class { ce() {} };",
	'declare module "./other.ts" { interface Aug { augprop: number } }',
].join("\n");

const uses = [
	'import fnDefault, { type Iface, type Lit, type Inter, Color, obj, Cls, NS, arrow, fn, ClassExpr } from "./decl.ts";',
	'import type { Aug } from "./other.ts";',
	"export function readsAll(i: Iface, l: Lit, x: Inter, a: Aug) {",
	"  const { lprop } = l;",
	"  return [i.iprop, l.lprop, l.nested.deep, x.xprop, a.augprop, lprop, Color.Red, obj.ofield, obj.omethod()];",
	"}",
	"export function more(c: Cls) {",
	"  return [new Cls(1), c.paramProp, c.acc, Cls.stat, NS.nf(), NS.nv, arrow(), fn({ inline: 1 }), fnDefault(), new ClassExpr().ce()];",
	"}",
	"function Comp(props: Lit) { return null; }",
	"export const element = <Comp lprop={1} lmethod={() => {}} nested={{ deep: 1 }} />;",
	"export const written: Lit = { lprop: 2, lmethod() {}, nested: { deep: 2 } };",
].join("\n");

const fixture = createFixtureProject({
	"tsconfig.json":
		'{"compilerOptions":{"strict":true,"jsx":"preserve","module":"nodenext","moduleResolution":"nodenext"}}',
	"src/jsx.d.ts": "declare namespace JSX { type Element = unknown; interface IntrinsicElements {} }\n",
	"src/decl.ts": `${shapes}\n`,
	"src/other.ts": "export interface Aug { orig: number }\n",
	"src/use.tsx": `${uses}\n`,
	"src/merged.ts": [
		"export namespace A { function hidden() { return 1; } export const a = hidden(); }",
		"export namespace B { function hidden() { return 2; } export const b = hidden() + hidden(); }",
	].join("\n"),
});
const root = realpathSync(fixture.root);
const fixtureFile = (path: string) => readFileSync(join(root, path), "utf8");
const runtime = mkdtempSync(join(realpathSync("/tmp"), "sr-members-"));
const cli = join(import.meta.dir, "../src/cli.ts");

function run(...args: string[]) {
	const child = Bun.spawnSync([process.execPath, cli, "--cwd", root, ...args], {
		env: { ...Bun.env, XDG_RUNTIME_DIR: runtime },
	});
	return { code: child.exitCode, out: child.stdout.toString().trimEnd(), err: child.stderr.toString().trimEnd() };
}

function query<T>(request: Record<string, unknown>): T {
	const output = run("--json", JSON.stringify(request));
	if (output.code !== 0) throw new Error(output.err);
	return (JSON.parse(output.out) as T[])[0]!;
}

afterAll(() => {
	run("stop");
	fixture.cleanup();
	rmSync(runtime, { recursive: true, force: true });
});

test("handles escape a private name's `#`, and only an unescaped one ends the file", () => {
	const handle = toHandle("src/a#b.ts", "Row.#count", "variable");
	expect(handle).toBe("src/a#b.ts#Row.\\#count:variable");
	expect(fromHandle(handle)).toEqual({ file: "src/a#b.ts", name: "Row.#count", kind: "variable" });
	expect(handleSeparator(handle)).toBe("src/a#b.ts".length);
	const paths = createPaths(root);
	expect(paths.toRepositoryHandle("src/decl.ts#Cls.\\#priv:variable")).toBe("src/decl.ts#Cls.\\#priv:variable");
});

test("declarations are named as the graph names them, with what it has no node for marked", async () => {
	const declarations = await parseDeclarations("decl.ts", shapes);
	const flags = Object.fromEntries(
		declarations.map(({ name, kind, graphName, unindexed }) => [
			name,
			[kind, unindexed, graphName && `as ${graphName}`].filter(Boolean).join(" "),
		]),
	);
	expect(flags).toMatchObject({
		"Iface.iprop": "property",
		"Lit.lprop": "property member",
		"Lit.lmethod": "method member",
		"Lit.nested.deep": "property member",
		"Inter.xprop": "property member",
		"Color.Red": "property member",
		"obj.omethod": "method member",
		"obj.ofield": "property member",
		"Cls.#priv": "property",
		"Cls.paramProp": "property member",
		"Cls.method.methodLocal": "variable",
		"NS.nv": "variable",
		"NS.nf": "function",
		// The graph leaves the namespace off a member it doesn't export.
		"NS.hidden": "function as hidden",
		"default.inDefault": "variable",
		"arrow.inner": "variable",
		"arrow.plain": "variable local",
		"fn.blockLocal": "variable",
		"ClassExpr.ce": "method member",
		"Aug.augprop": "property",
	});
	// An inline type literal, such as a parameter's, names nothing.
	expect(declarations.some(({ name }) => name.endsWith(".inline"))).toBe(false);
});

test("the graph has a node, under the graph name given, for exactly the declarations not marked unindexed", async () => {
	const declarations = await parseDeclarations("decl.ts", shapes);
	const client = await startGraphClient({ root, tsconfig: join(root, "tsconfig.json") });
	try {
		const results = await client.batch(
			declarations.map(({ name }) => ({ type: "lookup", query: name.split(".").at(-1), limit: 50 })),
		);
		const missing: string[] = [];
		const extra: string[] = [];
		declarations.forEach((declaration, index) => {
			const hits = (results[index]!.value as { result: { hits: Array<{ id: string }> } }).result.hits;
			const found = hits.some(({ id }) => id === handleFor("src/decl.ts", declaration));
			if (!declaration.unindexed && !found) missing.push(declaration.name);
			if (declaration.unindexed && found) extra.push(declaration.name);
		});
		expect({ missing, extra }).toEqual({ missing: [], extra: [] });
	} finally {
		await client.close();
	}
});

test("every member resolves by name, and references find each use", () => {
	const lines = (symbol: string) =>
		query<{ nodes: Array<{ file: string; line: number }> }>({ type: "references", symbol }).nodes.map(
			({ file, line }) => `${file.replace("src/", "")}:${line}`,
		);
	expect(lines("Lit.lprop")).toEqual(["use.tsx:4", "use.tsx:5", "use.tsx:11", "use.tsx:12"]);
	expect(lines("Lit.nested.deep")).toEqual(["use.tsx:5", "use.tsx:11", "use.tsx:12"]);
	expect(lines("Inter.xprop")).toEqual(["use.tsx:5"]);
	expect(lines("Color.Red")).toEqual(["use.tsx:5"]);
	expect(lines("obj.ofield")).toEqual(["use.tsx:5"]);
	expect(lines("obj.omethod")).toEqual(["use.tsx:5"]);
	expect(lines("Cls.#priv")).toEqual(["decl.ts:11", "decl.ts:12"]);
	expect(lines("Cls.paramProp")).toEqual(["use.tsx:8"]);
	expect(lines("ClassExpr.ce")).toEqual(["use.tsx:8"]);
	expect(lines("Aug.augprop")).toEqual(["use.tsx:5"]);
	expect(lines("arrow.inner")).toEqual(["decl.ts:16"]);
	expect(lines("fn.blockLocal")).toEqual(["decl.ts:17"]);
	expect(lines("src/decl.ts#default")).toEqual(["use.tsx:1", "use.tsx:8"]);
	expect(lines("Cls.__constructor")).toEqual(["use.tsx:8"]);
	expect(run("--json", JSON.stringify({ type: "references", symbol: "Lit.missing" })).err).toContain(
		"Lit.missing not found",
	);
});

test("a reference names the innermost declaration the graph has a node for", () => {
	const containers = (symbol: string) =>
		query<{ nodes: Array<{ in?: { handle: string } }> }>({ type: "references", symbol }).nodes.map(
			(node) => node.in?.handle,
		);
	expect(containers("src/decl.ts#Cls.\\#priv:variable")).toEqual([
		"src/decl.ts#Cls.acc:method",
		"src/decl.ts#Cls.method.methodLocal:variable",
	]);
	// Members of an object literal have no node, so their owner contains what they hold.
	expect(containers("Lit.lprop").at(-1)).toBe("src/use.tsx#written:variable");
});

test("details lists a type alias's members and qualifies an object literal's", () => {
	const result = query<{ nodes: Array<{ handle: string; ranges: unknown }>; sections: { members: string[] } }>({
		type: "details",
		handles: ["Lit", "obj", "Color"],
	});
	expect(result.sections.members).toEqual(
		expect.arrayContaining([
			"src/decl.ts#Lit.lprop:variable",
			"src/decl.ts#Lit.lmethod:method",
			"src/decl.ts#Lit.nested:variable",
			"src/decl.ts#obj.ofield:variable",
			"src/decl.ts#obj.omethod:method",
			"src/decl.ts#Color.Red:variable",
		]),
	);
	for (const node of result.nodes)
		expect(node.ranges).toEqual([{ start: expect.any(Number), end: expect.any(Number) }]);
	const member = query<{ nodes: Array<{ handle: string }>; note?: string }>({
		type: "details",
		handles: ["Lit.lprop"],
	});
	expect(member.nodes.map(({ handle }) => handle)).toEqual(["src/decl.ts#Lit.lprop:variable"]);
	expect(member.note).toBe("Lit.lprop has no graph node, so no edges; references lists its uses");
});

test("a reverse trace from a member starts from its references; other traces say why they can't", () => {
	const result = query<{ nodes: Array<{ name: string }>; note?: string }>({
		type: "trace",
		from: "Lit.lprop",
		direction: "reverse",
	});
	expect(result.nodes.map(({ name }) => name)).toEqual(["Lit.lprop", "readsAll", "element", "written"]);
	expect(result.note).toStartWith("complete: Lit.lprop has no graph node");
	expect(run(JSON.stringify({ type: "trace", from: "Lit.lprop" })).err).toBe(
		"sightread: trace can only go reverse from Lit.lprop: the graph has no node for it, as it's a member of Lit; trace reverse from it for what uses it, or ask references",
	);
	expect(run(JSON.stringify({ type: "trace", from: "readsAll", to: "Color.Red" })).err).toStartWith(
		"sightread: trace can't reach Color.Red:",
	);
});

test("a namespace member resolves by its full name, though the graph leaves the namespace off", () => {
	expect(
		query<{ nodes: Array<{ in?: { handle: string } }> }>({ type: "references", symbol: "NS.hidden" }).nodes,
	).toEqual([]);
	const details = query<{ nodes: Array<{ handle: string }> }>({ type: "details", handles: ["NS.hidden"] });
	expect(details.nodes.map(({ handle }) => handle)).toContain("src/decl.ts#hidden:function");
});

test("declarations the graph merges under one name are told apart by their full names", async () => {
	const declarations = await parseDeclarations("merged.ts", `${fixtureFile("src/merged.ts")}`);
	expect(declarations.filter(({ unindexed }) => unindexed === "shared").map(({ name }) => name)).toEqual([
		"A.hidden",
		"B.hidden",
	]);
	const lines = (symbol: string) =>
		query<{ nodes: Array<{ line: number }> }>({ type: "references", symbol }).nodes.map(({ line }) => line);
	expect(lines("A.hidden")).toEqual([1]);
	expect(lines("B.hidden")).toEqual([2, 2]);
	expect(run(JSON.stringify({ type: "references", symbol: "src/merged.ts#hidden:function" })).err).toBe(
		"sightread: src/merged.ts#hidden:function is 2 declarations the graph merges; use one: src/merged.ts#A.hidden:function, src/merged.ts#B.hidden:function",
	);
	const trace = query<{ nodes: Array<{ name: string }>; edges: Array<{ kind: string }> }>({
		type: "trace",
		from: "B.hidden",
		direction: "reverse",
	});
	expect(trace.nodes.map(({ name }) => name)).toEqual(["B.b", "B.hidden"]);
	expect(trace.edges.map(({ kind }) => kind)).toEqual(["calls", "calls"]);
});
