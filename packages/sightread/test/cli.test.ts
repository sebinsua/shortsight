// Exercise the Bun command against a disposable project and live graph.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createFixtureProject } from "./fixture.ts";

const repo = join(import.meta.dir, "../../..");
const outside = mkdtempSync("/tmp/sightread-outside-");
const runtime = mkdtempSync("/tmp/sightread-cli-runtime-");
const fixture = createFixtureProject({
	"src/model.ts":
		"export function greet(name: string) { return `Hi ${name}`; }\nexport function caller() { return greet('Ada'); }\n",
	"src/View.tsx": [
		"type Row<T> = { id: string; value: T };",
		"export function View<T>({ rows }: { rows: Row<T>[] }) {",
		"  return <main><h1>Rows</h1><section>{rows.map((row) =>",
		"    <article key={row.id}><header>{row.id}</header><p>{String(row.value)}</p></article>",
		"  )}</section></main>;",
		"}",
	].join("\n"),
});

afterAll(() => {
	run("stop", "--all");
	fixture.cleanup();
	rmSync(outside, { recursive: true, force: true });
	rmSync(runtime, { recursive: true, force: true });
});

function run(...args: string[]) {
	const process = Bun.spawnSync(["bun", "packages/sightread/src/cli.ts", ...args], {
		cwd: repo,
		env: { ...Bun.env, XDG_RUNTIME_DIR: runtime },
	});
	return {
		code: process.exitCode,
		out: new TextDecoder().decode(process.stdout).trimEnd(),
		err: new TextDecoder().decode(process.stderr).trimEnd(),
	};
}

test("parsing errors have exact messages and exit 1", () => {
	for (const [args, message] of [
		[[], "pass one JSON request (or array); run sightread --help"],
		[["{}", "{}"], "pass one JSON request (or array); run sightread --help"],
		[["42"], "pass one JSON request (or array); run sightread --help"],
		[["{"], "invalid JSON request; run sightread --help"],
		[["[]"], "batch must contain at least one request"],
	] as const) {
		const output = run(...args);
		expect(output.code).toBe(1);
		expect(output.err).toBe(`sightread: ${message}`);
	}
});

test("--skill prints the complete skill outside a project", () => {
	const output = run("--cwd", outside, "--skill");
	expect(output).toEqual({
		code: 0,
		out: readFileSync(join(import.meta.dir, "../skills/sightread/SKILL.md"), "utf8").trimEnd(),
		err: "",
	});
	const process = Bun.spawnSync(["bun", join(repo, "packages/sightread/src/cli.ts"), "--skill"], { cwd: outside });
	expect(process.stdout.toString()).toBe(readFileSync(join(import.meta.dir, "../skills/sightread/SKILL.md"), "utf8"));
	expect(run("--help").out).toContain("--skill");
});

test("ambiguous handles remain complete past the ordinary error limit", () => {
	const large = createFixtureProject({
		...Object.fromEntries(
			Array.from({ length: 10 }, (_, index) => [
				`src/long-directory-for-component-${index}/file.ts`,
				"export function duplicateName() { return 1; }\n",
			]),
		),
		"src/View.tsx": "export const View = () => <main><section><p>View</p></section></main>;\n",
	});
	try {
		const output = run("--cwd", large.root, '{"type":"trace","from":"duplicateName","direction":"reverse"}');
		expect(output.err).toBe(
			`sightread: starting a server for ${large.root}; the first request may take a while\nsightread: duplicateName is ambiguous; use a handle: ${Array.from(
				{ length: 6 },
				(_, index) => `src/long-directory-for-component-${index}/file.ts#duplicateName`,
			).join(", ")}`,
		);
		const suggested = run(
			"--cwd",
			large.root,
			'{"type":"trace","from":"src/long-directory-for-component-0/file.ts#duplicateName","direction":"reverse"}',
		);
		expect(suggested).toMatchObject({ code: 0, err: "" });
	} finally {
		run("--cwd", large.root, "stop");
		large.cleanup();
	}
}, 30_000);

test("nested projects are named after the text result and included in JSON", () => {
	const nested = createFixtureProject({
		"tsconfig.json": '{"include":["scripts/**/*.ts"]}',
		"scripts/build.ts": "export const build = 1;\n",
		"src/node/tsconfig.json": '{"include":["**/*.ts"]}',
		"src/node/server.ts": "export function createServer() { return 1; }\n",
		"src/client/tsconfig.json": '{"include":["**/*.tsx"]}',
		"src/client/View.tsx": "export function View() { return <main><section><p>Hi</p></section></main>; }\n",
	});
	try {
		const query = '{"type":"lookup","query":"createServer"}';
		expect(run("--cwd", nested.root, query).out).toBe(
			"lookup for createServer: 0 shown\n\n(none)\n\nnote: graphed tsconfig.json (1 file); nested projects: src/client, src/node. Run from one of those for its code.",
		);
		const json = JSON.parse(run("--cwd", nested.root, "--json", query).out) as Array<{ nestedProjects: string[] }>;
		expect(json[0].nestedProjects).toEqual(["src/client", "src/node"]);
	} finally {
		run("--cwd", nested.root, "stop");
		nested.cleanup();
	}
}, 30_000);

test("diff rejects extra arguments with its command usage", () => {
	expect(run("--cwd", fixture.root, "diff", "HEAD", "extra")).toMatchObject({
		code: 1,
		err: "sightread: usage: sightread [--cwd DIR] [--json] diff [base]",
	});
});

test("help lists live request fields inside and outside a project", () => {
	for (const directory of [fixture.root, outside]) {
		const output = run("--cwd", directory, "--help");
		expect(output.code).toBe(0);
		expect(output.out).toStartWith("sightread [--cwd DIR] [--in DIR] [--json | --raw] '<JSON request or array>'");
		expect(output.out.indexOf("Examples:")).toBeLessThan(output.out.indexOf("Request types:"));
		expect(output.out).toContain("lookup\n  query*");
		expect(output.out).toContain("direction (forward/impact/reverse)");
		expect(output.out).toContain("symbol name");
	}
}, 30_000);

test("help keeps every line of a multiline field description indented", () => {
	const output = run("--cwd", fixture.root, "--help");
	expect(output.code).toBe(0);
	expect(output.out).toContain(
		[
			"lookup",
			"  query* — What to find: a symbol name, a dotted member (`Service.create`), or a short phrase",
			"           (`request handler`). Exact names are not required, but this is not a second broad",
			"           entrypoints call; use it for a missing or ambiguous named handle. It also answers the",
			"           other direction. Give it a documentation target — a document section",
			"           (`docs/pricing.md#sale`), an API operation (`POST:/orders`), a data model (`prisma:Sale`)",
			"           — and the hits are the declarations whose documentation cites it, each carrying the tag",
			"           that matched. That is the question a repository-wide search would otherwise answer, so it",
			"           is worth asking here first; a target is matched exactly, so spell it as the code does.",
		].join("\n"),
	);
});

test("lookup and reverse trace print live ranges and edges", () => {
	const lookup = run("--cwd", fixture.root, JSON.stringify({ type: "lookup", query: "greet" }));
	expect(lookup.code).toBe(0);
	expect(lookup.out).toContain("hits\n  = greet  exported function  src/model.ts:1-1");
	const trace = run("--cwd", fixture.root, JSON.stringify({ type: "trace", from: "greet", direction: "reverse" }));
	expect(trace.code).toBe(0);
	expect(trace.out).toContain("trace reverse from greet: 1 shown in 1 file\n");
	expect(trace.out).toContain("2-2  caller  exported function  calls greet :2");
	expect(run("--cwd", fixture.root, JSON.stringify({ type: "lookup", query: "greet" })).out).toBe(lookup.out);
}, 30_000);

test("a failed batch slot leaves later requests available in text and JSON", () => {
	const batch = JSON.stringify([
		{ type: "trace", from: "NoSuchNameAtAll", direction: "reverse" },
		{ type: "lookup", query: "greet" },
	]);
	const text = run("--cwd", fixture.root, batch);
	expect(text.code).toBe(0);
	expect(text.out).toContain("=== 1: trace ===\nerror: NoSuchNameAtAll not found");
	expect(text.out).toContain("=== 2: lookup ===\nlookup for greet:");
	const json = run("--cwd", fixture.root, "--json", batch);
	expect(json.code).toBe(0);
	const values = JSON.parse(json.out) as {
		type: string;
		error?: string;
		tsconfig?: string;
		nestedProjects?: string[];
		nodes?: { name: string }[];
	}[];
	expect(values[0]).toEqual({
		type: "trace",
		error: expect.stringContaining("NoSuchNameAtAll not found"),
		tsconfig: "tsconfig.json",
		nestedProjects: [],
	});
	expect(values[1].nodes?.some(({ name }) => name === "greet")).toBe(true);
	expect(
		run(
			"--cwd",
			fixture.root,
			JSON.stringify([
				{ type: "trace", from: "NoSuchNameAtAll" },
				{ type: "trace", from: "AnotherMissingName" },
			]),
		).code,
	).toBe(1);
}, 30_000);

test("--in filters symbols and edges from the model", () => {
	const query = '{"type":"trace","from":"greet","direction":"reverse"}';
	const filtered = run("--cwd", fixture.root, "--in", "src/View.tsx", query);
	expect(filtered).toMatchObject({ code: 0, out: "trace reverse from greet: 0 shown\n\n(none)" });
	const json = run("--cwd", fixture.root, "--in", "src/View.tsx", "--json", query);
	const models = JSON.parse(json.out) as { nodes: unknown[]; edges: unknown[] }[];
	expect(models[0].nodes).toEqual([]);
	expect(models[0].edges).toEqual([]);
}, 30_000);

test("validation errors stay in full and JSON output stays structured", () => {
	const invalid = run("--cwd", fixture.root, '{"type":"lookup","query":42}');
	expect(invalid.code).toBe(1);
	expect(invalid.err).toBe("sightread: request.query must be string (got 42)");
	const json = run("--cwd", fixture.root, "--json", '{"type":"lookup","query":"greet"}');
	expect(json.code).toBe(0);
	const values = JSON.parse(json.out) as { type: string; nodes: { name: string }[]; sections: { hits: string[] } }[];
	expect(values).toHaveLength(1);
	expect(values[0].nodes.some(({ name }) => name === "greet")).toBe(true);
	expect(values[0].sections.hits).toContain("src/model.ts#greet:function");
	const raw = run("--cwd", fixture.root, "--raw", '{"type":"lookup","query":"greet"}');
	expect((JSON.parse(raw.out) as { audit: string }).audit).toContain("AUDITED");
	expect(run("--json", "--raw", '{"type":"lookup","query":"greet"}').code).toBe(1);
}, 30_000);

test("ps, stop and stop --all show live servers and stop them", () => {
	const projectOutput = run("--cwd", fixture.root, '{"type":"lookup","query":"greet"}');
	expect(projectOutput.code).toBe(0);
	const ps = run("ps");
	expect(ps.code).toBe(0);
	expect(ps.out).toMatch(
		new RegExp(`(?:^|\\n)\\d+\\t${fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\t\\d{4}-`),
	);
	expect(run("--cwd", fixture.root, "stop")).toMatchObject({ code: 0, out: "stopped" });
	expect(run("--cwd", fixture.root, "stop")).toMatchObject({ code: 0, out: "stopped" });
	expect(run("ps").out).not.toContain(fixture.root);
	expect(run("stop", "--all")).toMatchObject({ code: 0, out: "stopped" });
}, 30_000);
