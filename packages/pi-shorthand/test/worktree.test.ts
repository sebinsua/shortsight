import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerShorthand from "../src/index.ts";
import type { RunResult } from "shorthand-code";

const hasOverlay =
	process.platform === "darwin"
		? Boolean(process.env.AGENTFS_BIN ?? Bun.which("agentfs"))
		: Boolean(Bun.which("bwrap"));

let temporaryRoot: string | undefined;
afterEach(async () => {
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	temporaryRoot = undefined;
});

test("shorthand targets a child worktree from a bare worktree container", async () => {
	temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-shorthand-code-worktree-"));
	const container = path.join(temporaryRoot, "container");
	const child = path.join(container, "child");
	await $`git init -q --bare ${container}`;
	await $`git -C ${container} worktree add -q -b child ${child}`;
	await Bun.write(path.join(child, "target.txt"), "before\n");
	await $`git add target.txt`.cwd(child);
	await $`git -c user.name=test -c user.email=test@test -c commit.gpgsign=false commit -qm init`.cwd(child);

	let registered: unknown;
	await registerShorthand({
		on() {},
		registerTool(tool: unknown) {
			registered = tool;
		},
	} as unknown as ExtensionAPI);
	const code = registered as {
		execute(
			id: string,
			params: { title: string; program: string; cwd: string },
			signal: AbortSignal,
			onUpdate: undefined,
			context: { cwd: string },
		): Promise<{ details: RunResult | { diagnostics: { failurePhase?: string } } }>;
	};
	const outcome = await code.execute(
		"worktree-call",
		{ title: "Edit child", cwd: "child", program: 'await Bun.write("target.txt", "after\\n");' },
		new AbortController().signal,
		undefined,
		{ cwd: container },
	);

	if (hasOverlay) {
		const result = outcome.details as RunResult;
		expect(result.exitCode).toBe(0);
		expect(result.applied).toEqual(["target.txt"]);
		expect(await Bun.file(path.join(child, "target.txt")).text()).toBe("after\n");
	} else {
		// Restricted environments may deny the lock or lack an overlay. Resolution still used the child.
		const phase = (outcome.details as { diagnostics: { failurePhase?: string } }).diagnostics.failurePhase;
		expect(phase).not.toBe("resolving repository");
		expect(["waiting for repository lock", "creating isolated workspace"]).toContain(phase ?? "");
		expect(await Bun.file(path.join(child, "target.txt")).text()).toBe("before\n");
	}
	// The first overlay run on a fresh CI machine includes mounting AgentFS and transpiling the runner.
}, 30_000);
