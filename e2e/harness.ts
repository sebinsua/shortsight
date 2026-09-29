import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import type { Drift } from "./tasks/drift.ts";

export type JsonEvent = Record<string, any>;

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface ChangeRecord {
	status: string;
	path: string;
	originalPath?: string;
}

export interface EventSummary {
	turns: number;
	/** The model provider's error when it ended the session, which says nothing about the tools. */
	providerError?: string;
	/** Calls the model made. */
	tools: Record<string, number>;
	failedTools: Record<string, number>;
	/** Calls a tool made, such as a codemode script's; they don't cost the model a turn. */
	nestedTools: Record<string, number>;
	nestedFailedTools: Record<string, number>;
	failedCodeCalls: number;
	toolOutcomes: Array<{
		toolCallId?: string;
		parentToolCallId?: string;
		toolName: string;
		failed: boolean;
		exitCode?: number | null;
		timedOut?: boolean;
		conflicts?: number;
	}>;
	usage: UsageTotals;
}

export interface RunMeasurement {
	verified: boolean;
	providerError?: string;
	seconds: number;
	usage: UsageTotals;
	tools?: Record<string, number>;
	failedTools?: Record<string, number>;
	drift?: Drift | null;
}

/** The evaluator's `DRIFT {...}` line, when its task measures drift. */
export function parseDrift(stdout: string | undefined): Drift | null {
	const line = stdout?.split("\n").find((item) => item.startsWith("DRIFT "));
	return line ? JSON.parse(line.slice("DRIFT ".length)) : null;
}

export interface FrozenExtension {
	label: string;
	source: string;
	path: string;
	revision: string | null;
	dirty: ChangeRecord[];
	fingerprint: string;
}

export function processOutcome(exitCode: number, stderr: string, exceededBudget: boolean, invalidEventLines: number) {
	return { exitCode, stderr, exceededBudget, invalidEventLines };
}

export async function runVerification(command: string, cwd: string, budgetMs: number) {
	if (budgetMs <= 0) return { command, exitCode: null, passed: false, timedOut: true, durationMs: 0, stderr: "" };
	const startedAt = performance.now();
	const child = Bun.spawn(["sh", "-c", command], {
		cwd,
		detached: true,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	let forceTimer: ReturnType<typeof setTimeout> | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup(child.pid, "SIGTERM");
		forceTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 200);
	}, budgetMs);
	const [exitCode, stderr, stdout] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
		new Response(child.stdout).text(),
	]);
	clearTimeout(timer);
	if (forceTimer) clearTimeout(forceTimer);
	return {
		command,
		exitCode,
		passed: exitCode === 0 && !timedOut,
		timedOut,
		durationMs: performance.now() - startedAt,
		stderr,
		stdout,
	};
}

const zeroCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

export function summarizeEvents(events: JsonEvent[]): EventSummary {
	const tools: Record<string, number> = {};
	const failedTools: Record<string, number> = {};
	const nestedTools: Record<string, number> = {};
	const nestedFailedTools: Record<string, number> = {};
	const toolOutcomes: EventSummary["toolOutcomes"] = [];
	const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost() };

	for (const event of events) {
		const parentToolCallId = string(event.parentToolCallId);
		if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
			const counts = parentToolCallId ? nestedTools : tools;
			counts[event.toolName] = (counts[event.toolName] ?? 0) + 1;
		}
		if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
			const details = record(event.result?.details);
			const failed = structuredToolFailure(event, details);
			const failures = parentToolCallId ? nestedFailedTools : failedTools;
			if (failed) failures[event.toolName] = (failures[event.toolName] ?? 0) + 1;
			toolOutcomes.push({
				toolCallId: string(event.toolCallId),
				...(parentToolCallId ? { parentToolCallId } : {}),
				toolName: event.toolName,
				failed,
				exitCode: numberOrNull(details?.exitCode),
				timedOut: boolean(details?.timedOut),
				conflicts: Array.isArray(details?.conflicts) ? details.conflicts.length : undefined,
			});
		}
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const item = record(event.message.usage);
		if (!item) continue;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
			usage[key] += finite(item[key]);
		}
		const cost = record(item.cost);
		if (cost) {
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
				usage.cost[key] += finite(cost[key]);
			}
		}
	}

	const last = events.findLast((event) => event.type === "message_end" && event.message?.role === "assistant");
	const providerError =
		last?.message?.stopReason === "error" ? string(last.message.errorMessage) || "provider error" : undefined;
	return {
		turns: events.filter((event) => event.type === "turn_start").length,
		tools,
		failedTools,
		nestedTools,
		nestedFailedTools,
		failedCodeCalls: (failedTools.code ?? 0) + (nestedFailedTools.code ?? 0),
		toolOutcomes,
		usage,
		...(providerError ? { providerError } : {}),
	};
}

function structuredToolFailure(event: JsonEvent, details: JsonEvent | undefined): boolean {
	if (event.isError === true) return true;
	if (event.toolName !== "code" || !details) return false;
	return (
		details.timedOut === true ||
		(typeof details.exitCode === "number" && details.exitCode !== 0) ||
		(Array.isArray(details.conflicts) && details.conflicts.length > 0)
	);
}

/** Parses `git status --porcelain=v1 -z`; unlike shortstat this includes untracked files. */
export function parseGitStatus(output: string): ChangeRecord[] {
	const fields = output.split("\0");
	const changes: ChangeRecord[] = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (!field) continue;
		const status = field.slice(0, 2);
		const file = field.slice(3);
		if (status.includes("R") || status.includes("C")) {
			const originalPath = fields[++index];
			changes.push({ status, path: file, ...(originalPath ? { originalPath } : {}) });
		} else changes.push({ status, path: file });
	}
	return changes;
}

export async function gitStatus(directory: string): Promise<ChangeRecord[]> {
	const result = await $`git status --porcelain=v1 -z --untracked-files=all`.cwd(directory).nothrow().quiet();
	if (result.exitCode !== 0) throw new Error(`Could not inspect ${directory}: ${result.stderr.toString().trim()}`);
	return parseGitStatus(result.stdout.toString());
}

/** Alternates which revision runs first, reducing order and cache bias. */
export function pairedOrder(run: number): ["baseline", "candidate"] | ["candidate", "baseline"] {
	return run % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

// Attempts the model provider cut short measure nothing about the tools, so they're counted apart.
export function aggregateRuns(all: RunMeasurement[], budgetSeconds: number) {
	const runs = all.filter((run) => !run.providerError);
	const completed = runs.filter((run) => run.verified);
	const totalCost = all.reduce((sum, run) => sum + run.usage.cost.total, 0);
	const failedToolCalls = all.reduce(
		(sum, run) => sum + Object.values(run.failedTools ?? {}).reduce((count, failures) => count + failures, 0),
		0,
	);
	const measured = runs.flatMap((run) => (run.drift ? [run.drift] : []));
	return {
		attempts: runs.length,
		providerErrors: all.length - runs.length,
		verifiedCompletions: completed.length,
		completionRate: runs.length ? completed.length / runs.length : 0,
		budgetSeconds,
		totalCost,
		failedToolCalls,
		costPerVerifiedCompletion: completed.length ? totalCost / completed.length : null,
		meanLatencySeconds: mean(runs.map((run) => run.seconds)),
		meanToolCalls: mean(runs.map((run) => Object.values(run.tools ?? {}).reduce((sum, calls) => sum + calls, 0))),
		meanOutputTokens: mean(runs.map((run) => run.usage.output)),
		// Mean counts per measured attempt; drift is absent for tasks without site checks.
		drift: measured.length
			? {
					attempts: measured.length,
					missed: mean(measured.map((drift) => drift.missed.length)),
					overmatched: mean(measured.map((drift) => drift.overmatched.length)),
					unrelated: mean(measured.map((drift) => drift.unrelated.length)),
				}
			: null,
	};
}

// Share installed dependencies with the source, but point workspace packages at the frozen copy,
// so a run imports the code it froze rather than whatever the source working tree holds later.
async function checkNestedDependencies(directory: string, root: string, seen: Set<string>): Promise<void> {
	const actual = await realpath(directory);
	if (seen.has(actual)) return;
	seen.add(actual);
	const modules = path.join(directory, "node_modules");
	if (!(await lstat(modules).catch(() => null))) return;
	for (const name of await readdir(modules)) {
		const entry = path.join(modules, name);
		const info = await lstat(entry);
		if (name.startsWith("@") && info.isDirectory()) {
			for (const scoped of await readdir(entry)) {
				await checkNestedDependency(path.join(entry, scoped), root, seen);
			}
			continue;
		}
		await checkNestedDependency(entry, root, seen);
	}
}

async function checkNestedDependency(entry: string, root: string, seen: Set<string>): Promise<void> {
	const info = await lstat(entry);
	if (info.isSymbolicLink()) {
		const target = await realpath(entry);
		const local = path.relative(root, target);
		if (local !== ".." && !local.startsWith(`..${path.sep}`) && !path.isAbsolute(local)) {
			throw new Error(`Nested dependency link points into the source workspace: ${entry} -> ${target}`);
		}
	}
	if (info.isDirectory()) await checkNestedDependencies(entry, root, seen);
}

async function isSightreadDependency(entry: string): Promise<boolean> {
	let directory = await realpath(entry);
	if (!(await lstat(directory)).isDirectory()) directory = path.dirname(directory);
	for (; directory !== path.dirname(directory); directory = path.dirname(directory)) {
		const manifest = await readFile(path.join(directory, "package.json"), "utf8").catch(() => null);
		if (manifest) return (JSON.parse(manifest) as { name?: string }).name === "sightread";
	}
	return false;
}

async function linkDependencies(
	from: string,
	to: string,
	root: string,
	frozenRoot: string,
	sightread: "on" | "off",
): Promise<void> {
	if (!(await lstat(from).catch(() => null))) return;
	await mkdir(to, { recursive: true });
	for (const name of (await readdir(from)).toSorted()) {
		const entry = path.join(from, name);
		const info = await lstat(entry);
		if ((name.startsWith("@") || name === ".bin") && info.isDirectory()) {
			await linkDependencies(entry, path.join(to, name), root, frozenRoot, sightread);
			continue;
		}
		if (sightread === "off" && (name === "sightread" || (await isSightreadDependency(entry)))) continue;
		if (info.isDirectory() || (info.isSymbolicLink() && name !== ".bin")) {
			await checkNestedDependencies(entry, root, new Set());
		}
		const target = info.isSymbolicLink() ? await realpath(entry) : undefined;
		const local = target ? path.relative(root, target) : "..";
		const workspace = !local.startsWith("..") && !path.isAbsolute(local) && !local.startsWith("node_modules");
		await symlink(workspace ? path.relative(to, path.join(frozenRoot, local)) : entry, path.join(to, name));
	}
}

/** Copies tracked, dirty and untracked source files once, so later source edits cannot mix revisions. */
export async function freezeExtension(
	source: string,
	destination: string,
	label: string,
	sightread: "on" | "off" = "on",
): Promise<FrozenExtension> {
	source = path.resolve(source);
	await mkdir(destination, { recursive: true });
	const listed = await $`git ls-files -z --cached --others --exclude-standard`.cwd(source).nothrow().quiet();
	if (listed.exitCode !== 0) throw new Error(`Extension must be a Git working tree: ${source}`);
	const files = listed.stdout.toString().split("\0").filter(Boolean).toSorted();
	const fingerprint = await fingerprintFiles(source, files);
	for (const file of files) await copyEntry(path.join(source, file), path.join(destination, file));
	await linkDependencies(
		path.join(source, "node_modules"),
		path.join(destination, "node_modules"),
		await realpath(source),
		destination,
		sightread,
	);
	if ((await fingerprintFiles(destination, files)) !== fingerprint) {
		throw new Error(`Frozen extension differs from its source: ${source}`);
	}
	const revisionResult = await $`git rev-parse HEAD`.cwd(source).nothrow().quiet();
	return {
		label,
		source,
		path: destination,
		revision: revisionResult.exitCode === 0 ? revisionResult.stdout.toString().trim() : null,
		dirty: await gitStatus(source),
		fingerprint,
	};
}

export async function fixtureIdentity(directory: string): Promise<{ changes: ChangeRecord[]; fingerprint: string }> {
	const listed = await $`git ls-files -z --cached --others --exclude-standard`.cwd(directory).nothrow().quiet();
	if (listed.exitCode !== 0) throw new Error(`Fixture must be a Git working tree: ${directory}`);
	const files = listed.stdout.toString().split("\0").filter(Boolean).toSorted();
	return { changes: await gitStatus(directory), fingerprint: await fingerprintFiles(directory, files) };
}

export async function copyFixture(source: string, destination: string): Promise<void> {
	const option = process.platform === "darwin" ? "-cR" : "-R";
	const result = await $`cp ${option} ${source} ${destination}`.nothrow().quiet();
	if (result.exitCode !== 0) throw new Error(`Could not copy fixture: ${result.stderr.toString().trim()}`);
}

async function copyEntry(source: string, destination: string): Promise<void> {
	const info = await lstat(source).catch(() => null);
	if (!info) return;
	await mkdir(path.dirname(destination), { recursive: true });
	if (info.isSymbolicLink()) await symlink(await readlink(source), destination);
	else {
		await Bun.write(destination, Bun.file(source));
		await chmod(destination, info.mode & 0o777);
	}
}

async function fingerprintFiles(root: string, files: string[]): Promise<string> {
	const hash = new Bun.CryptoHasher("sha256");
	for (const file of files) {
		const full = path.join(root, file);
		const info = await lstat(full).catch(() => null);
		if (!info) {
			hash.update(`${file}\0missing\0`);
			continue;
		}
		hash.update(`${file}\0${info.mode}\0`);
		hash.update(info.isSymbolicLink() ? await readlink(full) : await readFile(full));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// It exited between the timer firing and the signal.
	}
}

function record(value: unknown): JsonEvent | undefined {
	return typeof value === "object" && value !== null ? (value as JsonEvent) : undefined;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
	return value === null || typeof value === "number" ? value : undefined;
}
