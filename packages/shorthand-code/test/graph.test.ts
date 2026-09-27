/** Real runner and graph integration, including repository-relative scopes from a nested project. */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { Lang, parse } from "@ast-grep/napi";
import { openGraphProxy, resolveSightread } from "../src/runner/graph-proxy.ts";
import type { RunOptions, RunResult } from "../src/runner/runner.ts";
import registerCode from "../../pi-shorthand/src/index.ts";

const repoRoot = resolve(import.meta.dir, "../../..");
const cli = join(repoRoot, "packages/sightread/src/cli.ts");
const runner = join(repoRoot, "packages/shorthand-code/src/runner/runner.ts");
const root = await mkdtemp(join(tmpdir(), "shorthand-graph-"));
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

const files = {
	"client/tsconfig.json": JSON.stringify({
		compilerOptions: { target: "ESNext", jsx: "preserve", strict: true },
		include: ["src"],
	}),
	"client/src/service.ts": "export class Service { run(value: number) { return value + 1; } }\n",
	"client/src/namespace.ts": "export namespace Helpers { export function work() { return 1; } }\n",
	"client/src/same-line.ts":
		'export function sameLine(service: { run(n: number): number }) { const mark = "😀"; service.run(1); service.run(2); }\n',
	"client/src/callers.ts": [
		'import { Service } from "./service";',
		"export function use(service: Service) {",
		"  service.run(1);",
		"  return service.run(2);",
		"}",
		"class Other { run(value: number) { return value; } }",
		"export function unrelated(other: Other) { return other.run(3); }",
		"",
	].join("\n"),
	"client/src/View.tsx": [
		"type Row<T> = { id: string; value: T };",
		"export function View<T>({ rows }: { rows: Row<T>[] }) {",
		"  return <main><header><h1>Rows</h1></header><section>{rows.map((row) =>",
		"    <article key={row.id}><p>{String(row.value)}</p><small>{row.id}</small></article>",
		"  )}</section></main>;",
		"}",
	].join("\n"),
};

async function fixture() {
	const repo = join(root, `repo-${crypto.randomUUID()}`);
	await mkdir(repo);
	for (const [file, source] of Object.entries(files)) {
		await mkdir(join(repo, file, ".."), { recursive: true });
		await Bun.write(join(repo, file), source);
	}
	await $`git init -q`.cwd(repo);
	await $`git add -A`.cwd(repo);
	await $`git -c user.name=test -c user.email=test@test commit -qm init`.cwd(repo);
	return { repo, cwd: join(repo, "client") };
}

async function run(
	cwd: string,
	program: string,
	testHooks: RunOptions["testHooks"] = {},
	env: Record<string, string> = {},
	graph?: boolean,
): Promise<RunResult> {
	const input: RunOptions = {
		cwd,
		program,
		rollback: "all",
		timeoutMs: 2000,
		testHooks,
		...(graph === undefined ? {} : { graph }),
	};
	const child = Bun.spawn(["bun", runner], {
		stdin: new Response(JSON.stringify(input)),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...environment, ...env },
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exit !== 0) throw new Error(`runner exited ${exit}: ${stderr}`);
	return JSON.parse(stdout) as RunResult;
}

test("graph paths work unchanged with edit and sg", async () => {
	const { repo, cwd } = await fixture();
	const outcome = await run(
		cwd,
		`
const result = await graph.query({ type: "lookup", query: "use" });
const node = result.nodes.find((node) => node.name === "use");
console.log(JSON.stringify({ file: node.file, handle: node.handle, ranges: node.ranges }));
edit({ path: node.file, oldText: "service.run(1)", newText: "service.run(10)" });
console.log(sg.find("service.run(10)", node.file).length);
`,
	);
	expect(outcome.exitCode).toBe(0);
	expect(outcome.output).toContain('"file":"client/src/callers.ts"');
	expect(outcome.output).toContain("client/src/callers.ts#use:function");
	expect(outcome.output).toContain("\n1\n");
	expect(await Bun.file(join(repo, "client/src/callers.ts")).text()).toContain("service.run(10)");
}, 45_000);

test("one node-scoped rewrite changes both calls in a caller and leaves another same-named call", async () => {
	const { repo, cwd } = await fixture();
	const outcome = await run(
		cwd,
		`
const callers = await graph.query({ type: "trace", from: "Service.run", direction: "reverse" });
console.log(JSON.stringify({ nodes: callers.nodes.map(n => [n.name, n.file, n.ranges]), edges: callers.edges }));
console.log("rewritten", sg.rewrite("$X.run($$$ARGS)", "$X.execute($$$ARGS)", callers.nodes));
`,
	);
	expect(outcome.exitCode).toBe(0);
	expect(outcome.output).toContain("rewritten 2");
	const after = await Bun.file(join(repo, "client/src/callers.ts")).text();
	expect(after).toContain("service.execute(1)");
	expect(after).toContain("service.execute(2)");
	expect(after).toContain("other.run(3)");
	expect(outcome.changes.map(({ path }) => path)).toEqual(["src/callers.ts"]);
	expect(outcome.changes[0]?.patch).toContain("-  service.run(1);");
	expect(outcome.changes[0]?.patch).toContain("+  service.execute(1);");
	expect(outcome.changes[0]?.patch).toContain("-  return service.run(2);");
	expect(outcome.changes[0]?.patch).toContain("+  return service.execute(2);");
}, 45_000);

test("edited graph ranges are stale while path scope still works", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		`
const result = await graph.query({ type: "lookup", query: "use" });
const node = result.nodes.find(n => n.name === "use");
edit({ path: node.file, oldText: "service.run(1)", newText: "service.run(10)" });
try { sg.find("service.run($N)", node); } catch (error) { console.log(error.message); }
console.log("path matches", sg.find("service.run($N)", node.file).length);
`,
	);
	expect(outcome.exitCode).toBe(0);
	expect(outcome.output).toContain(
		"graph ranges for client/src/callers.ts are stale: this program already edited it. Query first, then pass every node to one sg call",
	);
	expect(outcome.output).toContain("path matches 2");
}, 45_000);

test("the stale guard also detects a direct Bun.write", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		`
const node = (await graph.query({ type: "lookup", query: "use" })).nodes.find(n => n.name === "use");
const source = await Bun.file("src/callers.ts").text();
await Bun.write("src/callers.ts", source.replace("service.run(1)", "service.run(10)"));
try { sg.find("service.run($N)", node); } catch (error) { console.log(error.message); }
`,
	);
	expect(outcome.output).toContain(
		"graph ranges for client/src/callers.ts are stale: this program already edited it. Query first, then pass every node to one sg call",
	);
}, 45_000);

test("wrong graph structures explain the usable scope", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		`
const result = await graph.query({ type: "trace", from: "Service.run", direction: "reverse" });
const handle = result.nodes.find(n => n.name === "use").handle;
for (const action of [
  () => sg.find("service.run($N)", handle),
  () => edit({ path: handle, oldText: "x", newText: "y" }),
  () => sg.file(handle),
  () => sg.find("service.run($N)", result),
  () => sg.find("service.run($N)", result.edges[0]),
]) { try { action(); } catch (error) { console.log(error.message); } }
console.log("edge span", sg.find("service.run($N)", result.edges[0].at).length);
`,
	);
	expect(outcome.exitCode).toBe(0);
	const handle = '"client/src/callers.ts#use:function" is a graph handle, not a path; pass the node, or node.file';
	expect(outcome.output.split(handle)).toHaveLength(4);
	expect(outcome.output).toContain("pass result.nodes (or a node), not the whole result");
	expect(outcome.output).toContain("an edge isn't a location; use edge.at for its span, or the node for edge.from");
	expect(outcome.output).toContain("edge span 1");
}, 45_000);

test("a range-free namespace member cannot widen sg to its file", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		`
const result = await graph.query({ type: "lookup", query: "Helpers.work" });
const node = result.nodes.find(n => n.name === "Helpers.work");
console.log("node", JSON.stringify(node));
try { sg.find("work", node); } catch (error) { console.log(error.message); }
console.log("site matches", sg.find("work", { ...node, site: { start: 1, end: 1 } }).length);
console.log("file matches", sg.find("work", node.file).length);
`,
	);
	expect(outcome.exitCode).toBe(0);
	expect(outcome.output).toContain('"ranges":null');
	expect(outcome.output).toContain(
		"graph node client/src/namespace.ts#Helpers.work:function has no line ranges, so it can't limit sg to that symbol; pass node.file to search the whole file",
	);
	expect(outcome.output).toContain("site matches 1");
	expect(outcome.output).toContain("file matches 1");
}, 45_000);

test("edge sites with columns select only the named call on a line", async () => {
	const { cwd } = await fixture();
	const outcome = await run(
		cwd,
		`
const source = await Bun.file("src/same-line.ts").text();
const col = source.indexOf("service.run(1)") + 1;
const site = { file: "client/src/same-line.ts", line: 1, col, endLine: 1, endCol: col + "service.run(1)".length };
console.log(JSON.stringify(sg.find("service.run($N)", site).map(m => m.text)));
console.log("line only", sg.find("service.run($N)", { file: site.file, line: 1 }).length);
`,
	);
	expect(outcome.exitCode).toBe(0);
	expect(outcome.output).toContain('["service.run(1)"]');
	expect(outcome.output).toContain("line only 2");
}, 45_000);

test("a program without graph leaves no sightread state", async () => {
	const { cwd } = await fixture();
	const emptyRuntime = await mkdtemp("/tmp/sr-no-");
	try {
		const outcome = await run(cwd, 'console.log("plain program");', {}, { XDG_RUNTIME_DIR: emptyRuntime });
		expect(outcome.exitCode).toBe(0);
		expect(outcome.output).toContain("plain program");
		expect(await readdir(emptyRuntime)).toEqual([]);
	} finally {
		await rm(emptyRuntime, { recursive: true, force: true });
	}
}, 45_000);

test("a five-second graph cold start is excluded from the default timeout", async () => {
	const { cwd } = await fixture();
	const outcome = await run(cwd, 'console.log((await graph.query({ type: "lookup", query: "Service" })).shown);', {
		graphColdStartDelayMs: 5000,
	});
	expect(outcome.exitCode).toBe(0);
	expect(outcome.timedOut).toBe(false);
	expect(outcome.output).toContain("2");
}, 45_000);

test("a graph the caller doesn't offer reports that it is disabled", async () => {
	const { cwd } = await fixture();
	const outcome = await run(cwd, 'await graph.query({ type: "lookup", query: "Service" });', {}, {}, false);
	expect(outcome.exitCode).toBe(1);
	expect(outcome.output).toContain("graph.query isn't available in this session.");
}, 45_000);

const importer = (specifier: string) =>
	specifier === "sightread" ? Promise.reject(new Error("unavailable")) : import(specifier);

function proxyReply(path: string, request: string, waitForClose = false): Promise<{ error?: string; value?: unknown }> {
	return new Promise((done, reject) => {
		const socket = createConnection(path);
		let output = "";
		let response: { error?: string; value?: unknown } | undefined;
		socket.on("error", reject);
		socket.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("\n")) {
				response = JSON.parse(output.slice(0, output.indexOf("\n"))) as { error?: string; value?: unknown };
				if (!waitForClose) {
					socket.end();
					done(response);
				}
			}
		});
		if (waitForClose) socket.on("end", () => done(response ?? {}));
		socket.on("connect", () => socket.write(request));
	});
}

test("proxy caps request lines and connections, then keeps serving", async () => {
	const directory = await mkdtemp(join(root, "limits-"));
	const proxy = await openGraphProxy(directory, root, root, {
		resolve: async () => ({ openGraph: async () => ({ query: async () => ({ ok: true }), close: async () => {} }) }),
	});
	const held = [];
	try {
		const long = await proxyReply(proxy.path, `${"x".repeat(1024 * 1024 + 1)}\n`, true);
		expect(long.error).toContain("1 MiB");
		expect((await proxyReply(proxy.path, "{}\n")).value).toEqual({ ok: true });
		for (let i = 0; i < 16; i++) {
			const socket = createConnection(proxy.path);
			await new Promise<void>((done, reject) => {
				socket.once("connect", done);
				socket.once("error", reject);
			});
			held.push(socket);
		}
		expect((await proxyReply(proxy.path, "{}\n")).error).toContain("16");
		for (const socket of held) socket.destroy();
		await Bun.sleep(30);
		expect((await proxyReply(proxy.path, "{}\n")).value).toEqual({ ok: true });
	} finally {
		for (const socket of held) socket.destroy();
		await proxy.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 45_000);

test("proxy close does not wait for startup and closes a graph that arrives later", async () => {
	for (const late of [false, true]) {
		const directory = await mkdtemp(join(root, "stalled-"));
		let finish:
			| ((value: { openGraph: () => Promise<{ query: () => Promise<unknown>; close: () => Promise<void> }> }) => void)
			| undefined;
		let closed = 0;
		const proxy = await openGraphProxy(directory, root, root, {
			resolve: () =>
				new Promise((done) => {
					finish = done;
				}),
		});
		const socket = createConnection(proxy.path);
		try {
			await new Promise<void>((done) => socket.once("connect", done));
			socket.write("{}\n");
			await Bun.sleep(20);
			const started = performance.now();
			await Promise.race([
				proxy.close(),
				Bun.sleep(1900).then(() => {
					throw new Error("close stalled");
				}),
			]);
			expect(performance.now() - started).toBeLessThan(2000);
			if (late) {
				finish?.({
					openGraph: async () => ({
						query: async () => ({}),
						close: async () => {
							closed++;
						},
					}),
				});
				await Bun.sleep(20);
				expect(closed).toBe(1);
			}
		} finally {
			socket.destroy();
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("resolver follows a global sightread symlink, and reports absence", async () => {
	expect(await resolveSightread({ executable: null, cache: false })).toHaveProperty("openGraph");
	expect(await resolveSightread({ importer, executable: join(bin, "sightread"), cache: false })).toHaveProperty(
		"openGraph",
	);
	expect(await resolveSightread({ importer, executable: null, cache: false })).toBeUndefined();
});

test("resolver uses matching PATH sightread after an outdated import", async () => {
	const fake = join(root, `outdated-${crypto.randomUUID()}`);
	await mkdir(fake);
	await Bun.write(join(fake, "package.json"), JSON.stringify({ name: "sightread", version: "0.8.0" }));
	await Bun.write(join(fake, "index.ts"), "");
	const direct = {
		openGraph: async () => {
			throw new Error("outdated");
		},
	};
	const matching = {
		openGraph: async () => {
			throw new Error("matching");
		},
	};
	try {
		const found = await resolveSightread({
			importer: async (specifier) => (specifier === "sightread" ? direct : matching),
			importedEntry: join(fake, "index.ts"),
			executable: join(bin, "sightread"),
			cache: false,
			strictVersion: true,
		} as Parameters<typeof resolveSightread>[0] & { importedEntry: string });
		expect(found).toBe(matching);
	} finally {
		await rm(fake, { recursive: true, force: true });
	}
});

test("a mismatched global sightread version fails through the graph proxy", async () => {
	const fake = join(root, "older-sightread");
	const directory = await mkdtemp(join(root, "version-proxy-"));
	await mkdir(join(fake, "bin"), { recursive: true });
	await Bun.write(
		join(fake, "package.json"),
		JSON.stringify({ name: "sightread", version: "0.8.0", exports: { ".": "./index.ts" } }),
	);
	await Bun.write(join(fake, "bin/sightread"), "");
	const locate = (strictVersion = false) =>
		resolveSightread({ importer, executable: join(fake, "bin/sightread"), cache: false, strictVersion });
	const message = "graph needs sightread 0.9.0 (found 0.8.0); npm i -g sightread@0.9.0";
	expect(await locate()).toBeUndefined();
	await expect(locate(true)).rejects.toThrow(message);
	const proxy = await openGraphProxy(directory, root, root, { resolve: () => locate(true) });
	try {
		const response = await new Promise<string>((done, reject) => {
			const socket = createConnection(proxy.path);
			let output = "";
			socket.on("error", reject);
			socket.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes("\n")) {
					socket.end();
					done(output);
				}
			});
			socket.on("connect", () => socket.write('{"type":"lookup","query":"Service"}\n'));
		});
		expect(JSON.parse(response)).toEqual({ error: message });
	} finally {
		await proxy.close();
		await rm(fake, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

test("aborted graph sockets leave the host proxy serving and do not change its cache environment", async () => {
	const { repo, cwd } = await fixture();
	const directory = await mkdtemp(join(root, "proxy-"));
	const before = process.env.TTSC_CACHE_DIR;
	const originalRuntime = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = runtime;
	const proxy = await openGraphProxy(directory, cwd, repo, {
		resolve: () => resolveSightread({ importer, executable: join(bin, "sightread"), cache: false }),
	});
	try {
		await Promise.all(
			Array.from(
				{ length: 80 },
				() =>
					new Promise<void>((done) => {
						const socket = createConnection(proxy.path);
						socket.on("error", () => done());
						socket.on("close", () => done());
						socket.on("connect", () => {
							socket.write('{"type":"lookup","query":"Service"}\n', () => socket.destroy());
						});
					}),
			),
		);
		let result: { value?: { nodes: { name: string; file: string }[] }; error?: string } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			result = (await proxyReply(proxy.path, '{"type":"lookup","query":"Service"}\n')) as typeof result;
			if (result.error !== "graph proxy allows at most 16 connections") break;
			await Bun.sleep(20);
		}
		if (result.error) throw new Error(result.error);
		expect(result.value?.nodes.some((node) => node.name === "Service" && node.file === "client/src/service.ts")).toBe(
			true,
		);
		expect(process.env.TTSC_CACHE_DIR).toBe(before);
	} finally {
		await proxy.close();
		expect(await Bun.spawn(["bun", cli, "--cwd", cwd, "stop"], { env: environment }).exited).toBe(0);
		if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = originalRuntime;
		await rm(directory, { recursive: true, force: true });
	}
}, 45_000);

async function description(available: boolean) {
	let result = "";
	await registerCode(
		{
			on() {},
			registerTool(tool: { description: string }) {
				result = tool.description;
			},
		} as unknown as Parameters<typeof registerCode>[0],
		async () =>
			available
				? {
						openGraph: async () => {
							throw new Error("unused");
						},
					}
				: undefined,
	);
	return result;
}

test("the tool describes graph only when resolution succeeds", async () => {
	expect(await description(true)).toContain("graph.query");
	expect(await description(true)).toContain("graph results can be passed to sg as scope");
	expect(await description(true)).toContain("graph shows the repository before this program's edits");
	expect(await description(false)).not.toContain("graph.query");
});

test("the realistic JSX fixture has a different TypeScript and TSX function range", () => {
	const source = files["client/src/View.tsx"];
	const pattern = { rule: { kind: "function_declaration" } };
	const ts = parse(Lang.TypeScript, source).root().find(pattern);
	const tsx = parse(Lang.Tsx, source).root().find(pattern);
	expect(ts?.range().end.line).toBe(4);
	expect(tsx?.range().end.line).toBe(5);
});
