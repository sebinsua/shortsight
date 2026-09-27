/** Compiler-resolved references and qualified refactors through real shorthand programs. */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { Lang, parse } from "@ast-grep/napi";
import type { RunOptions, RunResult } from "../src/runner/runner.ts";

const workspace = resolve(import.meta.dir, "../../..");
const cli = join(workspace, "packages/sightread/src/cli.ts");
const runner = join(workspace, "packages/shorthand-code/src/runner/runner.ts");
const root = await mkdtemp(join(tmpdir(), "shorthand-references-"));
const runtime = await mkdtemp("/tmp/sr-");
const bin = join(root, "bin");
await mkdir(bin);
await symlink(cli, join(bin, "sightread"));
const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: runtime };

afterAll(async () => {
	expect(await Bun.spawn(["bun", cli, "stop", "--all"], { env: environment }).exited).toBe(0);
	await rm(root, { recursive: true, force: true });
	await rm(runtime, { recursive: true, force: true });
});

const component = [
	"import { Row } from './row';",
	"type Entry<T> = { id: string; item: T };",
	"export function Table<T>({ rows }: { rows: Entry<Row>[] }) {",
	"  return <main><header><h1>Rows</h1></header><section><ul>{rows.map(({ id, item }) =>",
	"    <li key={id} data-row={id}><strong>{item.get(5)}</strong><small>{id}</small></li>",
	"  )}</ul></section></main>;",
	"}",
	"",
].join("\n");

const sources = {
	"client/tsconfig.json": JSON.stringify({
		compilerOptions: { target: "ESNext", jsx: "preserve", strict: true },
		include: ["src"],
	}),
	"client/src/row.ts": [
		"export class Row {",
		"  get(value: number) { return value + 1; }",
		"}",
		"export class Cache {",
		"  get(value: number) { return value + 2; }",
		"}",
		"",
	].join("\n"),
	"client/src/use.ts": [
		'import { Row as AliasedRow, Cache } from "./row";',
		"export function use(row: AliasedRow, cache: Cache) {",
		"  const first = row.get(1);",
		"  const second = row.get(2);",
		"  const unrelated = cache.get(3);",
		"  const get = (value: number) => value;",
		"  const shadow = get(4);",
		'  const label = "get";',
		"  // get",
		"  return first + second + unrelated + shadow + label.length;",
		"}",
		"export function fromAlias(row: AliasedRow) { return row.get(6); }",
		"",
	].join("\n"),
	"client/src/Table.tsx": component,
	"client/src/alias.ts": "export function fetch(value = 0) { return value + 1; }\n",
	"client/src/create.ts": 'import { Row } from "./row"; export const created = new Row();\n',
	"client/src/alias-use.ts":
		'import { fetch as localFetch } from "./alias";\nexport const value = localFetch() + localFetch();\n',
};

async function fixture() {
	const repo = join(root, `repo-${crypto.randomUUID()}`);
	await mkdir(repo);
	for (const [file, source] of Object.entries(sources)) {
		await mkdir(join(repo, file, ".."), { recursive: true });
		await Bun.write(join(repo, file), source);
	}
	await $`git init -q`.cwd(repo);
	await $`git add -A`.cwd(repo);
	await $`git -c user.name=test -c user.email=test@test commit -qm init`.cwd(repo);
	return { repo, cwd: join(repo, "client") };
}

async function run(cwd: string, program: string): Promise<RunResult> {
	const input: RunOptions = { cwd, program, rollback: "all", timeoutMs: 2000 };
	const child = Bun.spawn(["bun", runner], {
		stdin: new Response(JSON.stringify(input)),
		stdout: "pipe",
		stderr: "pipe",
		env: environment,
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exit !== 0) throw new Error(`runner exited ${exit}: ${stderr}`);
	return JSON.parse(stdout) as RunResult;
}

const select = 'await refactor.references({ file: "client/src/row.ts", symbol: "Row.get" })';
const rewrite = `const refs = ${select}; console.log("references", JSON.stringify(refs.map(m => [m.file, m.line, m.text, m.node.parent()?.kind()]))); console.log("rewritten", sg.rewrite(refs, m => "read"));`;

test("references are exact identifiers across aliased imports and TSX", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		`const refs = ${select}; console.log(JSON.stringify(refs.map(m => [m.file, m.line, m.text, m.node.parent()?.kind()])));`,
	);
	if (outcome.exitCode !== 0) throw new Error(outcome.output);
	expect(outcome.output).toContain(
		JSON.stringify([
			["client/src/Table.tsx", 5, "get", "member_expression"],
			["client/src/use.ts", 3, "get", "member_expression"],
			["client/src/use.ts", 4, "get", "member_expression"],
			["client/src/use.ts", 12, "get", "member_expression"],
		]),
	);
	const included = await run(
		cwd,
		`console.log(JSON.stringify((await refactor.references({ file: "client/src/row.ts", symbol: "Row.get", includeDeclaration: true })).map(m => [m.file, m.line])));`,
	);
	expect(included.output).toContain('["client/src/row.ts",2]');
	const tsx = parse(Lang.Tsx, component)
		.root()
		.findAll({ rule: { kind: "call_expression" } });
	const ts = parse(Lang.TypeScript, component)
		.root()
		.findAll({ rule: { kind: "call_expression" } });
	expect(tsx.find((node) => node.text().includes("item.get(5)"))?.range()).not.toEqual(
		ts.find((node) => node.text().includes("item.get(5)"))?.range(),
	);
}, 45_000);

test("bracket-access references rewrite the string contents alongside dot access", async () => {
	const { cwd } = await fixture();
	await Bun.write(
		join(cwd, "src/bracket.ts"),
		'import { Row } from "./row";\nexport function use(row: Row) { return row.get(1) + row["get"](2); }\n',
	);
	const outcome = await run(
		cwd,
		'const refs = (await refactor.references({ file: "client/src/row.ts", symbol: "Row.get" })).filter(m => m.file === "client/src/bracket.ts"); console.log(JSON.stringify(refs.map(m => m.text))); console.log("rewritten", sg.rewrite(refs, () => "renamed"));',
	);
	expect(outcome.exitCode).toBe(0);
	expect(outcome.output).toContain('["get","get"]');
	expect(outcome.output).toContain("rewritten 2");
	expect(outcome.changes.find((change) => change.path === "src/bracket.ts")?.patch).toContain(
		'row.renamed(1) + row["renamed"](2)',
	);
}, 45_000);

test("an imported alias contributes its binding and every resolved use", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		'console.log(JSON.stringify((await refactor.references({ file: "client/src/alias.ts", symbol: "fetch" })).map(m => [m.file, m.line, m.text])));',
	);
	expect(outcome.exitCode).toBe(0);
	expect(outcome.output).toContain(
		JSON.stringify([
			["client/src/alias-use.ts", 1, "fetch"],
			["client/src/alias-use.ts", 2, "localFetch"],
			["client/src/alias-use.ts", 2, "localFetch"],
		]),
	);
}, 45_000);

test("a migration adds an argument to calls through an import alias", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		'const refs = await refactor.references({ file: "client/src/alias.ts", symbol: "fetch" }); console.log("rewritten", sg.rewrite(refs, m => { const call = m.node.parent(); return call?.kind() === "call_expression" ? call.replace(`${m.text}(7)`) : null; }));',
	);
	if (outcome.exitCode !== 0) throw new Error(outcome.output);
	expect(outcome.output).toContain("rewritten 2");
	expect(outcome.changes.map((change) => change.path)).toEqual(["src/alias-use.ts"]);
	expect(outcome.changes[0]?.patch).toContain("+export const value = localFetch(7) + localFetch(7);");
	expect(outcome.changes[0]?.patch).not.toContain("+import");
}, 45_000);

test("reference call spans allow argument edits for methods and aliases", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		`
const methods = await refactor.references({ file: "client/src/row.ts", symbol: "Row.get" });
const aliases = await refactor.references({ file: "client/src/alias.ts", symbol: "fetch" });
console.log("calls", JSON.stringify([...methods, ...aliases].map(m => [m.text, m.call?.kind()])));
const add = m => m.call?.replace(m.call.text().replace(/\\)$/, m.call.text().endsWith("()") ? "9)" : ", 9)"));
console.log("methods", sg.rewrite(methods, add));
console.log("aliases", sg.rewrite(aliases, add));
`,
	);
	if (outcome.exitCode !== 0) throw new Error(outcome.output);
	expect(outcome.output).toContain('"get","call_expression"');
	expect(outcome.output).toContain('"localFetch","call_expression"');
	expect(outcome.output).toContain("methods 4");
	expect(outcome.output).toContain("aliases 2");
	expect(outcome.changes.find((change) => change.path === "src/use.ts")?.patch).toContain("row.get(1, 9)");
	expect(outcome.changes.find((change) => change.path === "src/alias-use.ts")?.patch).toContain("localFetch(9)");
}, 45_000);

test("constructor references expose new expressions and import bindings have no call", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		`
const refs = await refactor.references({ file: "client/src/row.ts", symbol: "Row", includeDeclaration: true });
console.log(JSON.stringify(refs.filter(m => m.file === "client/src/create.ts").map(m => [m.text, m.call?.kind() ?? null])));
`,
	);
	if (outcome.exitCode !== 0) throw new Error(outcome.output);
	expect(outcome.output).toContain('[["Row",null],["Row","new_expression"]]');
}, 45_000);

test("selected references rewrite only resolved sites and reject stale selections", async () => {
	const { cwd } = await fixture();
	const outcome = await run(cwd, rewrite);
	if (outcome.exitCode !== 0) throw new Error(outcome.output);
	expect(outcome.output).toContain("rewritten 4");
	expect(outcome.changes.map((change) => change.path)).toEqual(["src/Table.tsx", "src/use.ts"]);
	expect(outcome.changes[0]?.patch).toContain("+    <li key={id} data-row={id}><strong>{item.read(5)}</strong>");
	expect(outcome.changes[1]?.patch).toContain("+  const first = row.read(1);");
	expect(outcome.changes[1]?.patch).toContain("+  const second = row.read(2);");
	expect(outcome.changes[1]?.patch).toContain("+export function fromAlias(row: AliasedRow) { return row.read(6); }");
	expect(outcome.changes[1]?.patch).not.toContain("+  const unrelated = cache.read(3);");
	const staleFixture = await fixture();
	const stale = await run(
		staleFixture.cwd,
		`const refs = ${select}; edit({ path: "client/src/use.ts", oldText: "row.get(1)", newText: "row.get(10)" }); sg.rewrite(refs, () => "read");`,
	);
	expect(stale.exitCode).toBe(1);
	expect(stale.output).toContain("this match predates a change to its file");
}, 45_000);

test("qualified rename and ambiguous unqualified name", async () => {
	const { cwd } = await fixture();
	const ambiguous = await run(cwd, 'await refactor.rename({ file: "client/src/row.ts", symbol: "get", to: "read" });');
	expect(ambiguous.exitCode).toBe(1);
	expect(ambiguous.output).toContain('"get" is ambiguous in client/src/row.ts; use one of: Row.get, Cache.get');
	const renamed = await run(
		cwd,
		'await refactor.rename({ file: "client/src/row.ts", symbol: "Row.get", to: "read" });',
	);
	expect(renamed.exitCode).toBe(0);
	expect(renamed.changes.map((change) => change.path).toSorted()).toEqual([
		"src/Table.tsx",
		"src/row.ts",
		"src/use.ts",
	]);
	expect(renamed.changes.find((change) => change.path === "src/use.ts")?.patch).toContain(
		"+  const first = row.read(1);",
	);
	expect(renamed.changes.find((change) => change.path === "src/use.ts")?.patch).not.toContain("cache.read(3)");
}, 45_000);

test("graph nodes and handles select refactor targets", async () => {
	const { cwd } = await fixture();
	const refs = await run(
		cwd,
		'const node = (await graph.query({ type: "lookup", query: "Row.get" })).nodes.find(n => n.name === "Row.get"); console.log("node", JSON.stringify(node)); console.log("refs", (await refactor.references({ file: node })).length); try { await refactor.references({ file: node.handle, symbol: "Row.get" }); } catch (error) { console.log(error.message); }',
	);
	expect(refs.exitCode).toBe(0);
	expect(refs.output).toContain("refs 4");
	expect(refs.output).toContain("is a graph handle, not a path; pass the node, or node.file");
	const renamed = await run(
		cwd,
		'const node = (await graph.query({ type: "lookup", query: "Row.get" })).nodes.find(n => n.name === "Row.get"); await refactor.rename({ file: node, to: "read" });',
	);
	expect(renamed.exitCode).toBe(0);
	expect(renamed.changes.find((change) => change.path === "src/row.ts")?.patch).toContain("+  read(value: number)");
}, 45_000);

test("graph callers decide scope, references produce the same exact rewrite", async () => {
	const directFixture = await fixture();
	const guidedFixture = await fixture();
	const direct = await run(directFixture.cwd, rewrite);
	const guided = await run(
		guidedFixture.cwd,
		`const callers = await graph.query({ type: "trace", from: "Row.get", direction: "reverse" }); if (!callers.edges.length) throw new Error("missing callers"); ${rewrite}`,
	);
	if (guided.exitCode !== 0) throw new Error(guided.output);
	expect(guided.changes).toEqual(direct.changes);
}, 45_000);
