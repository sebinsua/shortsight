// Check repository-relative graph paths against a nested Git project.
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGraph } from "../src/index.ts";
import { createPaths } from "../src/paths.ts";
import { renderText } from "../src/render.ts";
import { stopServer } from "../src/server/client.ts";

const repo = mkdtempSync(join(tmpdir(), "sightread-paths-"));
const project = join(repo, "client");
const runtime = mkdtempSync("/tmp/spr-");
const previousRuntime = process.env.XDG_RUNTIME_DIR;
process.env.XDG_RUNTIME_DIR = runtime;
mkdirSync(join(project, "src/ui"), { recursive: true });
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(project, "tsconfig.json"), '{"compilerOptions":{"jsx":"preserve"}}');
writeFileSync(join(project, "src/ui/find.ts"), "export function findProject() { return 1; }\n");
writeFileSync(
	join(project, "src/ui/call.ts"),
	"import { findProject } from './find';\nexport function callProject() { return findProject(); }\n",
);
writeFileSync(join(project, "src/other.ts"), "export function other() { return 2; }\n");
writeFileSync(join(repo, "src/other.ts"), "export function outside() { return 3; }\n");
writeFileSync(
	join(project, "src/ui/View.tsx"),
	[
		"type Row<T> = { id: string; value: T };",
		"export function View<T>({ rows }: { rows: Row<T>[] }) {",
		"  return <main><h1>Rows</h1><section>{rows.map((row) =>",
		"    <article key={row.id}><p>{String(row.value)}</p></article>",
		"  )}</section></main>;",
		"}",
	].join("\n"),
);
execFileSync("git", ["init", "-q"], { cwd: repo });

afterAll(async () => {
	await stopServer({ root: project, tsconfig: join(project, "tsconfig.json") });
	rmSync(repo, { recursive: true, force: true });
	rmSync(runtime, { recursive: true, force: true });
	if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntime;
});

function cli(...args: string[]) {
	const child = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "--cwd", project, ...args], {
		cwd: repo,
		env: { ...Bun.env, XDG_RUNTIME_DIR: runtime },
	});
	return {
		code: child.exitCode,
		out: new TextDecoder().decode(child.stdout).trimEnd(),
		err: new TextDecoder().decode(child.stderr).trimEnd(),
	};
}

test("text, JSON, library, raw, and round-trip handles use their promised path bases", async () => {
	const graph = await openGraph({ cwd: project });
	try {
		const lookup = await graph.query({ type: "lookup", query: "findProject" });
		const handle = "client/src/ui/find.ts#findProject:function";
		expect(lookup.sections.hits).toContain(handle);
		expect(lookup.nodes.find((node) => node.handle === handle)?.file).toBe("client/src/ui/find.ts");
		expect(renderText(lookup, { color: false })).toBe(
			"lookup: 2 shown\n\nhits\n  = findProject  exported function  client/src/ui/find.ts:1-1\n    callProject  exported function  client/src/ui/call.ts:2-2",
		);
		for (const node of lookup.nodes) {
			const details = await graph.query({ type: "details", handles: [node.handle] });
			expect(details.nodes.map((item) => item.handle)).toContain(node.handle);
		}
		for (const input of [handle, "src/ui/find.ts#findProject:function"]) {
			const details = await graph.query({ type: "details", handles: [input] });
			expect(details.nodes.map((item) => item.handle)).toContain(handle);
			const trace = await graph.query({ type: "trace", from: input });
			expect(trace.nodes.map((item) => item.handle)).toContain(handle);
		}
		const impact = await graph.query({ type: "trace", from: handle, direction: "reverse" });
		expect(impact.edges).toEqual([
			{
				from: "client/src/ui/call.ts#callProject:function",
				to: handle,
				kind: "calls",
				at: { file: "client/src/ui/call.ts", line: 2, col: 40, endLine: 2, endCol: 51 },
			},
		]);
		const collision = await graph.query({ type: "details", handles: ["client/src/other.ts#other:function"] });
		expect(collision.nodes.map((item) => item.handle)).toContain("client/src/other.ts#other:function");
		expect(cli(JSON.stringify({ type: "lookup", query: "findProject" })).out).toBe(
			"lookup for findProject: 2 shown\n\nhits\n  = findProject  exported function  client/src/ui/find.ts:1-1\n    callProject  exported function  client/src/ui/call.ts:2-2",
		);
		const json = cli("--json", JSON.stringify({ type: "lookup", query: "findProject" }));
		expect(json.code).toBe(0);
		expect(JSON.parse(json.out)[0].sections.hits).toContain(handle);
		const raw = cli("--raw", JSON.stringify({ type: "lookup", query: "findProject" }));
		expect(raw.code).toBe(0);
		expect(raw.out).toContain("src/ui/find.ts#findProject:function");
		expect(raw.out).not.toContain(handle);
	} finally {
		await graph.close();
	}
}, 30_000);

test("--in accepts either path form and a missing path stays unchanged", () => {
	const request = JSON.stringify({ type: "lookup", query: "View" });
	for (const directory of ["client/src/ui", "src/ui"]) {
		const result = cli("--in", directory, "--json", request);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out)[0].sections.hits).toContain("client/src/ui/View.tsx#View:function");
	}
	const paths = createPaths(project);
	expect(paths.toProjectPath("absent/Thing.ts")).toBe("absent/Thing.ts");
	expect(paths.toProjectHandle("absent/Thing.ts#Thing:function")).toBe("absent/Thing.ts#Thing:function");
	const missing = cli("--raw", JSON.stringify({ type: "details", handles: ["absent/Thing.ts#Thing:function"] }));
	expect(missing.code).toBe(0);
	expect(JSON.parse(missing.out).result.unknown).toEqual(["absent/Thing.ts#Thing:function"]);
}, 30_000);

test("repository-root and non-Git projects keep their original paths", () => {
	const rootRepo = mkdtempSync("/tmp/spr-root-");
	const noGit = mkdtempSync("/tmp/spr-nogit-");
	try {
		writeFileSync(join(rootRepo, "tsconfig.json"), "{}");
		writeFileSync(join(rootRepo, "View.tsx"), "export const View = () => <main />;\n");
		execFileSync("git", ["init", "-q"], { cwd: rootRepo });
		const rootPaths = createPaths(rootRepo);
		expect(rootPaths.toRepositoryHandle("View.tsx#View:variable")).toBe("View.tsx#View:variable");
		expect(rootPaths.toProjectHandle("View.tsx#View:variable")).toBe("View.tsx#View:variable");
		const nested = join(noGit, "client");
		mkdirSync(nested);
		writeFileSync(join(nested, "tsconfig.json"), "{}");
		writeFileSync(join(nested, "View.tsx"), "export const View = () => <main />;\n");
		const localPaths = createPaths(nested);
		expect(localPaths.repository).toBe(localPaths.project);
		expect(localPaths.toRepositoryHandle("View.tsx#View:variable")).toBe("View.tsx#View:variable");
	} finally {
		rmSync(rootRepo, { recursive: true, force: true });
		rmSync(noGit, { recursive: true, force: true });
	}
});

test("upstream project-relative paths ignore colliding repository files", () => {
	writeFileSync(join(repo, "src/a.ts"), "export const outside = 1;\n");
	writeFileSync(join(project, "src/a.ts"), "export const inside = 1;\n");
	const paths = createPaths(project);
	expect(paths.toRepositoryPath("src/a.ts")).toBe("client/src/a.ts");
	expect(paths.toRepositoryHandle("src/a.ts#inside:variable")).toBe("client/src/a.ts#inside:variable");
	expect(paths.toProjectPath("client/src/a.ts")).toBe("src/a.ts");
	expect(paths.toProjectPath("src/a.ts")).toBe("src/a.ts");
});

test("handle conversion keeps hashes in nested project file names", () => {
	writeFileSync(join(project, "src/a#b.ts"), "export function foo() {}\n");
	const paths = createPaths(project);
	expect(paths.toRepositoryHandle("src/a#b.ts#foo:function")).toBe("client/src/a#b.ts#foo:function");
	expect(paths.toProjectHandle("client/src/a#b.ts#foo:function")).toBe("src/a#b.ts#foo:function");
	expect(paths.inputToProjectHandle("client/src/a#b.ts#foo:function")).toBe("src/a#b.ts#foo:function");
});

test("near misses suggest names and unrelated misses stay quiet", async () => {
	const graph = await openGraph({ cwd: project });
	try {
		await expect(graph.query({ type: "trace", from: "findProjct" })).rejects.toThrow(
			"findProjct not found; nearest: client/src/ui/find.ts#findProject:function",
		);
		await expect(graph.query({ type: "trace", from: "NoSuchThing" })).rejects.toThrow(/^NoSuchThing not found$/);
	} finally {
		await graph.close();
	}
}, 30_000);
