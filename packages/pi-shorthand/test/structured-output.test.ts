import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunResult } from "shorthand-code";
import { Value } from "typebox/value";
import registerShorthand, { SHORTHAND_OUTPUT_SCHEMA, shorthandOutput } from "../src/index.ts";

let temporaryRoot: string | undefined;
afterEach(async () => {
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	temporaryRoot = undefined;
});

const failedRun: RunResult = {
	exitCode: 1,
	timedOut: false,
	durationMs: 120,
	timings: undefined,
	diagnostics: { spans: [], counters: {} },
	output: "Error: boom",
	warnings: [],
	cleanupWarnings: ["left a mount behind"],
	changes: [{ path: "a.ts", kind: "modified", beforeMode: 0o644, afterMode: 0o644, patch: "@@ -1 +1 @@\n-a\n+b\n" }],
	applied: [],
	conflicts: [],
	rolledBack: ["a.ts"],
	writerInspectionFailed: false,
	stillRunning: [],
	errorLine: 'line 3: throw new Error("boom")',
	timeoutMs: 5000,
	rollback: "file",
};

test("a script gets what the run did, as the declared schema, without the runner's own bookkeeping", () => {
	const output = shorthandOutput(failedRun);
	expect(Value.Check(SHORTHAND_OUTPUT_SCHEMA, output)).toBe(true);
	expect(output).toEqual({
		exitCode: 1,
		timedOut: false,
		output: "Error: boom",
		errorLine: 'line 3: throw new Error("boom")',
		warnings: [],
		changes: [{ path: "a.ts", kind: "modified", patch: "@@ -1 +1 @@\n-a\n+b\n" }],
		applied: [],
		conflicts: [],
		rolledBack: ["a.ts"],
	});
	// Structured content must be JSON, so a missing line is left out rather than undefined.
	expect("errorLine" in shorthandOutput({ ...failedRun, errorLine: undefined })).toBe(false);
});

test("a program that can't be run still gives a script a structured result", async () => {
	temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-shorthand-structured-"));
	let registered: unknown;
	await registerShorthand(
		{
			on() {},
			registerTool(tool: unknown) {
				registered = tool;
			},
		} as unknown as ExtensionAPI,
		async () => undefined,
	);
	const code = registered as {
		outputSchema: unknown;
		execute(
			id: string,
			params: { title: string; program: string },
			signal: AbortSignal,
			onUpdate: undefined,
			context: { cwd: string },
		): Promise<{ isError?: boolean; structuredContent: unknown }>;
	};
	expect(code.outputSchema).toBe(SHORTHAND_OUTPUT_SCHEMA);
	// Not a Git worktree, so the run fails before the program starts.
	const outcome = await code.execute(
		"outside-git",
		{ title: "Edit", program: 'await Bun.write("a.txt", "a");' },
		new AbortController().signal,
		undefined,
		{ cwd: temporaryRoot },
	);
	expect(outcome.isError).toBe(true);
	expect(Value.Check(SHORTHAND_OUTPUT_SCHEMA, outcome.structuredContent)).toBe(true);
	expect(Object.keys(outcome.structuredContent as object)).toEqual(["infrastructureError"]);
});
