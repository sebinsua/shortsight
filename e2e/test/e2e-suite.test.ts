import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { $ } from "bun";
import { allTasks, applySolution, materializeTask, taskById } from "../tasks.ts";
import { saveChanges } from "../artifacts.ts";
import { conditionTools, extensionEntry } from "../conditions.ts";
import { sessionReport } from "../report.ts";

const temporary: string[] = [];
async function directory() {
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-suite-test-"));
	temporary.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("copied fixtures provide the same local TypeScript compiler without downloads", async () => {
	const root = await directory();
	const fixture = path.join(root, "fixture");
	const copy = path.join(root, "copy");
	await materializeTask(taskById("empty-average"), fixture);
	await $`cp -R ${fixture} ${copy}`.quiet();
	const expected = (await $`${path.resolve("node_modules/.bin/tsc")} --version`.text()).trim();
	const version = await $`npx --no-install tsc --version`.cwd(copy).text();
	expect(version.trim()).toBe(expected);
	expect((await $`npm run --silent check`.cwd(copy).nothrow().quiet()).exitCode).toBe(0);
	expect(await $`git ls-files node_modules`.cwd(copy).text()).toBe("");
});

for (const task of allTasks)
	test(`${task.id} starts formatted by its own formatter`, async () => {
		const root = await directory();
		await materializeTask(task, root);
		const check = await $`node_modules/.bin/oxfmt --check .`.cwd(root).nothrow().quiet();
		expect({ exit: check.exitCode, output: check.stdout.toString() }).toMatchObject({ exit: 0 });
	});

for (const task of allTasks)
	test(`evaluator rejects initial ${task.id} and accepts its reference solution`, async () => {
		const root = await directory();
		await materializeTask(task, root);
		await expect(task.verify(root)).rejects.toThrow();
		await applySolution(task, root);
		// A fresh subprocess avoids module caching between the negative and positive checks.
		const child = Bun.spawn(["bun", path.resolve("e2e/tasks.ts"), task.id, root], { stdout: "pipe", stderr: "pipe" });
		const [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(stdout).toContain("checks passed");
	});

for (const task of allTasks)
	test(`${task.id} accepts its reference solution after the fixture's formatter runs`, async () => {
		const root = await directory();
		await materializeTask(task, root);
		await applySolution(task, root);
		const changed = Object.entries(task.solution).flatMap(([file, content]) =>
			content !== null && /\.[jt]sx?$/.test(file) ? [file] : [],
		);
		if (changed.length) {
			const formatted = await $`node_modules/.bin/oxfmt ${changed}`.cwd(root).nothrow().quiet();
			expect(formatted.exitCode).toBe(0);
		}
		const child = Bun.spawn(["bun", path.resolve("e2e/tasks.ts"), task.id, root], { stdout: "pipe", stderr: "pipe" });
		const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	});

const evaluatorCases = [
	{
		name: "inferred average return type",
		id: "empty-average",
		passes: true,
		change: (text: string) => text.replace(": number | undefined {", " {"),
	},
	{
		name: "aliased average return type",
		id: "empty-average",
		passes: true,
		change: (text: string) =>
			"type AverageResult = number | undefined;\n" + text.replace(": number | undefined {", ": AverageResult {"),
	},
	{
		name: "any return type despite a matching comment",
		id: "empty-average",
		passes: false,
		change: (text: string) => "// number | undefined\n" + text.replace(": number | undefined {", ": any {"),
	},
	{
		name: "quote extraction with .js imports",
		id: "extract-quote",
		passes: true,
		change: (text: string) => text.replaceAll('"./quote"', '"./quote.js"'),
	},
	{
		name: "validation extraction with .js imports",
		id: "shared-validation",
		passes: true,
		change: (text: string) => text.replaceAll('"./validation"', '"./validation.js"'),
	},
	{
		name: "workers continuing after another worker fails",
		id: "concurrency-map",
		passes: false,
		change: (text: string) => text.replace("!failed && ", ""),
	},
	{
		name: "rejection after all active workers settle",
		id: "concurrency-map",
		passes: true,
		change: (text: string) =>
			text.replace(
				"await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));",
				"const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));\n  for (const entry of settled) if (entry.status === 'rejected') throw entry.reason;",
			),
	},
];

for (const example of evaluatorCases)
	test(`evaluator ${example.passes ? "accepts" : "rejects"} ${example.name}`, async () => {
		const root = await directory();
		const task = taskById(example.id);
		await materializeTask(task, root);
		for (const [file, content] of Object.entries(task.solution))
			await writeFile(path.join(root, file), example.change(content!));
		const child = Bun.spawn(["bun", path.resolve("e2e/tasks.ts"), task.id, root], { stdout: "pipe", stderr: "pipe" });
		const [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (example.passes) expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		else {
			expect(exit).not.toBe(0);
			expect(stdout + stderr).toContain(
				example.id === "concurrency-map" ? "No worker may start new work" : "Public type check failed",
			);
		}
	});

test("artifacts preserve the dirty starting tree, additions, binary files and deletions", async () => {
	const root = await directory();
	const before = path.join(root, "before");
	const after = path.join(root, "after");
	await materializeTask(allTasks[0]!, before);
	await writeFile(path.join(before, "average.ts"), "dirty starting content\n");
	await writeFile(path.join(before, "old.txt"), "untracked starting content\n");
	await $`cp -R ${before} ${after}`.quiet();
	await writeFile(path.join(after, "average.ts"), "final content\n");
	await rm(path.join(after, "old.txt"));
	await writeFile(path.join(after, "new.bin"), Buffer.from([0, 255, 1]));
	const result = await saveChanges(before, after, path.join(root, "artifacts"));
	const changes = JSON.parse(await readFile(result.manifest, "utf8"));
	expect(result.changedFiles).toBe(3);
	expect(Buffer.from(changes.find((item: any) => item.path === "average.ts").before.content, "base64").toString()).toBe(
		"dirty starting content\n",
	);
	expect(changes.find((item: any) => item.path === "old.txt").after).toBeNull();
	expect(await readFile(result.patch, "utf8")).toContain("GIT binary patch");
});

for (const [id, restoredFiles] of [
	["status-options", ["routes.ts"]],
	["shared-validation", ["accounts.ts"]],
	["extract-quote", ["checkout.ts"]],
	["request-cancellation", ["dashboard.ts"]],
] as const)
	test(`evaluator rejects an incomplete ${id} even when the new module exists`, async () => {
		const task = taskById(id);
		const root = await directory();
		await materializeTask(task, root);
		await applySolution(task, root);
		for (const file of restoredFiles) await writeFile(path.join(root, file), task.files[file]!);
		const child = Bun.spawn(["bun", path.resolve("e2e/tasks.ts"), id, root], { stdout: "pipe", stderr: "pipe" });
		const [exit] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exit).not.toBe(0);
	});

test("minimal documentation wrapper changes registration without changing execution", async () => {
	const root = await directory();
	await writeFile(
		path.join(root, "index.ts"),
		'export default pi => pi.registerTool({ name: "code", description: "batch everything", promptGuidelines: ["batch"], execute: () => 42 });',
	);
	const entry = await extensionEntry(root, "minimal", path.join(root, "wrapper.ts"));
	let tool: any;
	(await import(entry)).default({
		registerTool(value: unknown) {
			tool = value;
		},
	});
	expect(tool.description).toContain("glob(pattern");
	expect(tool.description).not.toContain("batch everything");
	expect(tool.promptGuidelines).toEqual([]);
	expect(tool.execute()).toBe(42);
	expect(conditionTools("replace")).toEqual(["read", "bash", "code"]);
});

test("codemode conditions add the codemode tool and expose code to it as each variant", async () => {
	expect(conditionTools("code", "on")).toEqual(["read", "bash", "edit", "write", "code", "codemode"]);
	expect(conditionTools("baseline", "only")).toEqual(["read", "bash", "edit", "write", "codemode"]);
	expect(conditionTools("code")).toEqual(["read", "bash", "edit", "write", "code"]);
	const root = await directory();
	const shipped = path.join(root, "index.ts");
	await writeFile(
		shipped,
		'export default pi => pi.registerTool({ name: "code", description: "shipped", outputSchema: { type: "object" }, execute: () => 42 });',
	);
	// `direct` is how code ships, and without codemode exposure doesn't apply, so both load the extension as it is.
	expect(await extensionEntry(root, "shipped", path.join(root, "direct.ts"), "on", "on", "direct")).toBe(shipped);
	expect(await extensionEntry(root, "shipped", path.join(root, "off.ts"), "on", "off", "model-only")).toBe(shipped);
	const entry = await extensionEntry(root, "shipped", path.join(root, "model-only.ts"), "on", "only", "model-only");
	let tool: any;
	(await import(entry)).default({
		registerTool(value: unknown) {
			tool = value;
		},
	});
	expect(tool.exposure).toBe("model-only");
	expect(tool.description).toBe("shipped");
	expect(tool.outputSchema).toEqual({ type: "object" });
	expect(tool.execute()).toBe(42);
});

test("sightread off hides graph.query from shipped and minimal code registration", async () => {
	const root = await directory();
	await writeFile(
		path.join(root, "index.ts"),
		'export default async (pi, findGraph) => pi.registerTool({ name: "code", description: (await findGraph()) ? "graph.query available" : "code only" });',
	);
	for (const documentation of ["shipped", "minimal"] as const) {
		const entry = await extensionEntry(root, documentation, path.join(root, `${documentation}-off.ts`), "off");
		const wrapper = await readFile(entry, "utf8");
		expect(wrapper).toContain("extension(proxy, async () => undefined)");
		const probe = `const extension = (await import(${JSON.stringify(pathToFileURL(entry).href)})).default; await extension({ registerTool(tool) { console.log(tool.description); } });`;
		const child = Bun.spawn(["bun", "-e", probe], { stdout: "pipe", stderr: "pipe" });
		const [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(stdout).not.toContain("graph.query");
	}
});

test("session report distinguishes observations from inferred failure causes", () => {
	const report = sessionReport([
		{ type: "tool_execution_start", toolName: "bash", args: { command: "echo '```'" } },
		{
			type: "tool_execution_end",
			toolName: "code",
			isError: true,
			result: { details: { exitCode: 1, changes: [] }, content: [{ type: "text", text: "test failed" }] },
		},
	]);
	expect(report).toContain("Review shell command for writes");
	expect(report).toContain("review whether interface, application/check, or infrastructure");
	expect(report).toContain("````");
});

async function fakeEnvironment(root: string) {
	const bin = path.join(root, "bin");
	const auth = path.join(root, "auth");
	await mkdir(bin);
	await mkdir(auth);
	await writeFile(
		path.join(bin, "pi"),
		`#!/usr/bin/env bun
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const settings = process.env.PI_CODING_AGENT_DIR + "/settings.json";
const entries = args.flatMap((arg, index) => (args[index - 1] === "-e" && existsSync(arg) ? [readFileSync(arg, "utf8")] : []));
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ args, ambientSettings: existsSync(settings), settings: existsSync(settings) ? readFileSync(settings, "utf8") : null, entries }) + "\\n");
writeFileSync("added.txt", "saved output\\n");
console.log(JSON.stringify({type:"turn_start"}));
console.log(JSON.stringify({type:"tool_execution_start", toolName:"bash", toolCallId:"1", args:{command:"write added.txt"}}));
console.log(JSON.stringify({type:"tool_execution_end", toolName:"bash", toolCallId:"1", isError:false,result:{content:[{type:"text",text:"done"}]}}));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Done"}],usage:{input:1,output:1,totalTokens:2,cost:{total:0.2}}}}));
`,
	);
	await chmod(path.join(bin, "pi"), 0o755);
	await writeFile(path.join(auth, "settings.json"), '{"systemPrompt":"ambient coaching"}');
	return {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		PI_CODING_AGENT_DIR: auth,
		FAKE_CALLS: path.join(root, "calls.jsonl"),
	};
}

test("a token Pi refreshes in an attempt's copy reaches the next attempt", async () => {
	const root = await directory();
	const fixture = path.join(root, "fixture");
	await materializeTask(allTasks[0]!, fixture);
	const env = await fakeEnvironment(root);
	await writeFile(path.join(env.PI_CODING_AGENT_DIR, "auth.json"), '{"refresh":"1"}');
	// Each attempt records the token it was given, then spends it, as an OAuth refresh does.
	await writeFile(
		path.join(root, "bin/pi"),
		`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.PI_CODING_AGENT_DIR + "/auth.json";
const token = JSON.parse(readFileSync(file, "utf8")).refresh;
appendFileSync(process.env.FAKE_CALLS, token + "\\n");
writeFileSync(file, JSON.stringify({ refresh: String(Number(token) + 1) }));
`,
	);
	await chmod(path.join(root, "bin/pi"), 0o755);
	const child = Bun.spawn(
		[
			"bun",
			path.resolve("e2e/run.ts"),
			"--repo",
			fixture,
			"--task",
			"Example",
			"--setup",
			"baseline",
			"--runs",
			"2",
		].concat(["--check", "true", "--results-dir", path.join(root, "results")]),
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const [exit] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exit).toBe(0);
	expect(await readFile(env.FAKE_CALLS, "utf8")).toBe("1\n2\n");
	expect(JSON.parse(await readFile(path.join(env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"))).toEqual({ refresh: "3" });
}, 20_000);

test("sightread off keeps other executables beside sightread on PATH", async () => {
	const root = await directory();
	const fixture = path.join(root, "fixture");
	const results = path.join(root, "results");
	const sharedBin = path.join(root, "shared-bin");
	await materializeTask(allTasks[0]!, fixture);
	await mkdir(sharedBin);
	await writeFile(path.join(sharedBin, "peer-tool"), "#!/bin/sh\nprintf 'available\\n'\n");
	await writeFile(path.join(sharedBin, "sightread"), "#!/bin/sh\nprintf 'original sightread ran\\n' >&2\n");
	await Promise.all([chmod(path.join(sharedBin, "peer-tool"), 0o755), chmod(path.join(sharedBin, "sightread"), 0o755)]);
	const env = await fakeEnvironment(root);
	await writeFile(
		path.join(root, "bin/pi"),
		`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const helper = Bun.spawnSync(["sh", "-c", "peer-tool"], { env: process.env });
const sightread = Bun.spawnSync(["sh", "-c", "sightread"], { env: process.env });
writeFileSync(process.env.FAKE_PROBE, JSON.stringify({
  helper: { exit: helper.exitCode, stdout: helper.stdout.toString() },
  sightread: { exit: sightread.exitCode, stderr: sightread.stderr.toString() },
}));
`,
	);
	await chmod(path.join(root, "bin/pi"), 0o755);
	const child = Bun.spawn(
		[
			"bun",
			path.resolve("e2e/run.ts"),
			"--repo",
			fixture,
			"--task",
			"Example",
			"--setup",
			"baseline",
			"--sightread",
			"off",
			"--check",
			"true",
			"--results-dir",
			results,
		],
		{
			env: { ...env, PATH: `${env.PATH}${path.delimiter}${sharedBin}`, FAKE_PROBE: path.join(root, "probe.json") },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exit, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
		new Response(child.stdout).text(),
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	expect(JSON.parse(await readFile(path.join(root, "probe.json"), "utf8"))).toEqual({
		helper: { exit: 0, stdout: "available\n" },
		sightread: { exit: 127, stderr: "sightread: command not found\n" },
	});
}, 20_000);

test("sightread conditions set PATH and skill, record the dimension, and stop servers after passing and failing attempts", async () => {
	const root = await directory();
	const fixture = path.join(root, "fixture");
	const extension = path.join(root, "extension");
	const results = path.join(root, "results");
	await materializeTask(allTasks[0]!, fixture);
	await mkdir(path.join(extension, "packages/sightread/src"), { recursive: true });
	await mkdir(path.join(extension, "packages/sightread/skills/sightread"), { recursive: true });
	await writeFile(path.join(extension, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
	await writeFile(path.join(extension, "index.ts"), "export default () => {};\n");
	await writeFile(path.join(extension, "packages/sightread/skills/sightread/SKILL.md"), "# Sightread\n");
	const cli = path.join(extension, "packages/sightread/src/cli.ts");
	await writeFile(
		cli,
		`#!/usr/bin/env bun
import { appendFileSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
const sentinel = path.join(process.env.XDG_RUNTIME_DIR, "server");
if (process.argv.includes("stop")) { appendFileSync(process.env.FAKE_STOPS, process.env.XDG_RUNTIME_DIR + "\\n"); rmSync(sentinel, { force: true }); }
else writeFileSync(sentinel, "running");
`,
	);
	await chmod(cli, 0o755);
	await $`git init -q`.cwd(extension);
	await $`git add .`.cwd(extension);
	await $`git -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false commit -qm initial`.cwd(
		extension,
	);
	const env = await fakeEnvironment(root);
	await writeFile(
		path.join(root, "bin/pi"),
		`#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
import * as path from "node:path";
const args = process.argv.slice(2);
const bin = process.env.PATH.split(path.delimiter).find(dir => existsSync(path.join(dir, "sightread")));
const sightread = bin ? Bun.spawnSync([path.join(bin, "sightread"), "start"], { env: process.env }) : null;
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ args, bin, sightreadExit: sightread?.exitCode, sightreadError: sightread?.stderr.toString(), runtime: process.env.XDG_RUNTIME_DIR }) + "\\n");
process.exit(process.env.FAKE_FAIL === "1" ? 1 : 0);
`,
	);
	await chmod(path.join(root, "bin/pi"), 0o755);
	for (const fail of [false, true]) {
		const child = Bun.spawn(
			[
				"bun",
				path.resolve("e2e/run.ts"),
				"--repo",
				fixture,
				"--task",
				"Example",
				"--setups",
				"baseline,code",
				"--sightread",
				"off,on",
				"--extension",
				extension,
				"--check",
				"true",
				"--results-dir",
				results,
			],
			{
				env: { ...env, FAKE_STOPS: path.join(root, "stops.txt"), FAKE_FAIL: fail ? "1" : "0" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exit, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]).then(([code, error]) => [code, error]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	}
	const calls = (await readFile(env.FAKE_CALLS, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(calls.length).toBe(8);
	for (const call of calls) {
		const on = call.args.some((arg: string) => arg.includes("sightread/skills/sightread"));
		expect(Boolean(call.bin)).toBe(true);
		if (!on)
			expect({ exit: call.sightreadExit, stderr: call.sightreadError }).toEqual({
				exit: 127,
				stderr: "sightread: command not found\n",
			});
		expect(call.args.includes("--skill")).toBe(on);
		expect(call.runtime).toStartWith(realpathSync("/tmp") + "/");
		expect(await Bun.file(path.join(call.runtime, "server")).exists()).toBe(false);
	}
	const stops = (await readFile(path.join(root, "stops.txt"), "utf8")).trim().split("\n");
	expect(stops.length).toBe(2);
	const summaries = (await readFile(path.join(results, "summary.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(
		summaries
			.filter((item) => item.kind === "run")
			.map((item) => item.sightread)
			.toSorted(),
	).toEqual(["off", "off", "off", "off", "on", "on", "on", "on"]);
	expect(
		summaries
			.filter((item) => item.kind === "experiment")
			.every((item) =>
				item.conditions.every((condition: { sightread: string }) => ["on", "off"].includes(condition.sightread)),
			),
	).toBe(true);
	const extensionRuns = summaries.filter((item) => item.kind === "run" && item.setup === "code");
	for (const item of extensionRuns) {
		expect(path.basename(item.extension.path)).toBe(item.sightread === "off" ? "candidate-off" : "candidate");
		expect(item.extensionCopy).toBe(item.extension.path);
	}
}, 20_000);

test("runner compares conditions from identical fixtures and saves independent review artifacts without a model", async () => {
	const root = await directory();
	const fixture = path.join(root, "fixture");
	const results = path.join(root, "results");
	await materializeTask(allTasks[0]!, fixture);
	const env = await fakeEnvironment(root);
	const child = Bun.spawn(
		[
			"bun",
			path.resolve("e2e/run.ts"),
			"--repo",
			fixture,
			"--task",
			"Example",
			"--setups",
			"baseline,replace",
			"--runs",
			"2",
			"--check",
			"test -f added.txt",
			"--results-dir",
			results,
		],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const [exit, , stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	const summaries = (await readFile(path.join(results, "summary.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const runs = summaries.filter((item) => item.kind === "run");
	expect(runs.map((run) => run.setup)).toEqual(["baseline", "replace", "replace", "baseline"]);
	expect(new Set(runs.map((run) => run.startingFixture.fingerprint)).size).toBe(1);
	for (const run of runs) {
		expect(run.verified).toBe(true);
		expect(await Bun.file(run.report).text()).toContain("write added.txt");
		expect(await Bun.file(run.artifacts.patch).text()).toContain("saved output");
	}
	const calls = (await readFile(env.FAKE_CALLS, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	for (const call of calls) {
		expect(call.ambientSettings).toBe(false);
		expect(call.args).toContain("--no-skills");
		expect(call.args).toContain("--no-context-files");
	}
}, 20_000);

test("codemode conditions load Pi's codemode, set its mode, and keep earlier condition ids", async () => {
	const root = await directory();
	const fixture = path.join(root, "fixture");
	const results = path.join(root, "results");
	await materializeTask(allTasks[0]!, fixture);
	const env = await fakeEnvironment(root);
	const child = Bun.spawn(
		[
			"bun",
			path.resolve("e2e/run.ts"),
			"--repo",
			fixture,
			"--task",
			"Example",
			"--setups",
			"baseline,code",
			"--sightread",
			"on",
			"--codemode",
			"off,only",
			"--code-exposure",
			"direct,model-only",
			"--check",
			"true",
			"--results-dir",
			results,
		],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const [exit, , stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	const runs = (await readFile(path.join(results, "summary.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((item) => item.kind === "run");
	expect(runs.map((run) => run.condition).toSorted()).toEqual([
		"baseline-sightread-on",
		"baseline-sightread-on-codemode-only",
		"code-candidate-shipped-none-sightread-on",
		"code-candidate-shipped-none-sightread-on-codemode-only-direct",
		"code-candidate-shipped-none-sightread-on-codemode-only-model-only",
	]);
	const calls = (await readFile(env.FAKE_CALLS, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	for (const [index, run] of runs.entries()) {
		const { args, settings, entries } = calls[index];
		const tools = args[args.indexOf("--tools") + 1].split(",");
		expect(run.codemode).toBe(run.condition.includes("codemode") ? "only" : "off");
		if (run.codemode === "off") {
			expect(args).not.toContain("builtin:codemode");
			expect(tools).not.toContain("codemode");
			expect(settings).toBeNull();
			expect(run.codeExposure).toBeNull();
			continue;
		}
		expect(args).toContain("builtin:codemode");
		expect(tools).toContain("codemode");
		expect(JSON.parse(settings)).toEqual({ codemode: { mode: "only" } });
		if (run.setup === "baseline") expect(run.codeExposure).toBeNull();
		else if (run.codeExposure === "direct") expect(entries.join("")).toContain("outputSchema: CODE_OUTPUT_SCHEMA");
		else expect(entries.join("")).toContain('exposure: "model-only"');
	}
}, 30_000);

test("spending threshold disqualifies an otherwise passing fake session", async () => {
	const root = await directory();
	const fixture = path.join(root, "fixture");
	const results = path.join(root, "results");
	await materializeTask(allTasks[0]!, fixture);
	const env = await fakeEnvironment(root);
	const child = Bun.spawn(
		[
			"bun",
			path.resolve("e2e/run.ts"),
			"--repo",
			fixture,
			"--task",
			"Example",
			"--setup",
			"baseline",
			"--budget-dollars",
			"0.1",
			"--check",
			"true",
			"--results-dir",
			results,
		],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const [exit, , stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	const run = JSON.parse((await readFile(path.join(results, "summary.jsonl"), "utf8")).split("\n")[0]);
	expect(run.exceededCost).toBe(true);
	expect(run.verified).toBe(false);
});

test("suite defaults to a plan and never starts Pi", async () => {
	const root = await directory();
	const env = await fakeEnvironment(root);
	const child = Bun.spawn(["bun", path.resolve("e2e/suite.ts")], { env, stdout: "pipe", stderr: "pipe" });
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	expect(stdout).toContain("No model was called");
	expect(await Bun.file(env.FAKE_CALLS).exists()).toBe(false);
});
