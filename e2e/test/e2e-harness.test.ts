import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	aggregateRuns,
	parseDrift,
	copyFixture,
	fixtureIdentity,
	freezeExtension,
	pairedOrder,
	parseGitStatus,
	processOutcome,
	runVerification,
	summarizeEvents,
	type UsageTotals,
} from "../harness.ts";

const temporary: string[] = [];
const usage = (cost: number): UsageTotals => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("event summaries", () => {
	test("preserve usage categories and count failures from structured tool state", () => {
		const events = [
			{ type: "turn_start" },
			{ type: "tool_execution_start", toolName: "code", toolCallId: "one" },
			{
				type: "tool_execution_end",
				toolName: "code",
				toolCallId: "one",
				isError: false,
				result: { content: [{ type: "text", text: "looks successful" }], details: { exitCode: 1, timedOut: false } },
			},
			{
				type: "message_end",
				message: {
					role: "assistant",
					usage: {
						input: 2,
						output: 3,
						cacheRead: 5,
						cacheWrite: 7,
						totalTokens: 17,
						cost: { input: 0.2, output: 0.3, cacheRead: 0.5, cacheWrite: 0.7, total: 1.7 },
					},
				},
			},
		];

		const summary = summarizeEvents(events);
		expect(summary.failedCodeCalls).toBe(1);
		expect(summary.toolOutcomes).toEqual([
			{ toolCallId: "one", toolName: "code", failed: true, exitCode: 1, timedOut: false, conflicts: undefined },
		]);
		expect(summary.usage).toEqual({
			input: 2,
			output: 3,
			cacheRead: 5,
			cacheWrite: 7,
			totalTokens: 17,
			cost: { input: 0.2, output: 0.3, cacheRead: 0.5, cacheWrite: 0.7, total: 1.7 },
		});
	});
});

test("a Pi process failure retains its exit status and stderr", () => {
	expect(processOutcome(23, "authentication failed\n", false, 0)).toEqual({
		exitCode: 23,
		stderr: "authentication failed\n",
		exceededBudget: false,
		invalidEventLines: 0,
	});
});

test("verification is stopped when the remaining experiment budget expires", async () => {
	const result = await runVerification("sleep 5", process.cwd(), 20);
	expect(result.timedOut).toBe(true);
	expect(result.passed).toBe(false);
	expect(result.durationMs).toBeLessThan(1_000);
});

test("Git status preserves untracked additions and unusual filenames", () => {
	expect(parseGitStatus(" M tracked.ts\0?? new file.ts\0?? line\nname.ts\0")).toEqual([
		{ status: " M", path: "tracked.ts" },
		{ status: "??", path: "new file.ts" },
		{ status: "??", path: "line\nname.ts" },
	]);
});

test("aggregate results charge failed attempts to verified completions", () => {
	expect(
		aggregateRuns(
			[
				{ verified: false, seconds: 2, usage: usage(1) },
				{ verified: true, seconds: 4, usage: usage(2) },
			],
			60,
		),
	).toEqual({
		attempts: 2,
		providerErrors: 0,
		verifiedCompletions: 1,
		completionRate: 0.5,
		budgetSeconds: 60,
		totalCost: 3,
		failedToolCalls: 0,
		costPerVerifiedCompletion: 3,
		meanLatencySeconds: 3,
		meanToolCalls: 0,
		meanOutputTokens: 0,
		drift: null,
	});
});

test("calls a codemode script makes are counted apart from the model's own", () => {
	const summary = summarizeEvents([
		{ type: "turn_start" },
		{ type: "tool_execution_start", toolName: "codemode", toolCallId: "1" },
		{ type: "tool_execution_start", toolName: "code", toolCallId: "1/1", parentToolCallId: "1" },
		{
			type: "tool_execution_end",
			toolName: "code",
			toolCallId: "1/1",
			parentToolCallId: "1",
			isError: false,
			result: { details: { exitCode: 1, conflicts: [] } },
		},
		{ type: "tool_execution_end", toolName: "codemode", toolCallId: "1", isError: false, result: {} },
	]);
	expect(summary.tools).toEqual({ codemode: 1 });
	expect(summary.nestedTools).toEqual({ code: 1 });
	expect(summary.failedTools).toEqual({});
	expect(summary.nestedFailedTools).toEqual({ code: 1 });
	expect(summary.failedCodeCalls).toBe(1);
	expect(summary.toolOutcomes.map((outcome) => outcome.parentToolCallId)).toEqual(["1", undefined]);
});

test("an attempt the model provider ended is counted apart, not as the tool failing", () => {
	const ended = summarizeEvents([
		{ type: "turn_start" },
		{
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "Unable to verify model access right now." },
		},
	]);
	expect(ended.providerError).toBe("Unable to verify model access right now.");
	expect(
		summarizeEvents([{ type: "message_end", message: { role: "assistant", stopReason: "stop" } }]).providerError,
	).toBeUndefined();
	const results = aggregateRuns(
		[
			{ verified: false, providerError: ended.providerError, seconds: 20, usage: usage(1), failedTools: { code: 1 } },
			{ verified: true, seconds: 4, usage: usage(2) },
		],
		60,
	);
	expect(results).toMatchObject({
		attempts: 1,
		providerErrors: 1,
		verifiedCompletions: 1,
		completionRate: 1,
		totalCost: 3,
		costPerVerifiedCompletion: 3,
		failedToolCalls: 1,
		meanLatencySeconds: 4,
		meanToolCalls: 0,
	});
});

const drift = (missed: number) => ({
	sites: 4,
	missed: Array(missed).fill("site"),
	decoys: 2,
	overmatched: [],
	unrelated: ["scratch.ts"],
});

test("aggregate results average tool calls, output tokens and drift", () => {
	expect(
		aggregateRuns(
			[
				{
					verified: false,
					seconds: 2,
					usage: { ...usage(1), output: 100 },
					tools: { read: 3, edit: 5 },
					drift: drift(2),
				},
				{ verified: true, seconds: 4, usage: { ...usage(1), output: 300 }, tools: { code: 1 }, drift: drift(0) },
			],
			60,
		),
	).toMatchObject({
		meanToolCalls: 4.5,
		meanOutputTokens: 200,
		drift: { attempts: 2, missed: 1, overmatched: 0, unrelated: 1 },
	});
});

test("drift is read from the evaluator's output", () => {
	expect(parseDrift('DRIFT {"missed":["a"]}\nBehavioural checks passed')).toEqual({ missed: ["a"] } as never);
	expect(parseDrift("checks passed")).toBeNull();
	expect(parseDrift(undefined)).toBeNull();
});

test("paired revisions are frozen separately from an identical dirty fixture", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-e2e-test-"));
	temporary.push(root);
	const fixture = path.join(root, "fixture");
	const baseline = path.join(root, "baseline-source");
	const candidate = path.join(root, "candidate-source");
	for (const directory of [fixture, baseline, candidate]) {
		await mkdir(directory);
		await $`git init -q`.cwd(directory);
		await Bun.write(path.join(directory, "tracked.ts"), "original\n");
		await Bun.write(path.join(directory, "deleted.ts"), "delete me\n");
		await Bun.write(path.join(directory, ".gitignore"), "ignored.txt\n");
		await mkdir(path.join(directory, "bin"));
		await Bun.write(path.join(directory, "bin", "tool"), "#!/bin/sh\n");
		await chmod(path.join(directory, "bin", "tool"), 0o755);
		await $`git add .gitignore tracked.ts deleted.ts bin/tool`.cwd(directory);
		await $`git -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false commit -qm initial`.cwd(
			directory,
		);
	}
	for (const directory of [fixture, baseline, candidate]) await rm(path.join(directory, "deleted.ts"));
	await Bun.write(path.join(fixture, "tracked.ts"), "staged one\n");
	await $`git add tracked.ts`.cwd(fixture);
	await Bun.write(path.join(fixture, "tracked.ts"), "working tree\n");
	await Bun.write(path.join(fixture, "untracked.ts"), "untracked\n");
	await Bun.write(path.join(fixture, "ignored.txt"), "ignored one\n");
	await Bun.write(path.join(baseline, "index.ts"), "baseline\n");
	await Bun.write(path.join(candidate, "index.ts"), "candidate\n");

	const identity = await fixtureIdentity(fixture);
	const recordedFixture = path.join(root, "recorded-fixture");
	const firstFixture = path.join(root, "first-fixture");
	const secondFixture = path.join(root, "second-fixture");
	await copyFixture(fixture, recordedFixture);
	await Bun.write(path.join(fixture, "tracked.ts"), "staged two\n");
	await $`git add tracked.ts`.cwd(fixture);
	await Bun.write(path.join(fixture, "tracked.ts"), "working tree\n");
	await Bun.write(path.join(fixture, "ignored.txt"), "ignored two\n");
	await copyFixture(recordedFixture, firstFixture);
	await copyFixture(recordedFixture, secondFixture);
	const frozenBaseline = await freezeExtension(baseline, path.join(root, "frozen-baseline"), "baseline");
	const frozenCandidate = await freezeExtension(candidate, path.join(root, "frozen-candidate"), "candidate");
	await Bun.write(path.join(baseline, "index.ts"), "changed after freeze\n");

	expect(identity.changes).toEqual([
		{ status: " D", path: "deleted.ts" },
		{ status: "MM", path: "tracked.ts" },
		{ status: "??", path: "untracked.ts" },
	]);
	expect(await fixtureIdentity(firstFixture)).toEqual(identity);
	expect(await fixtureIdentity(secondFixture)).toEqual(identity);
	expect(await $`git show :tracked.ts`.cwd(firstFixture).text()).toBe("staged one\n");
	expect(await Bun.file(path.join(secondFixture, "ignored.txt")).text()).toBe("ignored one\n");
	expect(frozenBaseline.path).not.toBe(frozenCandidate.path);
	expect(await Bun.file(path.join(frozenBaseline.path, "index.ts")).text()).toBe("baseline\n");
	expect(await Bun.file(path.join(frozenCandidate.path, "index.ts")).text()).toBe("candidate\n");
	expect(await lstat(path.join(frozenBaseline.path, "deleted.ts")).catch(() => null)).toBeNull();
	expect((await lstat(path.join(frozenBaseline.path, "bin", "tool"))).mode & 0o111).toBe(0o111);
	expect(pairedOrder(1)).toEqual(["baseline", "candidate"]);
	expect(pairedOrder(2)).toEqual(["candidate", "baseline"]);
});

test("a frozen extension imports its own workspace packages, not the source's later edits", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-shorthand-freeze-"));
	temporary.push(root);
	const source = path.join(root, "source");
	await mkdir(path.join(source, "packages/lib"), { recursive: true });
	await mkdir(path.join(source, "node_modules/@scope/dep"), { recursive: true });
	await Bun.write(path.join(source, ".gitignore"), "node_modules\n");
	await Bun.write(path.join(source, "packages/lib/index.js"), "export default 'frozen';\n");
	await Bun.write(path.join(source, "packages/lib/package.json"), '{"name":"lib","type":"module","main":"index.js"}\n');
	await Bun.write(path.join(source, "node_modules/@scope/dep/package.json"), '{"name":"@scope/dep"}\n');
	await symlink("../packages/lib", path.join(source, "node_modules/lib"));
	await $`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base`.cwd(source);
	const frozen = await freezeExtension(source, path.join(root, "frozen"), "candidate");
	await Bun.write(path.join(source, "packages/lib/index.js"), "export default 'edited later';\n");

	expect(await realpath(path.join(frozen.path, "node_modules/lib"))).toBe(
		await realpath(path.join(frozen.path, "packages/lib")),
	);
	expect(await realpath(path.join(frozen.path, "node_modules/@scope/dep"))).toBe(
		await realpath(path.join(source, "node_modules/@scope/dep")),
	);
	expect((await import(path.join(frozen.path, "node_modules/lib/index.js"))).default).toBe("frozen");
});

test("a frozen extension remaps workspace bins and rejects nested links into live workspace code", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-shorthand-freeze-links-"));
	temporary.push(root);
	const source = path.join(root, "source");
	await mkdir(path.join(source, "packages/tool"), { recursive: true });
	await mkdir(path.join(source, "node_modules/.bin"), { recursive: true });
	await mkdir(path.join(source, "node_modules/dep/node_modules"), { recursive: true });
	await Bun.write(path.join(source, ".gitignore"), "node_modules\n");
	await Bun.write(path.join(source, "packages/tool/cli.js"), "console.log('frozen');\n");
	await symlink("../tool/cli.js", path.join(source, "node_modules/.bin/tool"));
	await symlink("../packages/tool", path.join(source, "node_modules/tool"));
	await symlink(path.join(source, "packages/tool"), path.join(source, "node_modules/dep/node_modules/tool"));
	await $`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base`.cwd(source);
	await expect(freezeExtension(source, path.join(root, "rejected"), "candidate")).rejects.toThrow(
		"Nested dependency link points into the source workspace",
	);
	await rm(path.join(source, "node_modules/dep/node_modules/tool"));
	const frozen = await freezeExtension(source, path.join(root, "frozen"), "candidate");
	await Bun.write(path.join(source, "packages/tool/cli.js"), "console.log('edited later');\n");
	const command = Bun.spawn(["bun", path.join(frozen.path, "node_modules/.bin/tool")], { stdout: "pipe" });
	expect(await new Response(command.stdout).text()).toBe("frozen\n");
	expect(await command.exited).toBe(0);
});

test("sightread-off frozen extension cannot resolve sightread while sightread-on can", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-shorthand-freeze-sightread-"));
	temporary.push(root);
	const source = path.join(root, "source");
	await mkdir(path.join(source, "packages/sightread"), { recursive: true });
	await mkdir(path.join(source, "node_modules/.bin"), { recursive: true });
	await Bun.write(path.join(source, ".gitignore"), "node_modules\n");
	await Bun.write(
		path.join(source, "packages/sightread/package.json"),
		'{"name":"sightread","exports":"./index.js"}\n',
	);
	await Bun.write(path.join(source, "packages/sightread/index.js"), "export const available = true;\n");
	await Bun.write(path.join(source, "packages/sightread/cli.js"), "console.log('sightread');\n");
	await symlink("../packages/sightread", path.join(source, "node_modules/sightread"));
	await symlink("../packages/sightread", path.join(source, "node_modules/alias"));
	await symlink("../sightread/cli.js", path.join(source, "node_modules/.bin/sightread"));
	await symlink("../alias/cli.js", path.join(source, "node_modules/.bin/alias"));
	await $`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base`.cwd(source);
	const on = await freezeExtension(source, path.join(root, "on"), "candidate");
	const off = await freezeExtension(source, path.join(root, "off"), "candidate", "off");
	for (const [frozen, available] of [
		[on, true],
		[off, false],
	] as const) {
		const probe = path.join(frozen.path, "probe.ts");
		await Bun.write(
			probe,
			`const require = (await import("node:module")).createRequire(import.meta.url);
for (const name of ["sightread", "alias"]) {
  try { require.resolve(name); console.log(name + ":require:yes"); }
  catch { console.log(name + ":require:no"); }
  try { await import(name); console.log(name + ":import:yes"); }
  catch { console.log(name + ":import:no"); }
}\n`,
		);
		const child = Bun.spawn(["bun", probe], { cwd: frozen.path, stdout: "pipe", stderr: "pipe" });
		const [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		for (const name of ["sightread", "alias"]) {
			expect(stdout).toContain(`${name}:require:${available ? "yes" : "no"}`);
			expect(stdout).toContain(`${name}:import:${available ? "yes" : "no"}`);
		}
		for (const name of ["sightread", "alias"]) {
			expect(Boolean(await lstat(path.join(frozen.path, "node_modules/.bin", name)).catch(() => null))).toBe(available);
		}
	}
});

test("a nested scoped dependency link into the source workspace is rejected", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-shorthand-freeze-scoped-"));
	temporary.push(root);
	const source = path.join(root, "source");
	await mkdir(path.join(source, "packages/tool"), { recursive: true });
	await mkdir(path.join(source, "node_modules/dep/node_modules/@scope"), { recursive: true });
	await Bun.write(path.join(source, ".gitignore"), "node_modules\n");
	await Bun.write(path.join(source, "packages/tool/index.js"), "export default 'tool';\n");
	await symlink(path.join(source, "packages/tool"), path.join(source, "node_modules/dep/node_modules/@scope/tool"));
	await $`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base`.cwd(source);
	await expect(freezeExtension(source, path.join(root, "frozen"), "candidate")).rejects.toThrow(
		"Nested dependency link points into the source workspace",
	);
});
