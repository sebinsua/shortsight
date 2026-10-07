/**
 * Runs real programs through runner.ts against small throwaway git repositories.
 * Needs the platform's overlay: AgentFS on macOS (or AGENTFS_BIN), bubblewrap on Linux.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { runWithBun } from "../src/runner/client.ts";
import { openLinuxOverlay } from "../src/linux/overlay-linux.ts";
import type { RunOptions, RunResult } from "../src/runner/runner.ts";

setDefaultTimeout(30_000);

const RUNNER = path.join(import.meta.dir, "../src/runner/runner.ts");
const hasOverlay =
	process.platform === "darwin"
		? Boolean(process.env.AGENTFS_BIN ?? Bun.which("agentfs"))
		: Boolean(Bun.which("bwrap"));

const repos: string[] = [];
const temporaryRoots: string[] = [];
afterEach(async () => {
	for (const repo of repos.splice(0)) await rm(path.dirname(repo), { recursive: true, force: true });
	for (const root of temporaryRoots.splice(0)) {
		await chmod(path.join(root, "work/work"), 0o700).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

/** A new git repository with these files committed. */
async function makeRepo(files: Record<string, string>): Promise<string> {
	const repo = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "pi-shorthand-test-"))), "repo");
	await mkdir(repo);
	for (const [file, contents] of Object.entries(files)) await Bun.write(path.join(repo, file), contents);
	await $`git init -q && git add -A && git -c user.name=test -c user.email=test@test commit -qm init`.cwd(repo);
	repos.push(repo);
	return repo;
}

function startRunner(
	repo: string,
	program: string,
	options: Partial<RunOptions> = {},
	environment: Record<string, string> = {},
) {
	const input: RunOptions = { cwd: repo, program, timeoutMs: 5000, rollback: "all", ...options };
	return Bun.spawn(["bun", RUNNER], {
		stdin: new Response(JSON.stringify(input)),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...environment },
	});
}

type TestHooks = NonNullable<RunOptions["testHooks"]>;
type ApplicationTestHooks = NonNullable<TestHooks["apply"]>;

function withTestHooks(testHooks: TestHooks): Partial<RunOptions> {
	return { testHooks };
}

function withApplicationTestHooks(apply: ApplicationTestHooks): Partial<RunOptions> {
	return withTestHooks({ apply });
}

async function waitUntil(
	description: string,
	predicate: () => boolean | Promise<boolean>,
	// This is a synchronization deadline, not a workspace latency assertion.
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	do {
		if (await predicate()) return;
		await Bun.sleep(20);
	} while (performance.now() < deadline);
	throw new Error(`Timed out waiting for ${description}`);
}

async function waitForFile(file: string): Promise<void> {
	await waitUntil(`${JSON.stringify(file)} to exist`, () => Bun.file(file).exists());
}

async function runnerOutcome(runner: ReturnType<typeof startRunner>) {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(runner.stdout).text(),
		new Response(runner.stderr).text(),
		runner.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function run(
	repo: string,
	program: string,
	options: Partial<RunOptions> = {},
	environment: Record<string, string> = {},
): Promise<RunResult> {
	const runner = startRunner(repo, program, options, environment);
	const { stdout, stderr, exitCode } = await runnerOutcome(runner);
	if (exitCode !== 0) throw new Error(`runner failed: ${stderr}`);
	return JSON.parse(stdout);
}

async function gitStatus(repo: string): Promise<string> {
	return (await $`git status --short`.cwd(repo).text()).trim();
}

async function textIfFile(file: string): Promise<string | undefined> {
	try {
		return await Bun.file(file).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

test.skipIf(process.platform !== "linux")(
	"the Linux backend removes OverlayFS's mode-000 work directory as the invoking user",
	async () => {
		const repo = await makeRepo(FILES);
		const tempRoot = await realpath(await mkdtemp(path.join(tmpdir(), "pi-shorthand-overlay-cleanup-")));
		temporaryRoots.push(tempRoot);
		const overlay = await openLinuxOverlay(repo, tempRoot);
		const mounted = Bun.spawn(overlay.wrap(["true"], repo), { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(mounted.stderr).text();
		expect(await mounted.exited, stderr).toBe(0);

		const internalWork = path.join(tempRoot, "work/work");
		expect((await lstat(internalWork)).mode & 0o777).toBe(0);
		await overlay.close();

		expect(await lstat(tempRoot).catch(() => null)).toBeNull();
	},
);

function macRecoveryFile(repo: string): string {
	const checkout = createHash("sha256").update(repo).digest("hex").slice(0, 16);
	return path.join(homedir(), ".cache", "pi-shorthand", "macos-mounts", `${checkout}.json`);
}

const FILES = {
	"src/api.ts": "export function oldApi(a: number) {\n\treturn a;\n}\n",
	"src/a.ts": 'import { oldApi } from "./api";\nexport const a = oldApi(1);\n',
	"src/b.ts": 'import { oldApi } from "./api";\nexport const b = oldApi(2);\n',
};

async function makeMetadataRepo(): Promise<string> {
	const repo = await makeRepo({
		"make-executable.sh": "#!/bin/sh\necho add\n",
		"remove-executable.sh": "#!/bin/sh\necho remove\n",
		"regular-to-link": "regular\n",
		"target-a": "a\n",
		"target-b": "b\n",
	});
	await chmod(path.join(repo, "make-executable.sh"), 0o644);
	await chmod(path.join(repo, "remove-executable.sh"), 0o755);
	await symlink("target-a", path.join(repo, "symlink-to-regular"));
	await symlink("target-a", path.join(repo, "retarget-link"));
	await symlink("target-a", path.join(repo, "delete-link"));
	await $`git add -A && git -c user.name=test -c user.email=test@test commit -qm metadata`.cwd(repo);
	return repo;
}

const METADATA_PROGRAM = `
	const fs = await import("node:fs/promises");
	await fs.chmod("make-executable.sh", 0o755);
	await fs.chmod("remove-executable.sh", 0o644);
	await fs.rm("regular-to-link");
	await fs.symlink("target-b", "regular-to-link");
	await fs.rm("symlink-to-regular");
	await Bun.write("symlink-to-regular", "now regular\\n");
	await fs.rm("retarget-link");
	await fs.symlink("target-b", "retarget-link");
	await fs.symlink("target-a", "added-link");
	await fs.rm("delete-link");
`;

describe.skipIf(!hasOverlay)("runner", () => {
	describe("literal text edits", () => {
		test("matches LF text in a CRLF file while preserving the BOM and untouched mixed endings", async () => {
			const repo = await makeRepo({ "config.txt": "\uFEFFheader\r\none\r\ntwo\r\ntail\n" });
			const result = await run(repo, `edit({ path: "config.txt", oldText: "one\\ntwo", newText: "three\\nfour" });`);
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(repo, "config.txt")).bytes()).toEqual(
				new TextEncoder().encode("\uFEFFheader\r\nthree\nfour\r\ntail\n"),
			);
		});

		test("composes edits with literal replacement text and preserves surrounding bytes", async () => {
			const repo = await makeRepo({ "config.txt": "😀\r\ntimeoutMs: 1000\r\nkeep\r\n" });
			const result = await run(
				repo,
				`
				edit({ path: "config.txt", oldText: "timeoutMs: 1000", newText: "timeoutMs: 3000" });
				await edit({ path: "config.txt", oldText: "timeoutMs: 3000", newText: "$& $1 $$" });
				edit({ path: "config.txt", oldText: "keep", newText: "" });
			`,
			);
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(repo, "config.txt")).text()).toBe("😀\r\n$& $1 $$\r\n\r\n");
		});

		for (const [source, oldText, message] of [
			["original", "absent", "oldText not found"],
			["repeat repeat", "repeat", "matches more than once"],
			["aaa", "aa", "matches more than once"],
			["a\r\nb a\nb", "a\nb", "matches more than once"],
			["original", "", "oldText must not be empty"],
		]) {
			test(`rejects ${JSON.stringify(oldText)} in ${JSON.stringify(source)} without writing`, async () => {
				const repo = await makeRepo({ "config.txt": source });
				const result = await run(
					repo,
					`
					let rejected = false;
					try { edit(${JSON.stringify({ path: "config.txt", oldText, newText: "changed" })}); }
					catch (error) {
						if (!String(error).includes(${JSON.stringify(message)})) throw error;
						rejected = true;
					}
					if (!rejected) throw new Error("Expected rejection");
					if (await Bun.file("config.txt").text() !== ${JSON.stringify(source)}) throw new Error("File changed");
				`,
				);
				expect(result.exitCode).toBe(0);
				expect(result.applied).toEqual([]);
			});
		}

		test("a helper's error shows the program line that called it", async () => {
			const repo = await makeRepo({ "config.txt": "original\n" });
			const result = await run(
				repo,
				`edit({ path: "config.txt", oldText: "original", newText: "first" });
edit({ path: "config.txt", oldText: "absent", newText: "second" });`,
			);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('2 | edit({ path: "config.txt", oldText: "absent"');
			expect(result.output).toContain("at program.ts:2:1");
			expect(result.output).not.toContain("prelude.ts");
		});

		test("an error in a rewrite callback still shows the callback's own line", async () => {
			const repo = await makeRepo({ "a.ts": "foo(1);\n" });
			const result = await run(
				repo,
				`sg.rewrite("foo($A)", (m) => {
  return m.text();
});`,
			);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("2 |   return m.text();");
			expect(result.output).toContain("m.text is not a function");
		});
	});

	describe("TypeScript refactors", () => {
		test("renames one resolved symbol across files without changing unrelated names or strings", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
				"src/parse.ts": "export function parseUser(value: string) { return value; }\n",
				"src/use.ts":
					'import { parseUser } from "./parse";\nexport const api = { parseUser };\nexport const result = parseUser("Ada");\n',
				"src/other.ts":
					'function parseUser() { return "unrelated"; }\nexport const text = "parseUser";\nexport { parseUser };\n',
			});

			const result = await run(
				repo,
				`const file = sg.file("src/parse.ts");
await refactor.rename({ file, symbol: "parseUser", to: "decodeUser" });`,
			);

			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(repo, "src/parse.ts")).text()).toBe(
				"export function decodeUser(value: string) { return value; }\n",
			);
			expect(await Bun.file(path.join(repo, "src/use.ts")).text()).toBe(
				'import { decodeUser } from "./parse";\nexport const api = { parseUser: decodeUser };\nexport const result = decodeUser("Ada");\n',
			);
			expect(await Bun.file(path.join(repo, "src/other.ts")).text()).toContain("function parseUser()");
			expect(await Bun.file(path.join(repo, "src/other.ts")).text()).toContain('"parseUser"');
		});

		test("renaming a property keeps the value in an object literal shorthand", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
				"src/user.ts":
					"export interface User { name: string }\nexport function make(name: string): User { return { name }; }\nexport function read(u: User) { const { name } = u; return name.length; }\n",
			});

			const result = await run(
				repo,
				`await refactor.rename({ file: "src/user.ts", symbol: "User.name", to: "fullName" });`,
			);

			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(repo, "src/user.ts")).text()).toBe(
				"export interface User { fullName: string }\nexport function make(name: string): User { return { fullName: name }; }\nexport function read(u: User) { const { fullName } = u; return fullName.length; }\n",
			);
		});

		test("renaming a variable keeps the key in a destructuring assignment, and a parameter property is a property", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
				"src/a.ts":
					'export function readName(json: string) { let name = "anonymous"; ({ name } = JSON.parse(json)); return name; }\nexport class User { constructor(public name: string) {} }\nexport function make(name: string): User { return { name }; }\n',
			});

			const result = await run(
				repo,
				`await refactor.rename({ file: "src/a.ts", symbol: "readName.name", to: "displayName" });
await refactor.rename({ file: "src/a.ts", symbol: "User.name", to: "fullName" });`,
				{ timeoutMs: 15_000 },
			);

			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(
				'export function readName(json: string) { let displayName = "anonymous"; ({ name: displayName } = JSON.parse(json)); return displayName; }\nexport class User { constructor(public fullName: string) {} }\nexport function make(name: string): User { return { fullName: name }; }\n',
			);
		});

		test("a rename to a name already declared where the symbol is used is refused", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
				"src/a.ts":
					"export const limit = 10;\nexport function clamp(n: number) { const max = 5; return Math.min(n, limit, max * 100); }\nexport function other() { const total = 1; return total + limit; }\n",
			});

			const refused = await run(repo, `await refactor.rename({ file: "src/a.ts", symbol: "limit", to: "max" });`, {
				timeoutMs: 15_000,
			});
			expect(refused.exitCode).toBe(1);
			expect(refused.output).toContain('max is already declared where "limit" is used, at src/a.ts:2');
			const allowed = await run(
				repo,
				`await refactor.rename({ file: "src/a.ts", symbol: "other.total", to: "max" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(allowed.exitCode).toBe(0);
		});

		test("the rename scope check sees loop variables and defaults, and not a type signature's parameters", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
				"src/a.ts": [
					"export const limit = 10;",
					"export const scale = 2;",
					"export function clampAll(values: number[]) { const out: number[] = []; for (const v of values) out.push(Math.min(v, limit)); return out; }",
					"export function sized(o: { size?: number }) { const { size = 1 } = o; return size * scale; }",
					'export const currentUser = "ada";',
					"export interface Repo { save(user: string): void }",
					"export type OnUser = (user: string) => void;",
					"",
				].join("\n"),
			});
			for (const [symbol, to] of [
				["limit", "v"],
				["scale", "size"],
			]) {
				const result = await run(
					repo,
					`await refactor.rename({ file: "src/a.ts", symbol: "${symbol}", to: "${to}" });`,
					{
						timeoutMs: 15_000,
					},
				);
				expect(result.exitCode).toBe(1);
				expect(result.output).toContain(`${to} is already declared`);
			}
			const allowed = await run(
				repo,
				`await refactor.rename({ file: "src/a.ts", symbol: "currentUser", to: "user" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(allowed.exitCode).toBe(0);
		});

		test("the rename scope check covers types and destructured properties, and skips what can't be captured", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({
					compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler" },
				}),
				"src/user.ts":
					"export interface User { name: string }\nexport interface Options { verbose?: boolean }\nexport interface Config { port?: number }\nexport function parse(s: string) { return s; }\n",
				"src/use.ts":
					'import type { User, Options } from "./user";\nimport * as A from "./user";\nimport { parse as p } from "./user";\nconst fullName = "outer";\nexport function greet(u: User) { const { name } = u; return name + fullName; }\nexport const o: Options = {};\nexport function decode(s: string) { return A.parse(s) + p(s); }\n',
			});
			for (const [symbol, to] of [
				["User.name", "fullName"],
				["Options", "Config"],
			]) {
				const result = await run(
					repo,
					`await refactor.rename({ file: "src/user.ts", symbol: "${symbol}", to: "${to}" });`,
					{
						timeoutMs: 15_000,
					},
				);
				expect(result.exitCode).toBe(1);
				expect(result.output).toContain(`${to} is already declared`);
			}
			const allowed = await run(
				repo,
				`await refactor.rename({ file: "src/user.ts", symbol: "parse", to: "decode" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(allowed.exitCode).toBe(0);
			expect(await Bun.file(path.join(repo, "src/use.ts")).text()).toContain("A.decode(s) + p(s)");
		});

		test("moving code that imports a package that isn't installed doesn't try to install it", async () => {
			const repo = await makeRepo({
				"tsconfig.json": "{}",
				"src/a.ts":
					'import { widget } from "not-installed-package-for-shorthand-tests";\nexport function make() { return widget(); }\nexport const keep = 1;\n',
			});
			const result = await run(repo, `await refactor.move({ file: "src/a.ts", symbol: "make", to: "src/b.ts" });`, {
				timeoutMs: 15_000,
			});
			expect(result.exitCode, result.output).toBe(0);
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toStartWith(
				'import { widget } from "not-installed-package-for-shorthand-tests";',
			);
		});

		test("renaming a destructured variable leaves the property it reads alone, and a member can't take another's name", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({
					compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler" },
				}),
				"src/lib.ts":
					'export interface Result { auth: () => string; fullName: string }\nexport function NextAuth(): Result { return { auth: () => "s", fullName: "f" }; }\n',
				"src/a.ts":
					'import { NextAuth } from "./lib";\nexport const { auth } = NextAuth();\nexport const s = auth();\n',
				"src/b.ts": 'import { NextAuth } from "./lib";\nexport const t = NextAuth().auth();\n',
			});
			const renamed = await run(
				repo,
				`await refactor.rename({ file: "src/a.ts", symbol: "auth", to: "getSession" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(renamed.exitCode, renamed.output).toBe(0);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(
				'import { NextAuth } from "./lib";\nexport const { auth: getSession } = NextAuth();\nexport const s = getSession();\n',
			);
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toContain("NextAuth().auth()");
			const collision = await run(
				repo,
				`await refactor.rename({ file: "src/lib.ts", symbol: "Result.auth", to: "fullName" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(collision.exitCode).toBe(1);
			expect(collision.output).toContain("would become a second member named fullName");
		});

		test("renames on the first line of a file with a byte order mark land where TypeScript means", async () => {
			const bom = String.fromCharCode(0xfeff);
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({
					compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler" },
				}),
				"src/a.ts": `${bom}export function parseUser(s: string) { return s; }\n`,
				"src/b.ts": `${bom}import { parseUser } from "./a";\nexport const x = parseUser("a");\n`,
			});
			const result = await run(
				repo,
				`await refactor.rename({ file: "src/a.ts", symbol: "parseUser", to: "decodeUser" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(result.exitCode, result.output).toBe(0);
			// Read as bytes: Bun's text() drops a byte order mark.
			const read = async (file: string) => Buffer.from(await Bun.file(path.join(repo, file)).bytes()).toString("utf8");
			expect(await read("src/a.ts")).toBe(`${bom}export function decodeUser(s: string) { return s; }\n`);
			expect(await read("src/b.ts")).toBe(
				`${bom}import { decodeUser } from "./a";\nexport const x = decodeUser("a");\n`,
			);
		});

		test("an accessor pair renames as one property, and a barrel collision is refused", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({
					compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler" },
				}),
				"src/temp.ts":
					"export class Temp {\n  #c = 0;\n  get celsius() { return this.#c; }\n  set celsius(v: number) { this.#c = v; }\n}\n",
				"src/utils/date.ts": 'export function formatDate(d: number) { return "date:" + d; }\n',
				"src/utils/number.ts": 'export function format(n: number) { return "num:" + n; }\n',
				"src/utils/index.ts": 'export * from "./date";\nexport * from "./number";\n',
				"src/other.ts": 'import { formatDate } from "./utils";\nexport const s = formatDate(1);\n',
			});
			const accessor = await run(
				repo,
				`await refactor.rename({ file: "src/temp.ts", symbol: "Temp.celsius", to: "degrees" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(accessor.exitCode, accessor.output).toBe(0);
			expect(await Bun.file(path.join(repo, "src/temp.ts")).text()).toContain("get degrees() {");
			expect(await Bun.file(path.join(repo, "src/temp.ts")).text()).toContain("set degrees(v: number) {");
			const barrel = await run(
				repo,
				`await refactor.rename({ file: "src/utils/date.ts", symbol: "formatDate", to: "format" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(barrel.exitCode).toBe(1);
			expect(barrel.output).toContain("src/utils/index.ts re-exports src/utils/date.ts and already exports format");
		});

		test("references finds a private member", async () => {
			const repo = await makeRepo({
				"tsconfig.json": "{}",
				"src/a.ts": "export class Counter { #count = 0; inc() { return this.#count++; } }\n",
			});
			const result = await run(
				repo,
				`console.log((await refactor.references({ file: "src/a.ts", symbol: "Counter.#count", includeDeclaration: true })).length);`,
				{ timeoutMs: 15_000 },
			);
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("2");
		});

		test("renameFile refuses when TypeScript leaves an importer unchanged", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({
					compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler" },
				}),
				"src/lib/util.ts": "export interface Extra { y: number }\nexport const u = 1;\n",
				"src/a.ts": 'import { u } from "./lib/util";\nexport const v = u;\n',
				"src/aug.ts": 'import "./lib/util";\ndeclare module "./lib/util" { interface Extra { x: number } }\n',
			});
			const result = await run(
				repo,
				`await refactor.renameFile({ from: "src/lib/util.ts", to: "src/lib/util2.ts" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`TypeScript didn't update the import of "src/lib/util.ts" in "src/a.ts"`);
			expect(await Bun.file(path.join(repo, "src/lib/util.ts")).exists()).toBe(true);
		});

		test("rejects a missing or ambiguous declaration without writing", async () => {
			const source =
				"export function a() { const value = 1; return value; }\nexport function b() { const value = 2; return value; }\n";
			for (const [symbol, message] of [
				["missing", "found no declaration"],
				["value", '"value" is ambiguous in src/app.ts; use one of: a.value, b.value'],
			]) {
				const repo = await makeRepo({ "tsconfig.json": "{}", "src/app.ts": source });
				const result = await run(
					repo,
					`await refactor.rename({ file: "src/app.ts", symbol: ${JSON.stringify(symbol)}, to: "next" });`,
					{ timeoutMs: 15_000 },
				);
				expect(result.exitCode).toBe(1);
				expect(result.output).toContain(message);
				expect(await Bun.file(path.join(repo, "src/app.ts")).text()).toBe(source);
			}
		});

		test("a bare name means the top-level declaration, not locals or members named like it", async () => {
			const repo = await makeRepo({
				"tsconfig.json": "{}",
				"src/app.ts":
					"export function parseUser() { return 1; }\nexport const helpers = { parseUser };\nexport function outer() { const parseUser = 2; return parseUser; }\n",
			});
			const result = await run(
				repo,
				`await refactor.rename({ file: "src/app.ts", symbol: "parseUser", to: "decodeUser" });`,
				{
					timeoutMs: 15_000,
				},
			);
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(repo, "src/app.ts")).text()).toBe(
				"export function decodeUser() { return 1; }\nexport const helpers = { parseUser: decodeUser };\nexport function outer() { const parseUser = 2; return parseUser; }\n",
			);
		});

		test("moves a file and updates resolved module paths", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({ include: ["src"] }),
				"src/parse.ts": "export const parse = (value: string) => value;\n",
				"src/use.ts": 'import { parse } from "./parse";\nexport const value = parse("Ada");\n',
			});
			const result = await run(
				repo,
				`const from = sg.file("src/parse.ts");
const to = sg.file("src/lib/parse.ts");
await refactor.renameFile({ from, to });`,
			);

			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(repo, "src/parse.ts")).exists()).toBe(false);
			expect(await Bun.file(path.join(repo, "src/lib/parse.ts")).text()).toContain("export const parse");
			expect(await Bun.file(path.join(repo, "src/use.ts")).text()).toContain('from "./lib/parse"');
		});

		test("language server time does not count toward the program timeout", async () => {
			const repo = await makeRepo({
				"tsconfig.json": JSON.stringify({ include: ["src"] }),
				"src/parse.ts": "export function parseUser(value: string) { return value; }\n",
				"src/use.ts": 'import { parseUser } from "./parse";\nexport const user = parseUser("Ada");\n',
			});
			// Starting the language server alone takes longer than this timeout.
			const result = await run(
				repo,
				`await refactor.rename({ file: "src/parse.ts", symbol: "parseUser", to: "decodeUser" });`,
				{
					timeoutMs: 300,
				},
			);

			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.helperMs).toBeGreaterThan(0);
			expect(result.diagnostics?.counters["helper ms excluded from timeout"]).toBe(result.helperMs);
			expect(await Bun.file(path.join(repo, "src/use.ts")).text()).toContain("decodeUser");
		});

		test("a failed helper resumes the program timeout", async () => {
			const repo = await makeRepo({ "tsconfig.json": "{}", "src/app.ts": "export const value = 1;\n" });
			const result = await run(
				repo,
				`await refactor.rename({ file: "src/app.ts", symbol: "missing", to: "next" }).catch(() => {});
await Bun.sleep(30_000);`,
				{ timeoutMs: 1000 },
			);

			expect(result.timedOut).toBe(true);
			expect(result.helperMs).toBeGreaterThan(0);
			expect(result.durationMs).toBeLessThan(20_000);
		});
	});

	describe("transaction application", () => {
		test("applies a successful program's changes and reports them", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`sg.rewrite("oldApi($$$A)", "newApi($$$A)", "src");
			await Bun.write("src/new.ts", "export {};\\n");
			await Bun.file("src/b.ts").delete();`,
			);

			expect(result.exitCode).toBe(0);
			expect(result.changes.map((change) => `${change.kind} ${change.path}`)).toEqual([
				"modified src/a.ts",
				"deleted src/b.ts",
				"added src/new.ts",
			]);
			expect(result.applied).toEqual(["src/a.ts", "src/b.ts", "src/new.ts"]);
			expect(await gitStatus(repo)).toBe("M src/a.ts\n D src/b.ts\n?? src/new.ts");
		});

		test("a workspace cleanup failure preserves the applied result and reports a warning", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(repo, `await Bun.write("src/a.ts", "updated\\n");`, {
				testHooks: { workspaceCleanupFailure: true },
			});

			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.cleanupWarnings).toContainEqual(expect.stringContaining("isolated workspace"));
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("updated\n");
		});

		test("a workspace cleanup failure does not replace the program failure", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(repo, `throw new Error("program failed");`, {
				testHooks: { workspaceCleanupFailure: true },
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("program failed");
			expect(result.cleanupWarnings).toContainEqual(expect.stringContaining("isolated workspace"));
		});

		test("applies executable modes and every regular-file/symlink transition", async () => {
			const repo = await makeMetadataRepo();
			const result = await run(repo, METADATA_PROGRAM);

			expect((await lstat(path.join(repo, "make-executable.sh"))).mode & 0o777).toBe(0o755);
			expect((await lstat(path.join(repo, "remove-executable.sh"))).mode & 0o777).toBe(0o644);
			expect(await readlink(path.join(repo, "regular-to-link"))).toBe("target-b");
			expect((await lstat(path.join(repo, "symlink-to-regular"))).isFile()).toBe(true);
			expect(await Bun.file(path.join(repo, "symlink-to-regular")).text()).toBe("now regular\n");
			expect(await readlink(path.join(repo, "retarget-link"))).toBe("target-b");
			expect(await readlink(path.join(repo, "added-link"))).toBe("target-a");
			expect(await lstat(path.join(repo, "delete-link")).catch(() => null)).toBeNull();
			expect(result.changes.find((change) => change.path === "make-executable.sh")).toMatchObject({
				beforeType: "file",
				afterType: "file",
				beforeMode: 0o644,
				afterMode: 0o755,
			});
			expect(result.changes.find((change) => change.path === "regular-to-link")).toMatchObject({
				beforeType: "file",
				afterType: "symlink",
			});
			expect(result.changes.find((change) => change.path === "symlink-to-regular")).toMatchObject({
				beforeType: "symlink",
				afterType: "file",
			});
			expect(result.changes.find((change) => change.path === "retarget-link")?.patch).toContain("target-b");
		});

		test("rolls back executable modes and file/symlink transitions after an application failure", async () => {
			const repo = await makeMetadataRepo();
			const runner = startRunner(repo, METADATA_PROGRAM, withApplicationTestHooks({ failAfter: 7 }));
			const { stderr, exitCode } = await runnerOutcome(runner);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Injected application failure after 7 change");
			expect((await lstat(path.join(repo, "make-executable.sh"))).mode & 0o777).toBe(0o644);
			expect((await lstat(path.join(repo, "remove-executable.sh"))).mode & 0o777).toBe(0o755);
			expect((await lstat(path.join(repo, "regular-to-link"))).isFile()).toBe(true);
			expect(await Bun.file(path.join(repo, "regular-to-link")).text()).toBe("regular\n");
			expect(await readlink(path.join(repo, "symlink-to-regular"))).toBe("target-a");
			expect(await readlink(path.join(repo, "retarget-link"))).toBe("target-a");
			expect(await readlink(path.join(repo, "delete-link"))).toBe("target-a");
			expect(await lstat(path.join(repo, "added-link")).catch(() => null)).toBeNull();
		});

		test("rejects an unsupported directory replacement explicitly", async () => {
			const repo = await makeRepo({ victim: "keep\n" });
			const runner = startRunner(
				repo,
				`const fs = await import("node:fs/promises"); await fs.rm("victim"); await fs.mkdir("victim");`,
			);
			const { stderr, exitCode } = await runnerOutcome(runner);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Unsupported directory replacement");
			expect(await Bun.file(path.join(repo, "victim")).text()).toBe("keep\n");
		});
	});

	describe("workspace isolation and lifecycle", () => {
		test.skipIf(process.platform !== "linux")(
			"a failing Linux program cannot leave writes outside the repository",
			async () => {
				const repo = await makeRepo(FILES);
				const suffix = randomUUID();
				const homeVictim = path.join(homedir(), `.pi-shorthand-outside-${suffix}`);
				const hostTempVictim = path.join(tmpdir(), `pi-shorthand-outside-${suffix}`);
				const procVictim = `/proc/${process.pid}/root${homeVictim}`;
				try {
					const result = await run(
						repo,
						`let homeBlocked = false, hostTempBlocked = false, procBlocked = false;
				try { await Bun.write(${JSON.stringify(homeVictim)}, "host write"); } catch { homeBlocked = true; }
				try { await Bun.write(${JSON.stringify(hostTempVictim)}, "host temporary write"); } catch { hostTempBlocked = true; }
				try { await Bun.write(${JSON.stringify(procVictim)}, "proc root write"); } catch { procBlocked = true; }
				await Bun.write(process.env.TMPDIR! + "/private-write", "private temporary write");
				await Bun.write("src/a.ts", "repository write\\n");
				console.log({ homeBlocked, hostTempBlocked, procBlocked, tmpdir: process.env.TMPDIR });
				throw new Error("fail after writes");`,
					);

					expect(result.exitCode).not.toBe(0);
					expect(result.output).toContain("homeBlocked: true");
					expect(result.output).toContain("hostTempBlocked: true");
					expect(result.output).toContain("procBlocked: true");
					expect(result.output).toContain('tmpdir: "/dev/shm"');
					expect(await Bun.file(homeVictim).exists()).toBe(false);
					expect(await Bun.file(hostTempVictim).exists()).toBe(false);
					expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
				} finally {
					await rm(homeVictim, { force: true });
					await rm(hostTempVictim, { force: true });
				}
			},
		);

		test("applies files inside newly created nested directories", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`await Bun.write("new/deep/first.txt", "first"); await Bun.write("new/deep/second.txt", "second");`,
			);
			expect(result.conflicts).toEqual([]);
			expect(result.applied).toEqual(["new/deep/first.txt", "new/deep/second.txt"]);
			expect(await Bun.file(path.join(repo, "new/deep/first.txt")).text()).toBe("first");
		});

		test("external symlinks cannot redirect generated writes outside the workspace", async () => {
			const repo = await makeRepo(FILES);
			const victim = path.join(path.dirname(repo), "victim");
			await Bun.write(victim, "original");
			await symlink(victim, path.join(repo, "external"));
			const result = await run(
				repo,
				`
				const fs = await import("node:fs/promises");
				await fs.symlink(${JSON.stringify(victim)}, "new-link");
				for (const target of [${JSON.stringify(victim)}, "external", "new-link"]) {
					let blocked = false;
					try { await fs.writeFile(target, "modified"); } catch { blocked = true; }
					if (!blocked) throw new Error("external write allowed: " + target);
				}
				await Bun.write(process.env.TMPDIR! + "/scratch", "private");
			`,
			);
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(victim).text()).toBe("original");
		});

		test.each(["src", "src/deep"])(
			"preserves a nested working directory inside the execution root: %s",
			async (directory) => {
				const repo = await makeRepo({ ...FILES, [`${directory}/a.ts`]: "original\n" });
				const result = await run(repo, `await Bun.write("a.ts", "nested cwd\\n");`, {
					cwd: path.join(repo, directory),
				});

				expect(result.exitCode, result.output).toBe(0);
				expect(result.applied).toEqual(["a.ts"]);
				expect(await Bun.file(path.join(repo, directory, "a.ts")).text()).toBe("nested cwd\n");
			},
		);

		test.skipIf(process.platform !== "darwin")(
			"the macOS program cannot access the live checkout or runner state",
			async () => {
				const repo = await makeRepo(FILES);
				const liveFile = path.join(repo, "src/a.ts");
				const result = await run(
					repo,
					`let liveReadBlocked = false;
			try { await Bun.file(${JSON.stringify(liveFile)}).text(); } catch { liveReadBlocked = true; }
			if (!liveReadBlocked) throw new Error("live checkout was readable");
			const configIndex = Number(process.env.GIT_CONFIG_COUNT) - 1;
			const internal = require("node:path").dirname(process.env[\`GIT_CONFIG_VALUE_\${configIndex}\`]!);
			let internalWriteBlocked = false;
			try { await Bun.write(require("node:path").join(internal, "output"), "tampered"); } catch { internalWriteBlocked = true; }
			if (!internalWriteBlocked) throw new Error("runner state was writable");
			const recovery = require("node:path").join(require("node:os").homedir(), ".cache/pi-shorthand/macos-mounts/tampered");
			let recoveryWriteBlocked = false;
			try { await Bun.write(recovery, "tampered"); } catch { recoveryWriteBlocked = true; }
			if (!recoveryWriteBlocked) throw new Error("recovery state was writable");
			console.log(await Bun.file("src/a.ts").text());`,
				);

				expect(result.exitCode).toBe(0);
				expect(result.output).toContain(FILES["src/a.ts"]);
				expect(await Bun.file(liveFile).text()).toBe(FILES["src/a.ts"]);
			},
		);

		test.skipIf(process.platform !== "darwin")(
			"an ignored state.json directory cannot collide with macOS recovery metadata",
			async () => {
				const repo = await makeRepo({
					".gitignore": "state.json/\n",
					"tracked.txt": "before\n",
				});
				await mkdir(path.join(repo, "state.json"));
				await Bun.write(path.join(repo, "state.json", "kept.txt"), "user data\n");

				const result = await run(repo, `await Bun.write("tracked.txt", "after\\n");`);

				expect(result.exitCode).toBe(0);
				expect(result.applied).toEqual(["tracked.txt"]);
				expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("after\n");
				expect(await Bun.file(path.join(repo, "state.json", "kept.txt")).text()).toBe("user data\n");
				expect((await lstat(repo)).isDirectory()).toBe(true);
			},
		);

		test.skipIf(process.platform !== "darwin")(
			"macOS recovery rejects paths outside owned temporary roots",
			async () => {
				const repo = await makeRepo(FILES);
				const stateFile = macRecoveryFile(repo);
				const victim = path.join(path.dirname(repo), "recovery-victim");
				await mkdir(path.dirname(stateFile), { recursive: true });
				await Bun.write(victim, "keep me\n");
				await Bun.write(
					stateFile,
					JSON.stringify({ runnerPid: 999_999_999, tempDir: victim, mountContainer: victim, mount: victim }),
				);

				try {
					const runner = startRunner(repo, "");
					expect(await runner.exited).not.toBe(0);
					expect(await Bun.file(victim).text()).toBe("keep me\n");
				} finally {
					await rm(stateFile, { force: true });
				}
			},
		);

		test.skipIf(process.platform !== "darwin")("macOS recovery does not signal a reused unrelated PID", async () => {
			const repo = await makeRepo(FILES);
			const stateFile = macRecoveryFile(repo);
			const temporaryRoot = await realpath(tmpdir());
			const staleTemp = await mkdtemp(path.join(temporaryRoot, "pi-shorthand-stale-"));
			const staleMountContainer = await mkdtemp(path.join(temporaryRoot, "pi-shorthand-workspace-stale-"));
			const staleMount = path.join(staleMountContainer, "repo");
			await mkdir(staleMount);
			const unrelated = Bun.spawn(["sleep", "30"]);
			await mkdir(path.dirname(stateFile), { recursive: true });
			await Bun.write(
				stateFile,
				JSON.stringify({
					runnerPid: 999_999_999,
					serverPid: unrelated.pid,
					tempDir: staleTemp,
					mountContainer: staleMountContainer,
					mount: staleMount,
				}),
			);

			try {
				const runner = startRunner(repo, "");
				expect(await runner.exited).not.toBe(0);
				expect(unrelated.killed).toBe(false);
			} finally {
				unrelated.kill();
				await unrelated.exited;
				await rm(stateFile, { force: true });
				await rm(staleTemp, { recursive: true, force: true });
				await rm(staleMountContainer, { recursive: true, force: true });
			}
		});

		test("applies nothing when the program fails, and reports the error", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "broken");\nthrow new Error("expected 1 match, found 3");`,
			);

			expect(result.exitCode).toBe(1);
			expect(result.applied).toEqual([]);
			expect(result.changes.map((change) => change.path)).toEqual(["src/a.ts"]);
			expect(result.output).toContain("expected 1 match, found 3");
			expect(result.output).toContain("program.ts:2");
			expect(await gitStatus(repo)).toBe("");
		});

		test('rollback "file" keeps closed files on timeout and rolls back one still open', async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "// finished\\n");
			const writer = Bun.file("src/b.ts").writer();
			for (let i = 0; ; i++) { writer.write(\`line \${i}\\n\`); writer.flush(); await Bun.sleep(5); }`,
				{ rollback: "file", timeoutMs: 1000 },
			);

			expect(result.timedOut).toBe(true);
			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.rolledBack).toEqual(["src/b.ts"]);
			expect(await gitStatus(repo)).toBe("M src/a.ts");
		});

		test('rollback "file" finds a timed-out detached child writer', async () => {
			const repo = await makeRepo(FILES);
			const childProgram = `
			const writer = Bun.file("src/b.ts").writer();
			for (let i = 0; ; i++) {
				writer.write(\`partial \${i}\\n\`);
				writer.flush();
				await Bun.sleep(5);
			}`;
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "// closed\\n");
			Bun.spawn([process.execPath, "-e", ${JSON.stringify(childProgram)}], {
				cwd: process.cwd(), detached: true, env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore"
			}).unref();
			await Bun.sleep(30_000);`,
				{ rollback: "file", timeoutMs: 1000 },
			);

			expect(result.timedOut).toBe(true);
			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.rolledBack).toEqual(["src/b.ts"]);
			expect(await gitStatus(repo)).toBe("M src/a.ts");
		});

		test('rollback "file" retains nothing when open-writer inspection fails', async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "// closed\\n");
			const writer = Bun.file("src/b.ts").writer();
			writer.write("// open\\n");
			writer.flush();
			await Bun.sleep(30_000);`,
				{ rollback: "file", timeoutMs: 1000, testHooks: { writerInspectionFailure: true } },
			);

			expect(result.timedOut).toBe(true);
			expect(result.writerInspectionFailed).toBe(true);
			expect(result.applied).toEqual([]);
			expect(result.rolledBack).toEqual(["src/a.ts", "src/b.ts"]);
			expect(await gitStatus(repo)).toBe("");
		});

		test('rollback "file" keeps successful files after an exception with an unclosed writer', async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "// finished\\n");
			const writer = Bun.file("src/b.ts").writer();
			writer.write("// partial\\n");
			writer.flush();
			throw new Error("failed with writer open");`,
				{ rollback: "file" },
			);

			expect(result.exitCode).toBe(1);
			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.rolledBack).toEqual(["src/b.ts"]);
			expect(await gitStatus(repo)).toBe("M src/a.ts");
		});

		test('rollback "file" rolls back earlier writes to the failed helper target only', async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`
				await Bun.write("src/a.ts", "finished");
				await Bun.write("src/b.ts", "intermediate");
				edit({ path: "src/b.ts", oldText: "absent", newText: "replacement" });
			`,
				{ rollback: "file" },
			);
			expect(result.exitCode, result.output).toBe(1);
			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.rolledBack).toEqual(["src/b.ts"]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("finished");
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe(FILES["src/b.ts"]);
		});

		test.each(["throw new Error('verification failed')", "throw null", "await $`false`"])(
			'rollback "file" keeps edits after an unattributed failure: %s',
			async (failure) => {
				const repo = await makeRepo(FILES);
				const result = await run(repo, `await Bun.write("src/a.ts", "finished"); ${failure};`, { rollback: "file" });
				expect(result.exitCode).not.toBe(0);
				expect(result.timedOut).toBe(false);
				expect(result.applied, JSON.stringify(result)).toEqual(["src/a.ts"]);
				expect(result.rolledBack).toEqual([]);
				expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("finished");
			},
		);

		test('rollback "file" identifies a native filesystem error target', async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`
				await Bun.write("src/a.ts", "finished");
				await Bun.write("src/b.ts", "intermediate");
				require("node:fs").renameSync("src/b.ts", "missing/b.ts");
			`,
				{ rollback: "file" },
			);
			expect(result.exitCode).toBe(1);
			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.rolledBack).toEqual(["src/b.ts"]);
		});

		test.each(["throw new Error('failed')", "process.exit(7)"])(
			'rollback "file" inspects native open writers before exit: %s',
			async (failure) => {
				const repo = await makeRepo(FILES);
				const result = await run(
					repo,
					`
					await Bun.write("src/a.ts", "finished");
					const fs = await import("node:fs/promises");
					const writer = await fs.open("src/b.ts", "w");
					await writer.write("partial");
					${failure};
				`,
					{ rollback: "file" },
				);
				expect(result.exitCode).toBe(failure.includes("exit") ? 7 : 1);
				expect(result.applied).toEqual(["src/a.ts"]);
				expect(result.rolledBack).toEqual(["src/b.ts"]);
			},
		);

		test.each(["throw new Error('callback failed')", "while (true) {}"])(
			'rollback "file" tracks a rewrite callback after its writes have closed: %s',
			async (failure) => {
				const repo = await makeRepo({ "a.ts": "const a = 1;", "b.ts": "const b = 1;" });
				const result = await run(
					repo,
					`
					sg.rewrite("const $NAME = 1", (match) => {
						if (match.file === "b.ts") {
							require("node:fs").writeFileSync("b.ts", "partial");
							${failure};
						}
						return "const a = 2;";
					});
				`,
					{ rollback: "file", timeoutMs: 1000 },
				);
				expect(result.timedOut).toBe(failure.includes("while"));
				expect(result.applied).toEqual(["a.ts"]);
				expect(result.rolledBack).toEqual(["b.ts"]);
				expect(await Bun.file(path.join(repo, "b.ts")).text()).toBe("const b = 1;");
			},
		);

		test('rollback "file" remembers a caught file error in a nested cwd', async () => {
			const repo = await makeRepo({ ...FILES, "src/line\nbreak.ts": "original" });
			const result = await run(
				repo,
				`
				await Bun.write("line\\nbreak.ts", "intermediate");
				try { edit({ path: "line\\nbreak.ts", oldText: "absent", newText: "replacement" }); } catch {}
				await Bun.write("a.ts", "finished");
			`,
				{ rollback: "file", cwd: path.join(repo, "src") },
			);
			expect(result.exitCode, result.output).toBe(0);
			expect(result.applied).toEqual(["a.ts"]);
			expect(result.rolledBack).toEqual(["line\nbreak.ts"]);
			expect(await Bun.file(path.join(repo, "src/line\nbreak.ts")).text()).toBe("original");
		});

		test('rollback "file" keeps subprocess imports independent of its tracking descriptor', async () => {
			const repo = await makeRepo(FILES);
			const prelude = path.join(import.meta.dir, "../src/program/prelude.ts");
			const result = await run(
				repo,
				`
				const child = Bun.spawn([process.execPath, "--preload", ${JSON.stringify(prelude)}, "-e", 'await Bun.write("src/a.ts", "child edit")'], { stdout: "inherit", stderr: "inherit" });
				if (await child.exited !== 0) throw new Error("child failed");
				throw new Error("unrelated failure");
			`,
				{ rollback: "file" },
			);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("unrelated failure");
			expect(result.applied).toEqual(["src/a.ts"]);
		});

		test('rollback "file" rolls back both files in a failed move but retains unrelated edits', async () => {
			const repo = await makeRepo({ "a.ts": "const a = 1;", "b.ts": "const b = 1;", "c.ts": "const c = 1;" });
			const result = await run(
				repo,
				`
				await Bun.write("a.ts", "const a = 2;");
				await Bun.write("b.ts", "const b = 2;");
				await Bun.write("c.ts", "const c = 2;");
				sg.move(sg.one("const a = 2", "a.ts"), { endOf: sg.file("b.ts") }, () => { throw new Error("move failed"); });
			`,
				{ rollback: "file" },
			);
			expect(result.exitCode).toBe(1);
			expect(result.applied).toEqual(["c.ts"]);
			expect(result.rolledBack).toEqual(["a.ts", "b.ts"]);
		});

		test('rollback "file" retains nothing when inspection fails during exception exit', async () => {
			const repo = await makeRepo(FILES);
			const result = await run(repo, `await Bun.write("src/a.ts", "finished"); throw new Error("failed");`, {
				rollback: "file",
				testHooks: { writerInspectionFailure: true },
			});
			expect(result.exitCode).toBe(1);
			expect(result.writerInspectionFailed).toBe(true);
			expect(result.applied).toEqual([]);
			expect(result.rolledBack).toEqual(["src/a.ts"]);
		});

		test('rollback "file" attributes failed edits through an internal symlink to their target', async () => {
			const repo = await makeRepo(FILES);
			await symlink("src/b.ts", path.join(repo, "alias.ts"));
			const result = await run(
				repo,
				`
				await Bun.write("src/a.ts", "finished");
				await Bun.write("src/b.ts", "intermediate");
				edit({ path: "alias.ts", oldText: "absent", newText: "replacement" });
			`,
				{ rollback: "file" },
			);
			expect(result.exitCode).toBe(1);
			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.rolledBack).toEqual(["src/b.ts"]);
		});

		test("reports the commands still running when it times out, and kills them", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(repo, "await $`sleep 31.5`;", { timeoutMs: 1000 });

			expect(result.timedOut).toBe(true);
			expect(result.stillRunning.some((command) => command.includes("sleep 31.5"))).toBe(true);
			expect((await $`pgrep -f "sleep 31.5"`.nothrow().text()).trim()).toBe("");
		});

		test("kills a process the program leaves running, without waiting for it", async () => {
			const repo = await makeRepo(FILES);
			const startedAt = performance.now();
			const result = await run(
				repo,
				`Bun.spawn(["sleep", "32.5"], { stdout: "inherit", stderr: "inherit" }).unref();\nconsole.log("left it running");`,
			);

			expect(result.exitCode).toBe(0);
			expect(performance.now() - startedAt).toBeLessThan(10_000);
			expect((await $`pgrep -f "sleep 32.5"`.nothrow().text()).trim()).toBe("");
		});

		test("a detached session cannot outlive completion, timeout, or cancellation", async () => {
			for (const outcome of ["completion", "timeout", "cancellation"] as const) {
				const repo = await makeRepo(FILES);
				const token = `pi-shorthand-detached-${randomUUID()}`;
				const program = `Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)", ${JSON.stringify(token)}], {
				detached: true, env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore"
			}).unref();
			${outcome === "completion" ? "" : "await Bun.sleep(30_000);"}`;
				try {
					if (outcome === "cancellation") {
						const started = path.join(path.dirname(repo), "detached-program-started");
						const runner = startRunner(repo, program, {
							timeoutMs: 60_000,
							testHooks: { programStartMarker: started },
						});
						await waitForFile(started);
						expect(await Bun.file(started).exists()).toBe(true);
						await Bun.sleep(100);
						runner.kill("SIGTERM");
						await runnerOutcome(runner);
					} else {
						const result = await run(repo, program, { timeoutMs: outcome === "timeout" ? 300 : 5000 });
						expect(result.timedOut).toBe(outcome === "timeout");
					}
					await Bun.sleep(100);
					expect((await $`pgrep -f ${token}`.nothrow().text()).trim()).toBe("");
				} finally {
					await $`pkill -9 -f ${token}`.nothrow().quiet();
				}
			}
		});

		test.skipIf(process.platform !== "darwin")(
			"macOS process cleanup does not terminate another active transaction",
			async () => {
				const firstRepo = await makeRepo(FILES);
				const secondRepo = await makeRepo(FILES);
				const firstToken = `pi-shorthand-isolated-first-${randomUUID()}`;
				const secondToken = `pi-shorthand-isolated-second-${randomUUID()}`;
				const firstProgram = `
				Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)", ${JSON.stringify(firstToken)}], {
					detached: true, env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore"
				}).unref();
				await Bun.sleep(30_000);`;
				const secondProgram = firstProgram.replaceAll(firstToken, secondToken);
				const firstStarted = path.join(path.dirname(firstRepo), "first-isolated-run-started");
				const secondStarted = path.join(path.dirname(secondRepo), "second-isolated-run-started");
				const first = startRunner(firstRepo, firstProgram, {
					timeoutMs: 60_000,
					testHooks: { programStartMarker: firstStarted },
				});
				const second = startRunner(secondRepo, secondProgram, {
					timeoutMs: 60_000,
					testHooks: { programStartMarker: secondStarted },
				});
				try {
					await waitUntil(
						"both isolated runs to start",
						async () => (await Bun.file(firstStarted).exists()) && (await Bun.file(secondStarted).exists()),
						4_000,
					);
					await waitUntil("both detached subprocesses to start", async () => {
						const [firstPids, secondPids] = await Promise.all([
							$`pgrep -f ${firstToken}`.nothrow().text(),
							$`pgrep -f ${secondToken}`.nothrow().text(),
						]);
						return Boolean(firstPids.trim() && secondPids.trim());
					});
					expect((await $`pgrep -f ${firstToken}`.nothrow().text()).trim()).not.toBe("");
					expect((await $`pgrep -f ${secondToken}`.nothrow().text()).trim()).not.toBe("");

					first.kill("SIGTERM");
					await runnerOutcome(first);
					expect((await $`pgrep -f ${firstToken}`.nothrow().text()).trim()).toBe("");
					expect((await $`pgrep -f ${secondToken}`.nothrow().text()).trim()).not.toBe("");

					second.kill("SIGTERM");
					await runnerOutcome(second);
					expect((await $`pgrep -f ${secondToken}`.nothrow().text()).trim()).toBe("");
				} finally {
					first.kill("SIGKILL");
					second.kill("SIGKILL");
					await $`pkill -9 -f ${firstToken}`.nothrow().quiet();
					await $`pkill -9 -f ${secondToken}`.nothrow().quiet();
				}
			},
		);

		test("an abort applies nothing and puts the repository back", async () => {
			const repo = await makeRepo(FILES);
			const runner = startRunner(repo, `await Bun.write("src/a.ts", "half way");\nawait Bun.sleep(30_000);`, {
				timeoutMs: 60_000,
			});
			await Bun.sleep(1500);
			runner.kill("SIGTERM");
			const { stdout } = await runnerOutcome(runner);
			const result: RunResult = JSON.parse(stdout);

			expect(result.applied).toEqual([]);
			expect(await gitStatus(repo)).toBe("");
		});

		test("changes git makes to .git aren't applied", async () => {
			const repo = await makeRepo(FILES);
			const head = (await $`git rev-parse HEAD`.cwd(repo).text()).trim();
			await run(repo, "await $`git commit --allow-empty -qm sneaky`.nothrow();");

			expect((await $`git rev-parse HEAD`.cwd(repo).text()).trim()).toBe(head);
		});

		test("a linked worktree cannot mutate its external Git metadata", async () => {
			for (const shouldFail of [false, true]) {
				const main = await makeRepo(FILES);
				const linkedRoot = await realpath(await mkdtemp(path.join(tmpdir(), "pi-shorthand-linked-")));
				const linked = path.join(linkedRoot, "repo");
				await $`git worktree add -q -b ${`issue-1-${randomUUID()}`} ${linked}`.cwd(main);
				repos.push(linked);

				const gitDir = (await $`git rev-parse --absolute-git-dir`.cwd(linked).text()).trim();
				const indexBefore = await Bun.file(path.join(gitDir, "index")).bytes();
				const headBefore = (await $`git rev-parse HEAD`.cwd(linked).text()).trim();
				const probeRef = `refs/heads/shorthand-probe-${randomUUID()}`;
				const result = await run(
					linked,
					`await Bun.write("src/a.ts", "program edit\\n");
				const add = await $\`git add src/a.ts\`.nothrow().quiet();
				const ref = await $\`git update-ref ${probeRef} HEAD\`.nothrow().quiet();
				console.log({ add: add.exitCode, ref: ref.exitCode });
				${shouldFail ? 'throw new Error("fail after Git writes");' : ""}`,
				);

				expect(result.output).not.toContain("add: 0");
				expect(result.output).not.toContain("ref: 0");
				expect(await Bun.file(path.join(gitDir, "index")).bytes()).toEqual(indexBefore);
				expect((await $`git rev-parse HEAD`.cwd(linked).text()).trim()).toBe(headBefore);
				expect((await $`git show-ref --verify --quiet ${probeRef}`.cwd(linked).nothrow()).exitCode).not.toBe(0);
				expect(await Bun.file(path.join(linked, "src/a.ts")).text()).toBe(
					shouldFail ? FILES["src/a.ts"] : "program edit\n",
				);
			}
		});
	});

	describe("transaction commit and rollback", () => {
		test("recreating an opaque directory retains only recreated descendants", async () => {
			const repo = await makeRepo({
				"src/keep.txt": "before\n",
				"src/gone.txt": "gone\n",
				"src/nested/gone.txt": "nested\n",
				"untouched/keep.txt": "untouched\n",
			});
			const result = await run(
				repo,
				`
				const fs = await import("node:fs/promises");
				await fs.rm("src", { recursive: true });
				await fs.mkdir("src/nested", { recursive: true });
				await Bun.write("src/keep.txt", "after\\n");
			`,
			);
			expect(result.applied).toEqual(["src/gone.txt", "src/keep.txt", "src/nested/gone.txt"]);
			expect(await Bun.file(path.join(repo, "src/keep.txt")).text()).toBe("after\n");
			expect(await Bun.file(path.join(repo, "src/nested/gone.txt")).exists()).toBe(false);
			expect(await Bun.file(path.join(repo, "untouched/keep.txt")).text()).toBe("untouched\n");
		});

		test("applies deleting a whole directory", async () => {
			const repo = await makeRepo({ ...FILES, "src/lib/x.ts": "export {};\n", "src/lib/y.ts": "export {};\n" });
			const result = await run(repo, "await $`rm -rf src/lib`;");

			expect(result.applied).toEqual(["src/lib/x.ts", "src/lib/y.ts"]);
			expect(await gitStatus(repo)).toBe("D src/lib/x.ts\n D src/lib/y.ts");
		});

		test("an application failure restores every earlier filesystem operation", async () => {
			const repo = await makeRepo(FILES);
			await chmod(path.join(repo, "src/a.ts"), 0o751);
			await symlink("a.ts", path.join(repo, "src/link.ts"));
			await $`git add -A && git -c user.name=test -c user.email=test@test commit -qm metadata`.cwd(repo);

			const runner = startRunner(
				repo,
				`await Bun.write("src/a.ts", "program a\\n");
			await Bun.file("src/b.ts").delete();
			await Bun.write("src/new.ts", "new\\n");`,
				withApplicationTestHooks({ failAfter: 3 }),
			);
			const { stdout, stderr, exitCode } = await runnerOutcome(runner);

			expect(exitCode, stdout).not.toBe(0);
			expect(stderr).toContain("Injected application failure after 3 change");
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
			expect((await lstat(path.join(repo, "src/a.ts"))).mode & 0o777).toBe(0o751);
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe(FILES["src/b.ts"]);
			expect(await Bun.file(path.join(repo, "src/new.ts")).exists()).toBe(false);
			expect(await readlink(path.join(repo, "src/link.ts"))).toBe("a.ts");
			expect(await gitStatus(repo)).toBe("");
		});

		test("a failure between backup and install restores the original", async () => {
			const repo = await makeRepo(FILES);
			const runner = startRunner(
				repo,
				`await Bun.write("src/a.ts", "program a\\n");`,
				withApplicationTestHooks({ failAfterBackup: 1 }),
			);
			const { stderr, exitCode } = await runnerOutcome(runner);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Injected application failure after backing up change 1");
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
			expect(await gitStatus(repo)).toBe("");
		});

		test("backup cleanup failure reports applied changes with a warning", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`await Bun.write("src/a.ts", "program a\\n");`,
				withApplicationTestHooks({ cleanupFailure: true }),
			);

			expect(result.applied).toEqual(["src/a.ts"]);
			expect(result.warnings).toContainEqual(expect.stringContaining("backup cleanup failed"));
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program a\n");
			for await (const backup of new Bun.Glob(".pi-shorthand-backup-*").scan({ cwd: path.join(repo, "src") })) {
				await rm(path.join(repo, "src", backup), { recursive: true, force: true });
			}
		});

		test("cancellation before the first commit operation applies nothing", async () => {
			const repo = await makeRepo(FILES);
			const preparedMarker = path.join(path.dirname(repo), "apply-prepared");
			const runner = startRunner(
				repo,
				`await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
				withApplicationTestHooks({ beforeCommitDelayMs: 500, beforeCommitMarker: preparedMarker }),
			);
			await waitForFile(preparedMarker);
			expect(await Bun.file(preparedMarker).exists()).toBe(true);
			runner.kill("SIGTERM");
			const { stdout, exitCode } = await runnerOutcome(runner);
			const result: RunResult = JSON.parse(stdout);

			expect(exitCode).toBe(0);
			expect(result.applied).toEqual([]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe(FILES["src/b.ts"]);
		});

		test("pre-commit cancellation reports retained cleanup artifacts", async () => {
			const repo = await makeRepo(FILES);
			const preparedMarker = path.join(path.dirname(repo), "apply-prepared-with-cleanup-warning");
			const abort = new AbortController();
			const resultPromise = runWithBun(
				{
					cwd: repo,
					program: `await Bun.write("src/a.ts", "program a\\n");`,
					timeoutMs: 5000,
					rollback: "all",
					testHooks: {
						apply: {
							beforeCommitDelayMs: 500,
							beforeCommitMarker: preparedMarker,
							cleanupFailure: true,
						},
					},
				},
				abort.signal,
			);
			await waitForFile(preparedMarker);
			expect(await Bun.file(preparedMarker).exists()).toBe(true);
			abort.abort();
			const result = await resultPromise;

			expect(result.applied).toEqual([]);
			expect(result.cleanupWarnings).toContainEqual(expect.stringContaining("backup cleanup failed"));
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
			for (const entry of await readdir(path.join(repo, "src"))) {
				if (entry.startsWith(".pi-shorthand-backup-")) {
					await rm(path.join(repo, "src", entry), { recursive: true, force: true });
				}
			}
		});

		test("cancellation waits for a commit that has already started", async () => {
			const repo = await makeRepo(FILES);
			const abort = new AbortController();
			const resultPromise = runWithBun(
				{
					cwd: repo,
					program: `await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
					timeoutMs: 5000,
					rollback: "all",
					testHooks: { apply: { delayMs: 500 } },
				},
				abort.signal,
			);
			await waitUntil(
				"src/a.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/a.ts"))) === "program a\n",
			);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program a\n");
			abort.abort();
			const result = await resultPromise;

			expect(result.applied).toEqual(["src/a.ts", "src/b.ts"]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program a\n");
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("program b\n");
		});

		test("a late conflict rolls back files already committed", async () => {
			const repo = await makeRepo(FILES);
			const runner = startRunner(
				repo,
				`await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
				withApplicationTestHooks({ delayMs: 500 }),
			);
			await waitUntil(
				"src/a.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/a.ts"))) === "program a\n",
			);
			await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
			const { stdout, exitCode } = await runnerOutcome(runner);
			const result: RunResult = JSON.parse(stdout);

			expect(exitCode).toBe(0);
			expect(result.conflicts).toEqual(["src/b.ts"]);
			expect(result.applied).toEqual([]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external b\n");
		});

		test("rollback continues restoring safe files after one destination changed", async () => {
			const repo = await makeRepo(FILES);
			const runner = startRunner(
				repo,
				`await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/api.ts", "program api\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
				withApplicationTestHooks({ delayMs: 500, delayAfter: 2 }),
			);
			await waitUntil(
				"src/api.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/api.ts"))) === "program api\n",
			);
			await Bun.write(path.join(repo, "src/api.ts"), "external api\n");
			await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
			const { stderr, exitCode } = await runnerOutcome(runner);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Rollback did not complete");
			expect(stderr).toContain("src/api.ts");
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
			expect(await Bun.file(path.join(repo, "src/api.ts")).text()).toBe("external api\n");
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external b\n");
			for await (const backup of new Bun.Glob(".pi-shorthand-backup-*").scan({ cwd: path.join(repo, "src") })) {
				await rm(path.join(repo, "src", backup), { recursive: true, force: true });
			}
		});

		test("cancellation preserves a concrete incomplete-rollback failure", async () => {
			const repo = await makeRepo(FILES);
			const abort = new AbortController();
			const outcomePromise = runWithBun(
				{
					cwd: repo,
					program: `await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/api.ts", "program api\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
					timeoutMs: 5000,
					rollback: "all",
					testHooks: { apply: { delayMs: 500, delayAfter: 2 } },
				},
				abort.signal,
			).then(
				(result) => result,
				(error: Error) => error,
			);
			await waitUntil(
				"src/api.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/api.ts"))) === "program api\n",
			);
			await Bun.write(path.join(repo, "src/api.ts"), "external api\n");
			await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
			abort.abort();
			const outcome = await outcomePromise;

			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).message).toContain("Rollback did not complete");
			expect((outcome as Error).message).toContain("src/api.ts");
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
			expect(await Bun.file(path.join(repo, "src/api.ts")).text()).toBe("external api\n");
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external b\n");
			for (const entry of await readdir(path.join(repo, "src"))) {
				if (entry.startsWith(".pi-shorthand-backup-")) {
					await rm(path.join(repo, "src", entry), { recursive: true, force: true });
				}
			}
		});

		test("rollback retains an installed file when its backup disappeared", async () => {
			const repo = await makeRepo(FILES);
			const runner = startRunner(
				repo,
				`await Bun.write("src/a.ts", "program a\\n");
			await Bun.write("src/b.ts", "program b\\n");`,
				withApplicationTestHooks({ delayMs: 500 }),
			);
			await waitUntil(
				"src/a.ts to be committed",
				async () => (await textIfFile(path.join(repo, "src/a.ts"))) === "program a\n",
			);
			const backupDirs = (await readdir(path.join(repo, "src"))).filter((entry) =>
				entry.startsWith(".pi-shorthand-backup-"),
			);
			let populatedBackup: string | undefined;
			for (const entry of backupDirs) {
				if (await Bun.file(path.join(repo, "src", entry, "original")).exists()) populatedBackup = entry;
			}
			expect(populatedBackup).toBeDefined();
			await rm(path.join(repo, "src", populatedBackup!, "original"), { force: true });
			await Bun.write(path.join(repo, "src/b.ts"), "external b\n");
			const { stderr, exitCode } = await runnerOutcome(runner);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("its backup changed");
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program a\n");
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external b\n");
			for (const entry of backupDirs) await rm(path.join(repo, "src", entry), { recursive: true, force: true });
		});

		test("does not clobber a file at the old predictable commit temporary path", async () => {
			const repo = await makeRepo(FILES);
			const collision = path.join(repo, "src/a.ts.pi-shorthand.tmp");
			await Bun.write(collision, "unrelated\n");

			await run(repo, `await Bun.write("src/a.ts", "updated\\n");`);

			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("updated\n");
			expect(await Bun.file(collision).text()).toBe("unrelated\n");
		});

		test("does not follow a symlink at the old predictable commit temporary path", async () => {
			const repo = await makeRepo(FILES);
			const victim = path.join(repo, "victim");
			const collision = path.join(repo, "src/a.ts.pi-shorthand.tmp");
			await Bun.write(victim, "untouched\n");
			await symlink("../victim", collision);

			await run(repo, `await Bun.write("src/a.ts", "updated\\n");`);

			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("updated\n");
			expect(await Bun.file(victim).text()).toBe("untouched\n");
			expect(await readlink(collision)).toBe("../victim");
		});

		test.skipIf(process.platform !== "linux")("staging an untouched untracked file does not delete it", async () => {
			const repo = await makeRepo(FILES);
			const untracked = path.join(repo, "notes.txt");
			await Bun.write(untracked, "keep me\n");

			const result = await run(repo, "await $`git add notes.txt`;");

			expect(result.changes).toEqual([]);
			expect(result.applied).toEqual([]);
			expect(await Bun.file(untracked).text()).toBe("keep me\n");
		});

		test.skipIf(process.platform !== "linux")(
			"newly ignoring an untouched untracked file does not delete it",
			async () => {
				const repo = await makeRepo({ ...FILES, ".gitignore": "" });
				const untracked = path.join(repo, "notes.tmp");
				await Bun.write(untracked, "keep me\n");

				const result = await run(repo, `await Bun.write(".gitignore", "*.tmp\\n");`);

				expect(result.applied).toEqual([".gitignore"]);
				expect(result.changes.map((change) => change.path)).toEqual([".gitignore"]);
				expect(await Bun.file(untracked).text()).toBe("keep me\n");
			},
		);

		test.skipIf(process.platform !== "linux")(
			"deleting an untracked file with a newline in its name still applies",
			async () => {
				const repo = await makeRepo(FILES);
				const file = "odd\nname.txt";
				await Bun.write(path.join(repo, file), "delete me\n");

				const result = await run(repo, `await Bun.file(${JSON.stringify(file)}).delete();`);

				expect(result.changes.map((change) => `${change.kind} ${change.path}`)).toEqual([`deleted ${file}`]);
				expect(result.applied).toEqual([file]);
				expect(await Bun.file(path.join(repo, file)).exists()).toBe(false);
			},
		);

		test.skipIf(process.platform !== "darwin")(
			"macOS change discovery preserves newline, tab, and Unicode filenames",
			async () => {
				const modified = "src/line\nbreak.ts";
				const deleted = "src/tab\tname.ts";
				const added = "src/雪-added.ts";
				const repo = await makeRepo({ ...FILES, [modified]: "before\n", [deleted]: "delete me\n" });

				const result = await run(
					repo,
					`await Bun.write(${JSON.stringify(modified)}, "after\\n");
				await Bun.file(${JSON.stringify(deleted)}).delete();
				await Bun.write(${JSON.stringify(added)}, "added\\n");`,
				);

				expect(result.exitCode).toBe(0);
				const expected: Array<{ path: string; kind: "added" | "deleted" | "modified" }> = [
					{ path: modified, kind: "modified" as const },
					{ path: deleted, kind: "deleted" as const },
					{ path: added, kind: "added" as const },
				].toSorted((a, b) => a.path.localeCompare(b.path));
				expect(result.changes.map(({ path: filePath, kind }) => ({ path: filePath, kind }))).toEqual(expected);
				expect(result.applied).toEqual(expected.map(({ path: filePath }) => filePath));
				expect(await Bun.file(path.join(repo, modified)).text()).toBe("after\n");
				expect(await Bun.file(path.join(repo, deleted)).exists()).toBe(false);
				expect(await Bun.file(path.join(repo, added)).text()).toBe("added\n");
			},
		);

		test("removing an ignore rule applies newly visible files and tracked ignored files", async () => {
			const repo = await makeRepo({ ".gitignore": "*.tmp\n" });
			await Bun.write(path.join(repo, "tracked.tmp"), "before\n");
			await $`git add -f tracked.tmp && git -c user.name=test -c user.email=test@test commit -qm tracked-ignored`.cwd(
				repo,
			);

			const result = await run(
				repo,
				`await Bun.write(".gitignore", "");
			await Bun.write("tracked.tmp", "after\\n");
			await Bun.write("new.tmp", "new\\n");`,
			);

			expect(result.applied).toEqual([".gitignore", "new.tmp", "tracked.tmp"]);
			expect(await Bun.file(path.join(repo, "new.tmp")).text()).toBe("new\n");
			expect(await Bun.file(path.join(repo, "tracked.tmp")).text()).toBe("after\n");
		});

		test("adding an ignore rule omits a file created by the same transaction", async () => {
			const repo = await makeRepo({ ".gitignore": "" });

			const result = await run(
				repo,
				`await Bun.write(".gitignore", "new.txt\\n");
			await Bun.write("new.txt", "ignored\\n");`,
			);

			expect(result.applied).toEqual([".gitignore"]);
			expect(result.changes.map((change) => change.path)).toEqual([".gitignore"]);
			expect(await Bun.file(path.join(repo, "new.txt")).exists()).toBe(false);
		});
	});

	describe("concurrency and conflict handling", () => {
		test.skipIf(process.platform !== "linux")(
			"lost native observation discards even completed file-level edits",
			async () => {
				const repo = await makeRepo(FILES);
				const runner = startRunner(
					repo,
					`
				await Bun.write("src/a.ts", "completed private edit\\n");
				process.kill(process.pid, "SIGSTOP");
			`,
					{ rollback: "file" },
				);
				const { stderr, exitCode } = await runnerOutcome(runner);
				expect(exitCode).not.toBe(0);
				expect(stderr).toMatch(/observation|explicit process group stops/);
				expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(FILES["src/a.ts"]);
				expect(await gitStatus(repo)).toBe("");
			},
		);

		test("renaming a newly created directory applies its staged descendants", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(
				repo,
				`
				const fs = await import("node:fs/promises");
				await fs.mkdir("staged/nested", { recursive: true });
				await Bun.write("staged/nested/new.txt", "new content\\n");
				await fs.rename("staged", "destination");
				await fs.rename("destination", "final");
			`,
			);
			expect(result.applied).toEqual(["final/nested/new.txt"]);
			expect(await Bun.file(path.join(repo, "final/nested/new.txt")).text()).toBe("new content\n");
		});

		for (const dependency of [
			{ name: "mapped contents", read: 'console.log(Bun.mmap("src/a.ts")[0]);', changed: "src/a.ts" },
			{ name: "metadata", read: 'console.log((await fs.stat("src/a.ts")).size);', changed: "src/a.ts" },
			{
				name: "negative lookup",
				read: 'console.log(await Bun.file("src/missing.ts").exists());',
				changed: "src/missing.ts",
			},
			{ name: "directory listing", read: 'console.log(await fs.readdir("src"));', changed: "src/added.ts" },
			{ name: "subprocess input", read: "await $`cat src/a.ts`; ", changed: "src/a.ts" },
		]) {
			test(`changed ${dependency.name} rejects the entire candidate`, async () => {
				const repo = await makeRepo(FILES);
				let reached = false;
				const barrier = Bun.serve({
					port: 0,
					hostname: "127.0.0.1",
					fetch: async () => {
						reached = true;
						await Bun.write(path.join(repo, dependency.changed), "external dependency change\n");
						return new Response("changed");
					},
				});
				try {
					const runner = startRunner(
						repo,
						`
						const fs = await import("node:fs/promises");
						${dependency.read}
						await fetch(${JSON.stringify(`http://127.0.0.1:${barrier.port}`)});
						await Bun.write("candidate.txt", "must not apply");
					`,
					);
					const { stdout, stderr, exitCode } = await runnerOutcome(runner);
					expect(reached, stderr).toBe(true);
					if (exitCode === 0) {
						const result: RunResult = JSON.parse(stdout);
						expect(result.conflicts.length).toBeGreaterThan(0);
						expect(result.applied).toEqual([]);
					} else expect(stderr).toMatch(/observation|source changed/);
					expect(await Bun.file(path.join(repo, "candidate.txt")).exists()).toBe(false);
					expect(await Bun.file(path.join(repo, dependency.changed)).text()).toBe("external dependency change\n");
				} finally {
					barrier.stop(true);
				}
			});
		}

		test("a changed read-only input rejects an otherwise unrelated output", async () => {
			const repo = await makeRepo(FILES);
			const barrier = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: async () => {
					await Bun.write(path.join(repo, "src/a.ts"), "external input\n");
					return new Response("changed");
				},
			});
			try {
				const runner = startRunner(
					repo,
					`const input = await Bun.file("src/a.ts").text();
await fetch(${JSON.stringify(`http://127.0.0.1:${barrier.port}`)});
await Bun.write("src/generated.ts", input);`,
				);
				const { stdout, stderr, exitCode } = await runnerOutcome(runner);
				if (exitCode === 0) {
					const result: RunResult = JSON.parse(stdout);
					expect(result.conflicts).toContain("src/a.ts");
					expect(result.applied).toEqual([]);
				} else expect(stderr).toMatch(/observation|source changed/);
				expect(await Bun.file(path.join(repo, "src/generated.ts")).exists()).toBe(false);
				expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("external input\n");
			} finally {
				barrier.stop(true);
			}
		});

		test("a run captures a file at first access rather than freezing the whole checkout at startup", async () => {
			const repo = await makeRepo(FILES);
			const ready = path.join(path.dirname(repo), "program-started");
			const runner = startRunner(
				repo,
				`await Bun.sleep(500);
			const original = await Bun.file("src/a.ts").text();
			await Bun.write("src/generated.ts", original);`,
				{ testHooks: { programStartMarker: ready } },
			);
			await waitForFile(ready);
			expect(await Bun.file(ready).exists()).toBe(true);
			await Bun.write(path.join(repo, "src/a.ts"), "external edit\n");

			const { stdout, stderr, exitCode } = await runnerOutcome(runner);
			expect(exitCode, stderr).toBe(0);
			const result: RunResult = JSON.parse(stdout);

			expect(result.applied).toEqual(["src/generated.ts"]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("external edit\n");
			expect(await Bun.file(path.join(repo, "src/generated.ts")).text()).toBe("external edit\n");
		});

		test("an external edit to a destination prevents every change from applying", async () => {
			const repo = await makeRepo(FILES);
			const barrier = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: async () => {
					await Bun.write(path.join(repo, "src/a.ts"), "external edit\n");
					return new Response("changed");
				},
			});
			const runner = startRunner(
				repo,
				`await Bun.write("src/a.ts", "program edit\\n");
			await fetch(${JSON.stringify(`http://127.0.0.1:${barrier.port}`)});
			await Bun.write("src/generated.ts", "should not apply\\n");`,
			);
			const { stdout, stderr, exitCode } = await runnerOutcome(runner);
			barrier.stop(true);
			if (exitCode === 0) {
				const result: RunResult = JSON.parse(stdout);
				expect(result.conflicts).toContain("src/a.ts");
				expect(result.applied).toEqual([]);
			} else expect(stderr).toMatch(/observation|source changed/);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("external edit\n");
			expect(await Bun.file(path.join(repo, "src/generated.ts")).exists()).toBe(false);
		});

		test("an external edit to another file survives while the candidate applies", async () => {
			const repo = await makeRepo(FILES);
			const ready = path.join(path.dirname(repo), "different-file-program-started");
			const runner = startRunner(
				repo,
				`await Bun.sleep(500);
			await Bun.write("src/a.ts", "program edit\\n");`,
				{ testHooks: { programStartMarker: ready } },
			);
			await waitForFile(ready);
			expect(await Bun.file(ready).exists()).toBe(true);
			await Bun.write(path.join(repo, "src/b.ts"), "external edit\n");

			const { stdout, exitCode } = await runnerOutcome(runner);
			const result: RunResult = JSON.parse(stdout);
			expect(exitCode).toBe(0);
			expect(result.conflicts).toEqual([]);
			expect(result.applied).toEqual(["src/a.ts"]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("program edit\n");
			expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("external edit\n");
		});

		test("external edits survive a failing run on the same or another file", async () => {
			for (const externalFile of ["src/a.ts", "src/b.ts"]) {
				const repo = await makeRepo(FILES);
				const suffix = path.basename(externalFile);
				const ready = path.join(path.dirname(repo), `failed-program-started-${suffix}`);
				const runner = startRunner(
					repo,
					`await Bun.sleep(500);
				await Bun.write("src/a.ts", "program edit\\n");
				throw new Error("fail after writing");`,
					{ testHooks: { programStartMarker: ready } },
				);
				await waitForFile(ready);
				expect(await Bun.file(ready).exists()).toBe(true);
				await Bun.write(path.join(repo, externalFile), `external ${suffix}\n`);

				const { stdout, exitCode } = await runnerOutcome(runner);
				const result: RunResult = JSON.parse(stdout);
				expect(exitCode).toBe(0);
				expect(result.exitCode).toBe(1);
				expect(result.applied).toEqual([]);
				expect(await Bun.file(path.join(repo, externalFile)).text()).toBe(`external ${suffix}\n`);
			}
		});

		test("external edits survive a cancelled run on the same or another file", async () => {
			for (const externalFile of ["src/a.ts", "src/b.ts"]) {
				const repo = await makeRepo(FILES);
				const suffix = path.basename(externalFile);
				const ready = path.join(path.dirname(repo), `cancelled-program-started-${suffix}`);
				const runner = startRunner(
					repo,
					`await Bun.write("src/a.ts", "program edit\\n");
				await Bun.sleep(30_000);`,
					{ timeoutMs: 60_000, testHooks: { programStartMarker: ready } },
				);
				await waitForFile(ready);
				expect(await Bun.file(ready).exists()).toBe(true);
				await Bun.write(path.join(repo, externalFile), `external ${suffix}\n`);
				runner.kill("SIGTERM");

				const { stdout, exitCode } = await runnerOutcome(runner);
				const result: RunResult = JSON.parse(stdout);
				expect(exitCode).toBe(0);
				expect(result.applied).toEqual([]);
				expect(await Bun.file(path.join(repo, externalFile)).text()).toBe(`external ${suffix}\n`);
			}
		});

		test("a parent replaced by a symlink cannot redirect application", async () => {
			const repo = await makeRepo(FILES);
			const ready = path.join(path.dirname(repo), "parent-program-started");
			const outside = path.join(path.dirname(repo), "outside");
			await mkdir(outside);
			await Bun.write(path.join(outside, "a.ts"), "outside\n");
			const runner = startRunner(
				repo,
				`await Bun.sleep(500);
			await Bun.write("src/a.ts", "program edit\\n");`,
				{ testHooks: { programStartMarker: ready } },
			);
			await waitForFile(ready);
			expect(await Bun.file(ready).exists()).toBe(true);
			await rename(path.join(repo, "src"), path.join(repo, "src-original"));
			await symlink(outside, path.join(repo, "src"));

			const { stdout, stderr, exitCode } = await runnerOutcome(runner);
			if (exitCode === 0) {
				const result: RunResult = JSON.parse(stdout);
				// A live lower may encounter the replacement before its first read.
				// In that case the sandbox rejects the write, without a candidate to conflict.
				expect(result.conflicts.includes("src/a.ts") || result.exitCode !== 0).toBe(true);
				expect(result.applied).toEqual([]);
			} else expect(stderr).toMatch(/observation|source changed/);
			expect(await Bun.file(path.join(outside, "a.ts")).text()).toBe("outside\n");
		});

		test("two runs on the same repository both apply", async () => {
			const repo = await makeRepo(FILES);
			const [first, second] = await Promise.all([
				run(repo, `await Bun.sleep(300);\nawait Bun.write("src/one.ts", "export {};\\n");`),
				run(repo, `await Bun.write("src/two.ts", "export {};\\n");`),
			]);

			expect(first.applied).toEqual(["src/one.ts"]);
			expect(second.applied).toEqual(["src/two.ts"]);
			expect(await gitStatus(repo)).toBe("?? src/one.ts\n?? src/two.ts");
		});

		test("two runs changing the same file execute against successive baselines", async () => {
			const repo = await makeRepo(FILES);
			const firstReady = path.join(path.dirname(repo), "first-run-ready");
			const secondReady = path.join(path.dirname(repo), "second-run-ready");
			const first = startRunner(
				repo,
				`await Bun.sleep(500);
			await Bun.write("src/a.ts", "first\\n");`,
				{ testHooks: { programStartMarker: firstReady } },
			);
			await waitForFile(firstReady);
			expect(await Bun.file(firstReady).exists()).toBe(true);

			const second = startRunner(
				repo,
				`const prior = await Bun.file("src/a.ts").text();
			await Bun.write("src/a.ts", prior + "second\\n");`,
				{ testHooks: { programStartMarker: secondReady } },
			);
			await Bun.sleep(100);
			expect(await Bun.file(secondReady).exists()).toBe(false);

			const [firstOutcome, secondOutcome] = await Promise.all([runnerOutcome(first), runnerOutcome(second)]);
			expect(firstOutcome.exitCode).toBe(0);
			expect(secondOutcome.exitCode).toBe(0);
			expect((JSON.parse(firstOutcome.stdout) as RunResult).conflicts).toEqual([]);
			expect((JSON.parse(secondOutcome.stdout) as RunResult).conflicts).toEqual([]);
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("first\nsecond\n");
		});

		test("a run cancelled while waiting for the lock never starts", async () => {
			const repo = await makeRepo(FILES);
			const firstReady = path.join(path.dirname(repo), "lock-holder-ready");
			const secondStarted = path.join(path.dirname(repo), "cancelled-run-started");
			const first = startRunner(repo, `await Bun.sleep(500);`, { testHooks: { programStartMarker: firstReady } });
			await waitForFile(firstReady);
			expect(await Bun.file(firstReady).exists()).toBe(true);

			const second = startRunner(repo, ``, { testHooks: { programStartMarker: secondStarted } });
			await Bun.sleep(100);
			second.kill("SIGTERM");
			expect(await second.exited).not.toBe(0);
			expect(await Bun.file(secondStarted).exists()).toBe(false);

			expect(await first.exited).toBe(0);
			expect(await Bun.file(secondStarted).exists()).toBe(false);
		});

		test.skipIf(process.platform !== "darwin")("a crashed isolated run leaves the checkout usable", async () => {
			const repo = await makeRepo(FILES);
			const cwdFile = path.join(path.dirname(repo), "isolated-cwd");
			const runner = startRunner(repo, `await Bun.write("src/a.ts", "half way");\nawait Bun.sleep(30_000);`, {
				timeoutMs: 60_000,
				testHooks: { programStartMarker: cwdFile },
			});
			await waitForFile(cwdFile);
			const { mount: isolatedCwd } = await Bun.file(macRecoveryFile(repo)).json();
			await waitUntil(
				"isolated write",
				async () => (await Bun.file(path.join(isolatedCwd, "src/a.ts")).text()) === "half way",
			);
			runner.kill("SIGKILL");
			await runner.exited;
			expect(await gitStatus(repo)).toBe("");

			const result = await run(repo, "");
			expect(result.exitCode).toBe(0);
			expect(await gitStatus(repo)).toBe("");
			expect(await Bun.file(isolatedCwd).exists()).toBe(false);
		});
	});

	describe("diagnostics", () => {
		test("streams live progress to the extension without persistent history", async () => {
			const repo = await makeRepo(FILES);
			const steps: string[] = [];
			const result = await runWithBun(
				{
					cwd: repo,
					program: `grep("oldApi", "src");`,
					timeoutMs: 1000,
					rollback: "file",
				},
				undefined,
				(step) => steps.push(step),
			);

			expect(result.exitCode).toBe(0);
			expect(steps).toContainEqual(expect.stringMatching(/^grep \(\d+ ms\)$/));
		});

		test("reports the program line an error came from, even a long one", async () => {
			const repo = await makeRepo(FILES);
			const long = `if (true) throw new Error("${"x".repeat(150)}");`;
			const result = await run(repo, `const a = 1;\nconst b = 2;\n${long}`);

			expect(result.errorLine?.startsWith("line 3: if (true) throw new Error(")).toBe(true);
		});

		test("reports the last step a program logged before timing out in its own code", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(repo, `grep("oldApi", "src");\nwhile (true) {}`, { timeoutMs: 1000 });

			expect(result.timedOut).toBe(true);
			expect(result.stillRunning).toEqual([]);
			expect(result.lastStep).toMatch(/^grep \(\d+ ms\)$/);
		});

		test("a direct runner call retains its last step in memory", async () => {
			const repo = await makeRepo(FILES);
			// Permit startup and grep before testing the subsequent busy-loop timeout.
			const result = await run(repo, `grep("oldApi", "src");\nwhile (true) {}`, { timeoutMs: 1000 });

			expect(result.timedOut).toBe(true);
			expect(result.lastStep).toMatch(/^grep \(\d+ ms\)$/);
		});

		test("warns about $ commands that aren't awaited", async () => {
			const repo = await makeRepo(FILES);
			const result = await run(repo, "$`touch src/never.ts`;");

			expect(result.warnings).toEqual(["line 1: $`touch src/never.ts` isn't awaited, so the command may not have run"]);
		});
	});
});

describe.skipIf(!hasOverlay)("automatic formatting", () => {
	for (const disabled of [false, true]) {
		test(`malformed formatter configuration retains completed edits (disabled=${disabled})`, async () => {
			const repo = await makeRepo({ "a.ts": "before();\n", "package.json": '{"scripts":{"format":42}}' });
			const result = await run(
				repo,
				'await Bun.write("a.ts", "after();\\n");',
				{},
				disabled ? { PI_SHORTHAND_FORMAT: "0" } : {},
			);
			expect(result.applied).toEqual(["a.ts"]);
			expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("after();\n");
			if (disabled) expect(result.warnings).toEqual([]);
			else expect(result.warnings.join("\n")).toContain("Automatic formatting failed");
		});
	}

	test("reports final workspace cleanup in the total and phase timings", async () => {
		const repo = await makeRepo({ "a.txt": "before\n" });
		const result = await run(repo, "", { testHooks: { finalCleanupDelayMs: 100 } });
		expect(result.timings!.workspaceCloseMs).toBeGreaterThanOrEqual(100);
		expect(result.durationMs).toBeGreaterThanOrEqual(result.timings!.workspaceCloseMs);
		const total = Object.values(result.timings!).reduce((sum, ms) => sum + ms, 0);
		expect(Math.abs(result.durationMs - total)).toBeLessThanOrEqual(Object.keys(result.timings!).length);
	});

	test.skipIf(process.platform !== "linux")(
		"skips the formatting pass when the edited workspace has no formatter",
		async () => {
			const repo = await makeRepo({ "a.ts": "before();\n" });
			const result = await run(repo, 'await Bun.write("a.ts", "after();\\n");');
			expect(result.applied).toEqual(["a.ts"]);
			expect(result.timings?.formatMs).toBe(0);
			expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("after();\n");
		},
	);

	for (const [writer, program] of [
		["Bun", 'await Bun.write("a.ts", "newApi();\\nadded();\\n");'],
		["Node", '(await import("node:fs")).writeFileSync("a.ts", "newApi();\\nadded();\\n");'],
		["edit", 'edit({ path: "a.ts", oldText: "oldApi();", newText: "newApi();\\nadded();" });'],
		["ast-grep", 'sg.rewrite("oldApi();", "newApi();\\nadded();", "a.ts");'],
	]) {
		test(`shared text preservation covers ${writer} writes without a formatter`, async () => {
			const repo = await makeRepo({ "a.ts": "\uFEFFoldApi();\r\n" });
			const result = await run(repo, program, {}, { PI_SHORTHAND_FORMAT: "0" });
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(repo, "a.ts")).bytes()).toEqual(
				new TextEncoder().encode("\uFEFFnewApi();\r\nadded();\r\n"),
			);
		});
	}

	test("shared text preservation feeds formatters, which can set the final convention", async () => {
		const repo = await makeRepo({
			"a.ts": "\uFEFFold();\r\n",
			"package.json": '{"scripts":{"format":"oxfmt"}}',
			".gitignore": "node_modules/\n",
		});
		await Bun.write(
			path.join(repo, "node_modules/.bin/oxfmt"),
			`#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
if (readFileSync("a.ts", "utf8") !== "\\uFEFFnew();\\r\\n") throw new Error("Not preserved before formatting");
writeFileSync("a.ts", "new();\\n");
`,
		);
		await chmod(path.join(repo, "node_modules/.bin/oxfmt"), 0o755);
		const result = await run(repo, 'await Bun.write("a.ts", "new();\\n");');
		expect(result.exitCode).toBe(0);
		expect(result.warnings).toEqual([]);
		expect(await Bun.file(path.join(repo, "a.ts")).bytes()).toEqual(new TextEncoder().encode("new();\n"));
	});

	test("shared text preservation can be disabled for deliberate conversions", async () => {
		const repo = await makeRepo({ "a.txt": "\uFEFFold\r\n" });
		const result = await run(repo, 'await Bun.write("a.txt", "new\\n");', {}, { PI_SHORTHAND_PRESERVE_TEXT: "0" });
		expect(result.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "a.txt")).bytes()).toEqual(new TextEncoder().encode("new\n"));
	});

	test("shared text preservation excludes binary and new files and removes format-only changes", async () => {
		const repo = await makeRepo({ "a.txt": "\uFEFFsame\r\n", "binary.dat": "old\u0000\r\n" });
		const result = await run(
			repo,
			`
			await Bun.write("a.txt", "same\\n");
			await Bun.write("binary.dat", new Uint8Array([255, 0, 10]));
			await Bun.write("new.txt", "new\\n");
		`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.applied).toEqual(["binary.dat", "new.txt"]);
		expect(await Bun.file(path.join(repo, "a.txt")).bytes()).toEqual(new TextEncoder().encode("\uFEFFsame\r\n"));
		expect(await Bun.file(path.join(repo, "binary.dat")).bytes()).toEqual(new Uint8Array([255, 0, 10]));
		expect(await Bun.file(path.join(repo, "new.txt")).bytes()).toEqual(new TextEncoder().encode("new\n"));
	});

	for (const timeout of [false, true])
		test(`retains the pre-format candidate after formatter ${timeout ? "timeout" : "failure"} with partial writes`, async () => {
			const repo = await makeRepo({
				"a.ts": "before\n",
				"untouched.ts": "unchanged\n",
				"remove.ts": "remove me\n",
				".gitignore": "node_modules/\n",
				"package.json": '{"scripts":{"format":"oxfmt"}}',
			});
			await Bun.write(
				path.join(repo, "node_modules/.bin/oxfmt"),
				`#!${process.execPath}
import { openSync, writeSync, unlinkSync } from "node:fs";
const fd = openSync("a.ts", "w"); writeSync(fd, "truncated");
await Bun.write("new.ts", "damaged");
await Bun.write("formatter-only.ts", "extra");
await Bun.write(".gitignore", "node_modules/\\na.ts\\nnew.ts\\n");
unlinkSync("untouched.ts");
${timeout ? "await Bun.sleep(30_000);" : "process.exit(2);"}
`,
			);
			await chmod(path.join(repo, "node_modules/.bin/oxfmt"), 0o755);
			const result = await run(
				repo,
				`
				await Bun.write("a.ts", "completed edit\\n");
				await Bun.write("new.ts", "completed addition\\n");
				await Bun.file("remove.ts").delete();
			`,
			);
			expect(result.exitCode).toBe(0);
			expect(result.warnings.join("\n")).toContain(timeout ? "formatting timed out" : "formatting failed");
			expect(result.applied).toEqual(["a.ts", "new.ts", "remove.ts"]);
			expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("completed edit\n");
			expect(await Bun.file(path.join(repo, "new.ts")).text()).toBe("completed addition\n");
			expect(await Bun.file(path.join(repo, "untouched.ts")).text()).toBe("unchanged\n");
			expect(await Bun.file(path.join(repo, ".gitignore")).text()).toBe("node_modules/\n");
			expect(await Bun.file(path.join(repo, "remove.ts")).exists()).toBe(false);
			expect(await Bun.file(path.join(repo, "formatter-only.ts")).exists()).toBe(false);
			expect(result.changes.find((change) => change.path === "a.ts")?.patch).toContain("+completed edit");
		});

	test("formats before diffing, includes additional formatter writes and preserves edits on formatter failure", async () => {
		const repo = await makeRepo({
			"a.ts": "before\n",
			"untouched.ts": "unchanged\n",
			".gitignore": "node_modules/\n",
			"package.json": '{"scripts":{"format":"oxfmt"}}',
		});
		await Bun.write(
			path.join(repo, "node_modules/.bin/oxfmt"),
			`#!${process.execPath}\nfor (const file of process.argv.slice(2)) await Bun.write(file, "formatted\\n"); await Bun.write("extra.ts", "extra\\n");`,
		);
		await chmod(path.join(repo, "node_modules/.bin/oxfmt"), 0o755);
		const result = await run(repo, 'await Bun.write("a.ts", "candidate\\n");');
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Formatted 1 file(s) with oxfmt");
		expect(result.applied).toEqual(["a.ts", "extra.ts"]);
		expect(result.changes.find((change) => change.path === "a.ts")?.patch).toContain("+formatted");
		expect(await Bun.file(path.join(repo, "untouched.ts")).text()).toBe("unchanged\n");
		await Bun.write(path.join(repo, "node_modules/.bin/oxfmt"), "#!/bin/sh\necho format-error >&2\nexit 1\n");
		const failure = await run(repo, 'await Bun.write("a.ts", "retained\\n");');
		expect(failure.exitCode).toBe(0);
		expect(failure.warnings.join("\n")).toContain("format-error");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("retained\n");
	});

	test("skips formatting failed programs and when disabled", async () => {
		const repo = await makeRepo({
			"a.ts": "before\n",
			".gitignore": "node_modules/\n",
			"package.json": '{"scripts":{"format":"oxfmt"}}',
		});
		await Bun.write(path.join(repo, "node_modules/.bin/oxfmt"), "#!/bin/sh\necho should-not-run >&2\nexit 1\n");
		await chmod(path.join(repo, "node_modules/.bin/oxfmt"), 0o755);
		const failed = await run(repo, 'await Bun.write("a.ts", "candidate"); throw Error("edit failed");');
		expect(failed.exitCode).toBe(1);
		expect(failed.warnings.join("\n")).not.toContain("should-not-run");
		const disabled = await run(repo, 'await Bun.write("a.ts", "candidate");', {}, { PI_SHORTHAND_FORMAT: "0" });
		expect(disabled.warnings.join("\n")).not.toContain("should-not-run");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("candidate");
	});
});

const THREE_THEN_TWO = `sg.rewrite("request($URL, undefined, $T)", "request($URL, { timeoutMs: $T })", "src");
sg.rewrite("request($URL, $R, $T)", "request($URL, { retries: $R, timeoutMs: $T })", "src");
sg.rewrite("request($URL, $R)", "request($URL, { retries: $R })", "src");`;
const TWO_THEN_THREE = `sg.rewrite("request($URL, $R)", "request($URL, { retries: $R })", "src");
sg.rewrite("request($URL, undefined, $T)", "request($URL, { timeoutMs: $T })", "src");
sg.rewrite("request($URL, $R, $T)", "request($URL, { retries: $R, timeoutMs: $T })", "src");`;

describe.skipIf(!hasOverlay)("prelude", () => {
	test("glob and grep throw with Git diagnostics while grep no-match remains empty", async () => {
		const repo = await makeRepo({ ...FILES, ".gitignore": "fake/\n" });
		const result = await run(
			repo,
			`const fs = await import("node:fs/promises");
			await fs.mkdir("fake");
			await Bun.write("fake/git", "#!/bin/sh\\necho git exploded >&2\\nexit 2\\n");
			await fs.chmod("fake/git", 0o755);
			process.env.PATH = process.cwd() + "/fake:" + process.env.PATH;
			for (const [name, call] of [["glob", () => glob("**/*")], ["grep", () => grep("oldApi")]]) {
				try { call(); } catch (error) { console.log(name + ": " + error.message); }
			}`,
		);

		expect(result.output).toContain("glob: git ls-files failed (exit 2): git exploded");
		expect(result.output).toContain("grep: git grep failed (exit 2): git exploded");

		const noMatch = await run(repo, `console.log(JSON.stringify(grep("definitely absent")));`);
		expect(noMatch.output.trim()).toBe("[]");
	});

	test("grep rejects malformed Git output", async () => {
		const repo = await makeRepo({ ...FILES, ".gitignore": "fake/\n" });
		const result = await run(
			repo,
			`const fs = await import("node:fs/promises");
			await fs.mkdir("fake");
			await Bun.write("fake/git", "#!/bin/sh\\nprintf 'broken\\n'\\n");
			await fs.chmod("fake/git", 0o755);
			process.env.PATH = process.cwd() + "/fake:" + process.env.PATH;
			grep("anything");`,
		);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('git grep returned malformed output: "broken\\n"');
	});

	test("grep preserves newline, tab, and Unicode filenames", async () => {
		const files = {
			"src/line\nbreak.ts": "needle newline\n",
			"src/tab\tname.ts": "needle tab\n",
			"src/雪.ts": "needle Unicode\n",
		};
		const repo = await makeRepo(files);
		const result = Bun.spawnSync(
			[
				"bun",
				"--preload",
				path.join(import.meta.dir, "../src/program/prelude.ts"),
				"-e",
				`console.log(JSON.stringify(grep("needle")));`,
			],
			{ cwd: repo, env: process.env },
		);

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual([
			{ file: "src/line\nbreak.ts", line: 1, text: "needle newline" },
			{ file: "src/tab\tname.ts", line: 1, text: "needle tab" },
			{ file: "src/雪.ts", line: 1, text: "needle Unicode" },
		]);
	});

	test("sg validates every scope before any file is edited", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`
			for (const helper of ["find", "one", "rewrite"]) {
				try {
					const files = ["src/a.ts", { file: "src/b.ts" }];
					if (helper === "rewrite") sg.rewrite("oldApi($A)", "newApi($A)", files);
					else sg[helper]("oldApi($A)", files);
				} catch (error) { console.log(error.message); }
			}`,
		);
		for (const helper of ["find", "one", "rewrite"])
			expect(result.output).toContain(`sg.${helper}: files must be paths, sg.file() targets, or an array of either`);
		expect(result.exitCode).toBe(0);
		expect(result.changes).toEqual([]);
	});

	test("sg accepts file targets, deduplicates mixed scopes and reads fresh source", async () => {
		const repo = await makeRepo({ "a.ts": "oldApi(1);\n", "b.ts": "oldApi(2);\n" });
		const result = await run(
			repo,
			`
			const a = sg.file("a.ts");
			console.log(sg.one("oldApi($A)", a).A);
			console.log(sg.find("oldApi($A)", [a, "a.ts", sg.file("b.ts")]).length);
			console.log(sg.rewrite("oldApi($A)", "newApi($A)", [a, "a.ts", sg.file("b.ts")]));
			console.log(sg.one("newApi($A)", a).A);
		`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual(["1", "2", "2", "1"]);
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("newApi(1);\n");
		expect(await Bun.file(path.join(repo, "b.ts")).text()).toBe("newApi(2);\n");
	});

	test("sg file targets explicitly select ignored files without changing apply eligibility", async () => {
		const repo = await makeRepo({ ".gitignore": "ignored.ts\n", "a.ts": "oldApi(1);\n", "ignored.ts": "oldApi(2);\n" });
		const result = await run(
			repo,
			`
			const target = sg.file("ignored.ts");
			console.log(sg.find("oldApi($A)", ".").length);
			console.log(sg.one("oldApi($A)", target).A);
			console.log(sg.rewrite("oldApi($A)", "newApi($A)", target));
			console.log(await Bun.file("ignored.ts").text());
		`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual(["1", "2", "1", "newApi(2);"]);
		expect(result.applied).toEqual([]);
		expect(await Bun.file(path.join(repo, "ignored.ts")).text()).toBe("oldApi(2);\n");
	});

	test("sg rejects missing or escaped targets before rewriting any file", async () => {
		const repo = await makeRepo({ "a.ts": "oldApi(1);\n" });
		const result = await run(
			repo,
			`
			const missing = sg.file("new.ts");
			try { sg.rewrite("oldApi($A)", "newApi($A)", ["a.ts", missing]); }
			catch (error) { console.log(error.message); }
			const escaped = sg.file("a.ts");
			escaped.file = "../escape.ts";
			try { sg.find("oldApi($A)", escaped); }
			catch (error) { console.log(error.message); }
			console.log(await Bun.file("new.ts").exists());
		`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('sg.rewrite: file target does not exist or is not a file: "new.ts"');
		expect(result.output).toContain("path is outside the repository");
		expect(result.output.trim()).toEndWith("false");
		expect(result.changes).toEqual([]);
	});

	test("sg rewrites with a rule object whose constraints restrict a capture", async () => {
		const repo = await makeRepo({ "a.ts": "oldApi(1);\nlegacyApi(2);\nkeepApi(3);\n" });
		const result = await run(
			repo,
			`sg.rewrite({ rule: { pattern: "$F($X)" }, constraints: { F: { regex: "^(oldApi|legacyApi)$" } } }, "newApi($X)", "a.ts");`,
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("newApi(1);\nnewApi(2);\nkeepApi(3);\n");
	});

	test("sg resolves scopes from a subdirectory without doubling the directory", async () => {
		const repo = await makeRepo({
			"src/a.ts": "one(1);\ntwo(1);\n",
			"src/b.ts": "three(2);\nfour(2);\n",
			"src/src/a.ts": "one(99);\ntwo(99);\nthree(99);\n",
			"outside.ts": "one(3);\nfour(3);\n",
		});
		const result = await run(
			repo,
			`
			process.chdir("src");
			sg.rewrite("one($X)", "explicit($X)", "a.ts");
			sg.rewrite("two($X)", "targeted($X)", sg.file("a.ts"));
			sg.rewrite("three($X)", "globbed($X)", "*.ts");
			sg.rewrite("four($X)", "directory($X)", ".");
			console.log(sg.one("explicit($X)", "a.ts").file);
		`,
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(result.output.trim()).toBe("a.ts");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("explicit(1);\ntargeted(1);\n");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe("globbed(2);\ndirectory(2);\n");
		expect(await Bun.file(path.join(repo, "src/src/a.ts")).text()).toBe("one(99);\ntwo(99);\nthree(99);\n");
		expect(await Bun.file(path.join(repo, "outside.ts")).text()).toBe("one(3);\nfour(3);\n");
	});

	test("a failure after importing TypeScript 7 explains that the classic compiler API is gone", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`import ts from "typescript";\nts.createSourceFile("a.ts", "", ts.ScriptTarget.Latest);`,
		);

		expect(result.exitCode).toBe(1);
		expect(result.warnings).toEqual([
			expect.stringMatching(/^typescript resolves to 7\.[\d.]+ here, which no longer has the classic compiler API/),
		]);
	});

	test("sg.rewrite by pattern skips what an earlier rewrite produced, whatever the order", async () => {
		const source =
			'export const mascot = "😀"; request("/a", undefined, 750);\nrequest("/b", 3);\nrequest("/c", 2, 500);\n';
		const migrated =
			'export const mascot = "😀"; request("/a", { timeoutMs: 750 });\nrequest("/b", { retries: 3 });\nrequest("/c", { retries: 2, timeoutMs: 500 });\n';
		const cases = [
			// The benchmark's order: without skipping, the new two-argument calls would be rewritten again.
			{
				program: THREE_THEN_TWO,
				skips:
					/skipped 2 places inside text an earlier sg\.rewrite produced, e\.g\. src\/a\.ts:1 request\("\/a", \{ timeoutMs: 750 \}\)\. Rewrites apply one after another/,
				result: migrated,
			},
			// Two-argument calls first: later patterns cannot match earlier output.
			{ program: TWO_THEN_THREE, skips: null, result: migrated },
			// Wrapping earlier output in a larger node is intended and still applies.
			{
				program: `${TWO_THEN_THREE}\nsg.rewrite("request($$$ARGS);", "void request($$$ARGS);", "src");`,
				skips: null,
				result: migrated.replaceAll("request(", "void request("),
			},
		];
		for (const { program, skips, result: expected } of cases) {
			const repo = await makeRepo({ "src/a.ts": source });
			const result = await run(repo, program);
			expect(result.exitCode).toBe(0);
			if (skips) expect(result.output).toMatch(skips);
			else expect(result.output).not.toContain("earlier sg.rewrite produced");
			expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(expected);
		}
	});

	test("sg.rewrite does not treat an unchanged replacement as earlier output", async () => {
		const repo = await makeRepo({ "src/a.ts": "f(1);\nf(2);\n" });
		const result = await run(
			repo,
			`sg.rewrite("f($A)", (m) => (m.A === "1" ? "g(1)" : m.text), "src");
sg.rewrite("f($A)", "h($A)", "src");`,
		);

		expect(result.output).not.toContain("earlier sg.rewrite produced");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("g(1);\nh(2);\n");
	});

	test("sg.rewrite follows earlier output through later edits, and a selection still rewrites it", async () => {
		const repo = await makeRepo({ "src/a.ts": 'const m = "😀"; old(1);\nkeep(2);\nold(3);\n' });
		const result = await run(
			repo,
			`sg.rewrite("old($A)", "next($A, { from: $A })", "src");
sg.rewrite("keep($A)", "kept($A, $A, $A)", "src");
sg.rewrite("next($A, $B)", "last($A)", "src");
sg.rewrite("next($A, $B)", "again($A)", "src");
console.log("selected", sg.rewrite(sg.find("next($A, $B)", "src"), "last($A)"));`,
		);

		expect(result.output).toMatch(
			/skipped 2 places inside text an earlier sg\.rewrite produced, e\.g\. src\/a\.ts:1 next\(1, \{ from: 1 \}\)/,
		);
		expect(result.output).toContain("selected 2");
		expect(result.output.match(/earlier sg\.rewrite produced/g)).toHaveLength(1);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(
			'const m = "😀"; last(1);\nkept(2, 2, 2);\nlast(3);\n',
		);
	});

	test("time inside sg helpers does not count toward the program timeout", async () => {
		const files = Object.fromEntries(
			Array.from({ length: 40 }, (_, i) => [`src/f${i}.ts`, `export const value${i} = call(${i});\n`.repeat(40)]),
		);
		const repo = await makeRepo(files);
		const result = await run(
			repo,
			`const started = performance.now();
while (performance.now() - started < 1500) sg.find("call($A)", "src");`,
			{ timeoutMs: 300 },
		);

		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.helperMs).toBeGreaterThan(1000);
	});

	test("refactor.move refuses when a file loads the source with import() split across lines", async () => {
		const repo = await makeRepo({
			"src/a.ts": "export function moveMe() { return 1; }\n",
			"src/b.ts": 'export const load = () =>\n\timport\n\t\t("./a");\n',
		});
		const result = await run(repo, `await refactor.move({ file: "src/a.ts", symbol: "moveMe", to: "src/moved.ts" });`, {
			timeoutMs: 15_000,
		});

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("loads");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("export function moveMe() { return 1; }\n");
	});

	test("path parameters also accept sg.file targets", async () => {
		const repo = await makeRepo({
			"tsconfig.json": JSON.stringify({ include: ["src"] }),
			"src/a.ts": "export function run() { return 1; }\n",
			"src/b.ts": 'import { run } from "./a";\nexport const b = run();\n',
		});
		const result = await run(
			repo,
			`edit({ path: sg.file("src/b.ts"), oldText: "run();", newText: "run() + 1;" });
console.log(grep("run", [sg.file("src/a.ts")]).length);
await refactor.rename({ file: sg.file("src/a.ts"), symbol: "run", to: "start" });
await refactor.move({ file: sg.file("src/a.ts"), symbol: "start", to: sg.file("src/start.ts") });
await refactor.renameFile({ from: sg.file("src/start.ts"), to: sg.file("src/lib/start.ts") });`,
			{ timeoutMs: 15_000 },
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("1");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe(
			'import { start } from "./lib/start";\nexport const b = start() + 1;\n',
		);
		expect(await Bun.file(path.join(repo, "src/lib/start.ts")).text()).toBe("export function start() { return 1; }\n");
	});

	test("refactor.move moves a declaration to another file and updates its imports", async () => {
		const repo = await makeRepo({
			"src/a.ts": 'import { helper } from "./util";\nexport function moveMe() { return helper(); }\n',
			"src/util.ts": "export const helper = () => 1;\n",
			"src/b.ts": 'import { moveMe } from "./a";\nexport const b = moveMe();\n',
		});
		const result = await run(
			repo,
			`await refactor.move({ file: "src/a.ts", symbol: "moveMe", to: "src/lib/moved.ts" });`,
		);

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "src/lib/moved.ts")).text()).toBe(
			'import { helper } from "../util";\nexport function moveMe() { return helper(); }\n',
		);
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toBe(
			'import { moveMe } from "./lib/moved";\nexport const b = moveMe();\n',
		);
	});

	test("sg matches a standalone class method pattern as a method", async () => {
		const source =
			"class C {\n  format(x: number): string { return String(x); }\n  other(x: number): string { return String(x); }\n}\n";
		const repo = await makeRepo({ "src/a.ts": source });
		const result = await run(
			repo,
			`const method = sg.one("format($$$PARAMS): string { $$$BODY }", "src/a.ts");
console.log(method.vars.PARAMS);
sg.rewrite(method, (m) => m.node.field("body")!.replace("{ return String(x + 1); }"));`,
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("x: number");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe(
			source.replace(
				"format(x: number): string { return String(x); }",
				"format(x: number): string { return String(x + 1); }",
			),
		);
	});

	test("sg leaves unrelated invalid patterns as errors without suggesting a class-method match", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			'try { sg.rewrite("a(); b();", "c();", "src/a.ts"); } catch (error) { console.log(error.message); }',
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("sg.rewrite:");
		expect(result.output).toContain("Patterns must parse as one syntax node");
		expect(result.applied).toEqual([]);
	});

	test("sg.rewrite reuses selected matches across files and preserves captures", async () => {
		const repo = await makeRepo({ "a.ts": "old(1); old(2);\n", "b.ts": "old(3);\n" });
		const result = await run(
			repo,
			`const matches = sg.find("old($A)");
console.log(sg.rewrite(matches, "next($A)"));
console.log(sg.rewrite(sg.one("next(3)", "b.ts"), m => m.node.replace("done(3)")));
console.log(sg.rewrite([], "unused()"));`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("3\n1\n0");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("next(1); next(2);\n");
		expect(await Bun.file(path.join(repo, "b.ts")).text()).toBe("done(3);\n");
	});

	test("sg.rewrite selected matches support HTML", async () => {
		const repo = await makeRepo({ "a.html": "<p>old</p>\n" });
		const result = await run(repo, `sg.rewrite(sg.one("<p>old</p>", "a.html"), "<p>new</p>");`);
		expect(result.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "a.html")).text()).toBe("<p>new</p>\n");
	});

	test("sg.rewrite rejects stale, fabricated and conflicting selections before writing", async () => {
		const repo = await makeRepo({ "a.ts": "old(1);\n", "b.ts": "old(2);\n" });
		const result = await run(
			repo,
			`const matches = sg.find("old($A)");
const a = matches.find(m => m.file.endsWith("a.ts"));
const b = matches.find(m => m.file.endsWith("b.ts"));
for (const edit of [
  () => sg.rewrite({...a}, "next(1)"),
  () => { let n = 0; sg.rewrite([a, a], () => "next(" + ++n + ")"); },
  () => sg.rewrite(a, "next(1)", "a.ts"),
]) { try { edit(); } catch (e) { console.log(e.message); } }
await Bun.write("b.ts", "changed();\\n");
try { sg.rewrite([a, b], "next($A)"); } catch(e) { console.log(e.message); }`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Expected a file-backed match");
		expect(result.output).toContain("overlapping edits");
		expect(result.output).toContain("omit the file scope");
		expect(result.output).toContain("Stale match");
		expect(result.output).toContain(
			"For independent edits from one selection, rerun with sg.rewrite(matches, callback)",
		);
		expect(result.output).toContain("Otherwise, select again after editing");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("old(1);\n");
		expect(await Bun.file(path.join(repo, "b.ts")).text()).toBe("changed();\n");
	});

	test("sg.rewrite does not overwrite writes performed by its callback", async () => {
		const repo = await makeRepo({ "a.ts": "old(1);\n" });
		const result = await run(
			repo,
			`const { writeFileSync } = await import("node:fs");
try { sg.rewrite(sg.one("old($A)", "a.ts"), m => {
  writeFileSync("a.ts", "changed();\\n"); return "next(1)";
}); } catch(e) { console.log(e.message); }`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Stale match");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("changed();\n");
	});

	test("discarded native edits warn without changing native replace behavior", async () => {
		const repo = await makeRepo({ "a.ts": "class Writer { format(options = {}) { return 1; } }\n" });
		const result = await run(
			repo,
			`const method = sg.one({rule: {kind: "method_definition"}}, "a.ts");
const body = method.node.field("body");
body.replace("{ return 2; }");`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.applied).toEqual([]);
		expect(result.warnings.join("\n")).toContain("line 3: node.replace() returns an edit");
		const fixed = await run(
			repo,
			`const method = sg.one({rule: {kind: "method_definition"}}, "a.ts");
sg.rewrite(method, m => m.node.field("body").replace("{ return 2; }"));`,
		);
		expect(fixed.exitCode).toBe(0);
		expect(fixed.warnings).toEqual([]);
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toContain("return 2;");
	});

	test("sg.rewrite edits captures without losing comments or Unicode", async () => {
		const source = 'const label = "é😀";\nstore.save("a", /* retain */ true);\nstore.save("b", flag);\n';
		const repo = await makeRepo({ "a.ts": source });
		const result = await run(
			repo,
			`console.log(sg.rewrite("store.save($KEY, $VALUE)", m => {
			const value = m.node.getMatch("VALUE");
			return ["true", "false"].includes(value.kind()) ? value.replace("{ durable: " + value.text() + " }") : null;
		}));`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("1");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe(
			source.replace("/* retain */ true", "/* retain */ { durable: true }"),
		);
	});

	test("sg.rewrite replaces a body field despite braces in defaults and comments", async () => {
		const source = 'class Writer { format(options = {}) { /* } */ return "{"; } }\n';
		const repo = await makeRepo({ "a.ts": source });
		const result = await run(
			repo,
			`sg.rewrite({ rule: { kind: "method_definition" } }, m =>
			m.node.field("body").replace("{ return render(options); }"));`,
		);
		expect(result.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe(
			"class Writer { format(options = {}) { return render(options); } }\n",
		);
	});

	test("sg.rewrite counts matches rather than edits and accepts readonly edit arrays", async () => {
		const repo = await makeRepo({ "a.ts": "pair(1, /* keep */ 2); pair(3, 4);\n" });
		const result = await run(
			repo,
			`console.log(sg.rewrite("pair($A, $B)", m => [
			m.node.getMatch("A").replace("10"), m.node.getMatch("B").replace("20")
		] as const));`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("2");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("pair(10, /* keep */ 20); pair(10, 20);\n");
	});

	test("sg.rewrite deliberate skips do not report missing matches", async () => {
		const repo = await makeRepo({ "a.ts": "foo(1);\n" });
		const result = await run(
			repo,
			`for (const skip of [null, undefined, false, []]) {
			console.log(sg.rewrite("foo($A)", () => skip));
		}`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("0\n0\n0\n0");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("foo(1);\n");
	});

	test("sg.rewrite rejects unsupported results with actionable diagnostics", async () => {
		const repo = await makeRepo({ "a.ts": "foo(1);\n" });
		const result = await run(
			repo,
			`for (const value of [true, 42, {}, [null], ["text"], Array(1), Promise.resolve("x")]) {
			try { sg.rewrite("foo($A)", () => value); } catch (e) { console.log(e.message); }
		}`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.match(/sg.rewrite at "a.ts":1/g)).toHaveLength(7);
		expect(result.output).toContain("callbacks are synchronous");
		expect(result.output).toContain("Return text, a node.replace(...) edit");
		expect(result.output).not.toContain("matched nothing");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("foo(1);\n");
	});

	test("sg.rewrite validates ranges and conflicts before writing a file", async () => {
		const repo = await makeRepo({ "a.ts": "foo(1); foo(2);\n" });
		const result = await run(
			repo,
			`const invalid = [
			m => ({ startPos: -1, endPos: 1, insertedText: "x" }),
			m => ({ startPos: 0, endPos: 100, insertedText: "x" }),
			m => ({ startPos: 5, endPos: 4, insertedText: "x" }),
			m => ({ startPos: 0.5, endPos: 1, insertedText: "x" }),
			m => [m.node.replace("x"), m.node.getMatch("A").replace("3")],
			m => [{startPos: 0, endPos: 0, insertedText: "a"}, {startPos: 0, endPos: 0, insertedText: "b"}],
		];
		for (const callback of invalid) {
			try { sg.rewrite("foo($A)", callback); } catch (e) { console.log(e.message); }
		}
		try { sg.rewrite("foo($A)", m => m.A === "1" ? m.node.replace("ok()") : 42); }
		catch (e) { console.log(e.message); }`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("outside match");
		expect(result.output).toContain("Unsupported callback result");
		expect(result.output).toContain('overlapping edits in "a.ts" at line 1; return one edit for each place');
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("foo(1); foo(2);\n");
	});

	test("sg.rewrite fills an empty $$$ with nothing, not the literal text", async () => {
		const repo = await makeRepo({ "src/x.ts": "foo();\nfoo(1, 2);\n" });
		await run(repo, `sg.rewrite("foo($$$ARGS)", "bar($$$ARGS)", "src");`);

		expect(await Bun.file(path.join(repo, "src/x.ts")).text()).toBe("bar();\nbar(1, 2);\n");
	});

	test("sg.rewrite applies an edit once when two matches reach the same place", async () => {
		const repo = await makeRepo({ "src/a.ts": "foo(1);\nfoo(2);\n" });
		const result = await run(
			repo,
			`const twice = [...sg.find("foo($A)", "src/a.ts"), ...sg.find("foo($A)", "src/a.ts")];
console.log(sg.rewrite(twice, (m) => m.node.replace(\`bar(\${m.A})\`)));`,
		);

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("bar(1);\nbar(2);\n");
	});

	test("sg.rewrite inserts once when two matches insert the same text at the same place", async () => {
		const repo = await makeRepo({ "src/a.ts": "foo(1);\n" });
		const result = await run(
			repo,
			`const twice = [...sg.find("foo($A)", "src/a.ts"), ...sg.find("foo($A)", "src/a.ts")];
sg.rewrite(twice, (m) => ({ startPos: m.node.range().start.index, endPos: m.node.range().start.index, insertedText: "void " }));`,
		);

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("void foo(1);\n");
	});

	test("sg.rewrite rewrites the outer of two nested matches and says it left the inner one", async () => {
		const repo = await makeRepo({ "src/a.ts": "foo(foo(1));\np.then(a).then(b);\n" });
		const result = await run(
			repo,
			`sg.rewrite("foo($A)", "bar($A)", "src/a.ts");
sg.rewrite("$P.then($F)", "$P.andThen($F)", "src/a.ts");`,
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("sg.rewrite left 1 match inside another match unchanged, e.g. src/a.ts:1 foo(1)");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("bar(foo(1));\np.then(a).andThen(b);\n");
	});

	test("sg.rewrite applies nested matches whose edits don't clash", async () => {
		const repo = await makeRepo({ "src/a.ts": "foo(foo(1));\n" });
		const result = await run(
			repo,
			`sg.rewrite("foo($A)", (m) => m.node.field("function").replace("bar"), "src/a.ts");`,
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).not.toContain("inside another match");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("bar(bar(1));\n");
	});

	test("sg.rewrite refuses a template metavariable the pattern doesn't capture", async () => {
		const repo = await makeRepo({ "src/a.ts": "foo(1);\n" });
		for (const program of [
			`sg.rewrite("foo($A)", "bar($B)", "src/a.ts");`,
			`sg.rewrite(sg.find("foo($A)", "src/a.ts"), "bar($$$B)");`,
		]) {
			const result = await run(repo, program);
			expect(result.exitCode).toBe(1);
			expect(result.output).toMatch(
				/the replacement uses \$(\$\$)?B, which the pattern doesn't capture \(it captures \$A\)/,
			);
		}
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("foo(1);\n");
	});

	test("files that aren't UTF-8 are skipped by searches and refused by edits, not corrupted", async () => {
		const repo = await makeRepo({ "ok.js": "foo(2);\n" });
		await Bun.write(
			path.join(repo, "legacy.js"),
			new Uint8Array([...Buffer.from("// caf"), 0xe9, ...Buffer.from("\nfoo(1);\n")]),
		);
		await Bun.write(
			path.join(repo, "app.properties"),
			new Uint8Array([...Buffer.from("name=Jos"), 0xe9, ...Buffer.from("\nport=1\n")]),
		);
		await $`git add -A && git -c user.name=test -c user.email=test@test commit -qm latin1`.cwd(repo);
		const before = await Bun.file(path.join(repo, "legacy.js")).bytes();

		const rewritten = await run(repo, `sg.rewrite("foo($A)", "bar($A)");`);
		expect(rewritten.exitCode).toBe(0);
		expect(rewritten.output).toContain("skipped legacy.js: it isn't valid UTF-8");
		expect(await Bun.file(path.join(repo, "legacy.js")).bytes()).toEqual(before);
		expect(await Bun.file(path.join(repo, "ok.js")).text()).toBe("bar(2);\n");

		const edited = await run(repo, `edit({ path: "app.properties", oldText: "port=1", newText: "port=2" });`);
		expect(edited.exitCode).toBe(1);
		expect(edited.output).toContain("isn't valid UTF-8, and editing it here would corrupt it");
	});

	test("a file reached through a symlink is rewritten once", async () => {
		const repo = await makeRepo({ "src/real.ts": "inc(x);\n" });
		await symlink("src/real.ts", path.join(repo, "alias.ts"));
		await $`git add -A && git -c user.name=test -c user.email=test@test commit -qm link`.cwd(repo);
		const result = await run(repo, `console.log(sg.rewrite("inc($A)", "inc($A + 1)"));`);
		expect(result.output.trim()).toBe("1");
		expect(await Bun.file(path.join(repo, "src/real.ts")).text()).toBe("inc(x + 1);\n");
	});

	test("a later rewrite still reaches original code an earlier template carried over, but not text it wrote", async () => {
		const repo = await makeRepo({
			"a.js": "function load(u) {\n  return fetchSync(u);\n}\nrequest(u, undefined, t);\n",
		});
		const result = await run(
			repo,
			`sg.rewrite("function $F($$$P) { $$$B }", "async function $F($$$P) { $$$B }", "a.js");
sg.rewrite("fetchSync($U)", "await fetch($U)", "a.js");
sg.rewrite("request($A, undefined, $T)", "request($A, { timeoutMs: $T })", "a.js");
sg.rewrite("request($A, $B)", "request($A, $B, {})", "a.js");`,
		);
		expect(result.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "a.js")).text()).toBe(
			"async function load(u) { return await fetch(u); }\nrequest(u, { timeoutMs: t });\n",
		);
	});

	test("sg.rewrite refuses a bare $$$ in its template", async () => {
		const repo = await makeRepo({ "a.ts": 'console.log("a", 1);\n' });
		const result = await run(repo, `sg.rewrite("console.log($$$)", "logger.info($$$)", "a.ts");`);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("the replacement uses $$$, which captures nothing");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe('console.log("a", 1);\n');
	});

	test("a TypeScript-only pattern works across a scope that also holds HTML and JavaScript", async () => {
		const repo = await makeRepo({
			"a.ts": "const x = useState<number>(0);\n",
			"index.html": "<p>hi</p>\n",
			"eslint.config.js": "export default [];\n",
		});
		const result = await run(repo, `sg.rewrite("useState<$T>($A)", "useSignal<$T>($A)");`);
		expect(result.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("const x = useSignal<number>(0);\n");
		const invalid = await run(repo, `sg.find("a; b");`);
		expect(invalid.exitCode).toBe(1);
		expect(invalid.output).toContain("Patterns must parse as one syntax node");
	});

	test("a later rewrite reaches code a callback carried over from its match", async () => {
		const repo = await makeRepo({
			"a.ts": 'import { oldName } from "./x";\nlog(oldName(1));\n',
			"x.ts": "export function oldName(n: number) { return n; }\n",
		});
		const result = await run(
			repo,
			`sg.rewrite("log($A)", (m) => \`console.info(\${m.vars.A})\`, "a.ts");
sg.rewrite("oldName", "newName", ["a.ts", "x.ts"]);`,
		);
		expect(result.exitCode).toBe(0);
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe(
			'import { newName } from "./x";\nconsole.info(newName(1));\n',
		);
	});

	test("a run started in a subdirectory keeps its working directory after reading files", async () => {
		const repo = await makeRepo({ "pkg/src/a.ts": "foo(1);\n", "pkg/package.json": "{}\n" });
		const result = await run(
			repo,
			`console.log(sg.find("foo($A)", "src").length);
console.log(JSON.stringify(glob("src/*.ts")), JSON.stringify(grep("foo", "src")));
await $\`cat src/a.ts\`;
console.log((await $\`git status --short\`.text()).trim() === "", process.cwd().endsWith("/pkg"));`,
			{ cwd: path.join(repo, "pkg") },
		);
		expect(result.exitCode, result.output).toBe(0);
		// glob gives paths as Git lists them, from the root; grep names files from the working directory.
		expect(result.output).toContain('1\n["pkg/src/a.ts"] [{"file":"src/a.ts","line":1,"text":"foo(1);"}]');
		expect(result.output).toContain("true true");
	});

	test.skipIf(process.platform !== "darwin")(
		"on macOS, renaming a directory from before the run is refused, not applied without its files",
		async () => {
			const repo = await makeRepo({ "src/utils/a.ts": "a\n", "src/utils/b.ts": "b\n" });
			const runner = startRunner(repo, 'import { renameSync } from "node:fs"; renameSync("src/utils", "src/helpers");');
			const { stderr } = await runnerOutcome(runner);
			expect(stderr).toContain('Not applied: renaming the directory "src/utils" isn\'t supported on macOS');
			expect(await Bun.file(path.join(repo, "src/utils/a.ts")).text()).toBe("a\n");
			expect(await Bun.file(path.join(repo, "src/helpers/a.ts")).exists()).toBe(false);
		},
	);

	test("a later rewrite reaches a match a callback copied whole, $$$_ names are refused, and grep takes non-ASCII", async () => {
		const repo = await makeRepo({ "a.ts": "function load() { return loadUser(1); }\nbaz(3, 4, 5);\n// Café\n" });
		const rewritten = await run(
			repo,
			`sg.rewrite({ rule: { kind: "function_declaration", has: { pattern: "loadUser($$$A)", stopBy: "end" } } }, (m) => "async " + m.text, "a.ts");
sg.rewrite("loadUser($ID)", "await loadUser($ID)", "a.ts");
console.log(grep(/Café/).length);`,
		);
		expect(rewritten.exitCode, rewritten.output).toBe(0);
		expect(rewritten.output.trim()).toBe("1");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toStartWith(
			"async function load() { return await loadUser(1); }\n",
		);
		const refused = await run(repo, `sg.rewrite("baz($A, $$$_REST)", "qux($A, $$$_REST)", "a.ts");`);
		expect(refused.exitCode).toBe(1);
		expect(refused.output).toContain("the replacement uses $$$_REST, which captures nothing");
	});

	test("sg.rewrite refuses output that breaks the file's syntax", async () => {
		const repo = await makeRepo({ "src/a.ts": "foo(1);\n" });
		const result = await run(repo, `sg.rewrite("foo($A)", "bar($A", "src/a.ts");`);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('sg.rewrite would leave invalid syntax in "src/a.ts" at line 1: bar(1;');
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toBe("foo(1);\n");
	});

	test("sg accepts a list of directories, and null to leave a match alone", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`console.log(sg.rewrite("oldApi($A)", (m) => (m.vars.A === "1" ? null : \`newApi(\${m.vars.A})\`), ["."]));`,
		);

		expect(result.output.trim()).toBe("1");
		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toContain("oldApi(1)");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toContain("newApi(2)");
	});

	test("sg has ast-grep's own API, and programs can import @ast-grep/napi", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`import { parse, Lang } from "@ast-grep/napi";
			const source = await Bun.file("src/a.ts").text();
			console.log(sg.parse(sg.Lang.TypeScript, source).root().findAll("oldApi($A)").length);
			console.log(parse(Lang.TypeScript, source).root().findAll("oldApi($A)").length);`,
		);

		expect(result.output.trim()).toBe("1\n1");
	});

	test("a replacement function can read captures from the match itself, and return false to skip", async () => {
		const repo = await makeRepo(FILES);
		await run(repo, `sg.rewrite("oldApi($A)", (m) => m.A === "1" && \`newApi(\${m.A})\`, "src");`);

		expect(await Bun.file(path.join(repo, "src/a.ts")).text()).toContain("newApi(1)");
		expect(await Bun.file(path.join(repo, "src/b.ts")).text()).toContain("oldApi(2)");
	});

	test("glob takes the directory as a string or as { cwd }", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `console.log(JSON.stringify([glob("a.ts", "src"), glob("a.ts", { cwd: "src" })]));`);

		expect(result.exitCode, result.output).toBe(0);
		expect(JSON.parse(result.output)).toEqual([["src/a.ts"], ["src/a.ts"]]);
	});

	test("glob and sg normalize scopes and exclude explicitly named ignored files", async () => {
		const repo = await makeRepo({
			".gitignore": "src/ignored.ts\n",
			"src/a.ts": "oldApi(1);\n",
			"src/a.html": "<p>hello</p>\n",
			"src/ignored.ts": "oldApi(2);\n",
		});
		const result = await run(
			repo,
			`const absolute = process.cwd() + "/src";
			console.log(JSON.stringify([
				glob("*.ts", "./src"),
				glob("*.ts", absolute),
				sg.find("<p>$A</p>", "./src").map((match) => match.file),
				sg.find("<p>$A</p>", absolute).map((match) => match.file),
				sg.find("oldApi($A)", "src/a.ts").map((match) => match.file),
				sg.find("oldApi($A)", "src/ignored.ts").length,
			]));`,
		);

		expect(JSON.parse(result.output.trim().split("\n").at(-1)!)).toEqual([
			["src/a.ts"],
			["src/a.ts"],
			["src/a.html"],
			["src/a.html"],
			["src/a.ts"],
			0,
		]);
	});

	test("a single named file is selected as Git sees it", async () => {
		const repo = await makeRepo({
			".gitignore": "src/ignored.ts\n",
			"src/tracked.ts": "oldApi(1);\n",
			"src/deleted.ts": "oldApi(2);\n",
			"src/ignored.ts": "oldApi(3);\n",
		});
		const result = await run(
			repo,
			`await Bun.file("src/deleted.ts").delete();
const files = ["src/tracked.ts", "src/deleted.ts", "src/ignored.ts"];
console.log(JSON.stringify(files.map((file) => sg.find("oldApi($A)", file).length)));`,
		);

		expect(JSON.parse(result.output.trim().split("\n").at(-1)!)).toEqual([1, 0, 0]);
	});

	test("a list of scopes selects the same files as each scope on its own", async () => {
		const repo = await makeRepo({
			".gitignore": "src/ignored.ts\n",
			"src/a/one.ts": "oldApi(1);\n",
			"src/ab.ts": "oldApi(2);\n",
			"src/deleted.ts": "oldApi(3);\n",
			"src/ignored.ts": "oldApi(4);\n",
			"lib/two.ts": "oldApi(5);\n",
			"lib/three.js": "oldApi(6);\n",
		});
		const result = await run(
			repo,
			`await Bun.file("src/deleted.ts").delete();
const scopes = ["src/a", "src/ignored.ts", "src/deleted.ts", "lib/*.js", "lib/two.ts", "missing/*.ts"];
const files = (scope) => sg.find("oldApi($A)", scope).map((match) => match.file);
console.log(JSON.stringify([files(scopes), [...new Set(scopes.flatMap(files))].toSorted()]));`,
		);

		const [together, separately] = JSON.parse(result.output.trim().split("\n").at(-1)!);
		expect(together.toSorted()).toEqual(separately);
		expect(separately).toEqual(["lib/three.js", "lib/two.ts", "src/a/one.ts"]);
	});

	test("sg warns when the files it's given contain no JS/TS files", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, `sg.find("oldApi($A)", ["docs"]);`);

		expect(result.output).toContain('warning: sg.find found no supported files in ["docs"]');
	});

	test("sg.rewrite names the searched scope when it matches nothing", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`
			sg.rewrite("doesNotExist($$$A)", "x", "src");
			sg.rewrite("doesNotExist($$$A)", "x");
			sg.rewrite("doesNotExist($$$A)", "x", ["src/a.ts", sg.file("src/b.ts")]);
			sg.rewrite("doesNotExist($$$A)", "x", ["src/a.ts", "src/b.ts", "src/api.ts", "src", "."]);
		`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(
			'matched nothing for "doesNotExist($$$A)" in 5 paths ("src/a.ts", "src/b.ts", "src/api.ts", …)',
		);
		expect(result.output).toContain('matched nothing for "doesNotExist($$$A)" in ["src"]');
		expect(result.output).toContain('matched nothing for "doesNotExist($$$A)" in ["."]');
		expect(result.output).toContain('matched nothing for "doesNotExist($$$A)" in ["src/a.ts","src/b.ts"]');
	});

	test("sg.rewrite allows nested matches whose returned edits are disjoint", async () => {
		const repo = await makeRepo({ "a.ts": "foo(foo(1), 2);\n" });
		const result = await run(
			repo,
			`console.log(sg.rewrite("foo($$$ARGS)", m => m.node.field("function").replace("bar")));`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("2");
		expect(await Bun.file(path.join(repo, "a.ts")).text()).toBe("bar(bar(1), 2);\n");
	});

	test("glob and grep only see files git sees", async () => {
		const repo = await makeRepo({ ...FILES, ".gitignore": "node_modules/\n", "node_modules/dep/index.ts": "oldApi\n" });
		const result = await run(
			repo,
			`console.log(JSON.stringify([glob("**/*.ts"), grep("oldApi").map((m) => m.file)]));`,
		);

		expect(JSON.parse(result.output)).toEqual([
			["src/a.ts", "src/api.ts", "src/b.ts"],
			["src/a.ts", "src/a.ts", "src/api.ts", "src/b.ts", "src/b.ts"],
		]);
	});

	test("glob includes a tracked dangling symlink", async () => {
		const repo = await makeRepo(FILES);
		await symlink("missing-target", path.join(repo, "src/dangling.ts"));
		await $`git add src/dangling.ts && git -c user.name=test -c user.email=test@test commit -qm symlink`.cwd(repo);

		const result = await run(repo, `console.log(JSON.stringify(glob("src/*.ts")));`);

		expect(JSON.parse(result.output)).toContain("src/dangling.ts");
	});

	test("glob and sg skip a tracked file the program has deleted", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(
			repo,
			`await Bun.file("src/b.ts").delete();\nconsole.log(JSON.stringify([glob("src/*.ts"), sg.find("oldApi($A)", "src").length]));`,
		);

		expect(JSON.parse(result.output)).toEqual([["src/a.ts", "src/api.ts"], 1]);
	});

	test("grep's regular expressions support \\d and similar", async () => {
		const repo = await makeRepo(FILES);
		const result = await run(repo, String.raw`console.log(grep(/oldApi\(\d/).length);`);

		expect(result.output.trim()).toBe("2");
	});

	test("the user's global gitignore still applies inside programs", async () => {
		const repo = await makeRepo(FILES);
		const config = path.join(path.dirname(repo), "config");
		await Bun.write(path.join(config, "git", "ignore"), "*.local\n");
		const program = `await Bun.write("notes.local", "x");\nconsole.log(JSON.stringify((await $\`git status --short\`.text()).trim()));`;
		const runner = Bun.spawn(["bun", RUNNER], {
			stdin: new Response(JSON.stringify({ cwd: repo, program, timeoutMs: 5000, rollback: "all" })),
			stdout: "pipe",
			env: { ...process.env, XDG_CONFIG_HOME: config },
		});
		const result: RunResult = JSON.parse(await new Response(runner.stdout).text());

		expect(result.output.trim()).toBe('""');
	});
});

test("outside a git repository, the runner names the directory it checked, without a stack trace", async () => {
	const repo = await makeRepo({ "a.txt": "a\n" });
	const outside = path.join(path.dirname(repo), "outside");
	await mkdir(outside);
	const { stderr, exitCode } = await runnerOutcome(startRunner(outside, "1"));
	expect(exitCode).toBe(1);
	// Then the timing detail every runner failure has, but no stack trace or source excerpt.
	expect(stderr.split("\n")[0]).toBe(
		`shorthand only works inside a git repository, and ${outside} isn't in one. Edit files outside a repository directly.`,
	);
	expect(stderr).not.toContain("findRepository");
});

describe.skipIf(!hasOverlay)("writes outside the repository", () => {
	test("say which file was outside it, for Bun's file API and its shell", async () => {
		const repo = await makeRepo({ "a.txt": "a\n" });
		const outside = path.join(path.dirname(repo), "outside");
		await mkdir(outside);
		const relative = `${repo}/../outside/c.txt`;
		for (const [program, file] of [
			[`await Bun.write(${JSON.stringify(path.join(outside, "a.txt"))}, "x");`, path.join(outside, "a.txt")],
			[`await $\`echo x > ${path.join(outside, "b.txt")}\`;`, path.join(outside, "b.txt")],
			[`await Bun.write(${JSON.stringify(relative)}, "x");`, relative],
		]) {
			const result = await run(repo, program!);
			expect(result.exitCode).toBe(1);
			expect(result.warnings).toContain(
				`${file} is outside the repository, ${repo}. Programs can only change files inside it; edit files outside it directly.`,
			);
		}
	});

	test("say nothing for a failed run whose refused write was inside it", async () => {
		const repo = await makeRepo({ "a.txt": "a\n" });
		// macOS refuses writes to .git and Linux lets them land in the overlay and ignores them, so the
		// program fails either way: the hint must not count a path inside the repository.
		const hook = JSON.stringify(path.join(repo, ".git/hooks/x"));
		const result = await run(
			repo,
			`try { await Bun.write(${hook}, "x"); } catch (error) { console.log(error.message); }\nthrow new Error("stop");`,
		);
		expect(result.exitCode).toBe(1);
		expect(result.warnings.some((warning) => warning.includes("outside the repository"))).toBe(false);
	});
});
