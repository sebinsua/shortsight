/**
 * Runs a Bun program against an isolated view of a git repository. The program's writes go to a
 * copy-on-write overlay; afterwards they're diffed, then applied to the repository or discarded.
 *
 * Usage: echo '<RunOptions as JSON>' | bun runner.ts   → prints a RunResult as JSON
 * SIGTERM aborts: the program is killed, the overlay is closed and nothing is applied.
 * Command and helper progress is streamed to the parent process while the run is active.
 *
 * If the program fails:
 * - rollback "all": nothing is applied;
 * - rollback "file": failed or interrupted file edits are discarded; other files are applied.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, readFileSync, realpathSync, type Stats, writeSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { $ } from "bun";
import { structuredPatch } from "diff";
import { RefusedRunError } from "../transaction/transaction-journal.ts";
import { openLinuxOverlay } from "../linux/overlay-linux.ts";
import { openMacOverlay } from "../macos/overlay-macos.ts";
import { discardedEdits, outsideRepositoryHint, typeScriptApiHint } from "./program-lint.ts";
import { ProgramClock } from "./program-clock.ts";
import { supportsFormatting } from "./format.ts";
import {
	type Diagnostics,
	diagnosticCounter,
	diagnosticFailure,
	diagnosticPhase,
	diagnosticLines,
	measure,
	withDiagnostics,
} from "./diagnostics.ts";
import { preserveTextFormat } from "./text-format.ts";
import { type FileOutcomeEvent, parseOpenWriters } from "../program/file-outcomes.ts";
import { openGraphProxy } from "./graph-proxy.ts";

export interface RunOptions {
	cwd: string;
	program: string;
	timeoutMs: number;
	rollback: "all" | "file";
	/** false when the caller doesn't offer `graph.query`. */
	graph?: boolean;
	testHooks?: RunTestHooks;
}

interface RunTestHooks {
	apply?: ApplicationTestHooks;
	programStartMarker?: string;
	writerInspectionFailure?: boolean;
	workspaceCleanupFailure?: boolean;
	finalCleanupDelayMs?: number;
	graphColdStartDelayMs?: number;
}

interface ApplicationTestHooks {
	failAfter?: number;
	delayMs?: number;
	delayAfter?: number;
	failAfterBackup?: number;
	beforeCommitDelayMs?: number;
	beforeCommitMarker?: string;
	cleanupFailure?: boolean;
}

export interface RunResult {
	exitCode: number | null; // null if it was killed
	timedOut: boolean;
	durationMs: number;
	timings?: RunTimings;
	diagnostics?: Diagnostics;
	output: string; // stdout and stderr
	warnings: string[]; // likely mistakes spotted in the program before it ran
	cleanupWarnings: string[]; // application/cleanup completed with a non-fatal infrastructure warning
	changes: FileChange[]; // everything the program changed
	applied: string[]; // the changed files that were applied
	conflicts: string[]; // destinations changed after the run's baseline was captured
	rolledBack: string[]; // rollback "file": changed files not retained because completion was not established
	writerInspectionFailed: boolean; // inspection unavailable: no changed file was retained on failure
	stillRunning: string[]; // on timeout: commands the program was still running, e.g. "find / -name x (for 58s)"
	lastStep?: string; // on timeout: the last step the program logged, e.g. "$ find / -name x" or "grep (18 ms)"
	errorLine?: string; // on failure: the program's line the error came from, e.g. "line 3: throw new Error(…)"
	timeoutMs: number;
	helperMs?: number; // time inside shorthand helpers, which did not count toward timeoutMs
	rollback: RunOptions["rollback"];
}

export interface RunTimings {
	resolveRepositoryMs: number;
	waitForLockMs: number;
	workspaceSetupMs: number;
	programMs: number;
	scanChangesMs: number;
	formatMs: number;
	workspaceCloseMs: number;
	checkConflictsMs: number;
	applyMs: number;
	renderDiffMs: number;
	unattributedMs: number;
}

export interface FileChange {
	path: string; // relative to the tool's working directory
	kind: "added" | "modified" | "deleted";
	beforeType?: FilesystemEntry["type"];
	afterType?: FilesystemEntry["type"];
	beforeMode?: number;
	afterMode?: number;
	patch: string;
}

export type FilesystemEntry =
	| { type: "file"; contents: Uint8Array; mode: number }
	| { type: "symlink"; target: string };

/** A copy-on-write view of the repository. */
export interface Overlay {
	original(file: string): Promise<FilesystemEntry | null>; // retained on-demand baseline
	dependencyConflicts(): Promise<string[]>; // valid only after a successful observation close
	writableDir: string; // writing a file here puts it into the overlay
	executionDir: string; // repository root as seen by the program process
	gitExcludes: string[]; // extra patterns git should ignore inside the overlay
	executionExcludesFile?: string; // sandbox-visible path when the host temporary path is hidden
	environment?: Record<string, string>; // backend-specific environment inside the sandbox
	formattingAvailable?: boolean; // populated by change discovery when the backend can inspect formatter configuration
	ignoredPaths?: string[]; // final ignore policy for the candidates returned by changes()
	wrap(command: string[], cwd: string): string[]; // makes a command run inside the overlay
	terminateProcesses?(): Promise<void>; // backend lifecycle boundary for descendants outside our process group
	stopProgram?(pid: number): void; // permit the observer to reap tracees and finish its journal
	changes(): Promise<{ file: string; entry: FilesystemEntry | null }[]>; // may include files only read
	close(): Promise<void>;
}

/** A changed file, relative to the repository root, with its new contents (null if deleted). */
interface Change {
	file: string;
	before: FilesystemEntry | null;
	after: FilesystemEntry | null;
}

const PROGRAM_FILE = ".pi-shorthand-program.ts";
const PRELUDE = path.join(import.meta.dir, "../program/prelude.ts");
const START_DIRECTORY = path.join(import.meta.dir, "../program/start-directory.ts");
// Our dependencies are in the nearest node_modules that has them: our own, or, when npm hoisted them
// (e.g. Pi's project installs), one further up. Like `npm run`, look in every one from here up.
const NODE_MODULES = ancestors(import.meta.dir).map((dir) => path.join(dir, "node_modules"));
const MAX_OUTPUT_CHARS = 1024 * 1024; // a safety cap; index.ts decides how much the model sees

async function run(options: RunOptions, abort: AbortSignal): Promise<RunResult> {
	const startedAt = performance.now();
	let phaseStartedAt = startedAt;
	const measured: Partial<RunTimings> = {};
	const finishPhase = (phase: keyof Omit<RunTimings, "unattributedMs">) => {
		const now = performance.now();
		measured[phase] = (measured[phase] ?? 0) + now - phaseStartedAt;
		phaseStartedAt = now;
	};
	reportProgress("resolving repository");
	const cwd = await fs.realpath(options.cwd);
	const repo = await findRepository(cwd);
	finishPhase("resolveRepositoryMs");
	reportProgress("waiting for repository lock");
	const releaseLock = await takeRepositoryLock(repo, abort);
	finishPhase("waitForLockMs");
	let tempDir: string | undefined;
	let result: RunResult | undefined;
	let primaryError: unknown;
	const runCleanupWarnings: string[] = [];
	const formatWarnings: string[] = [];

	try {
		reportProgress("creating isolated workspace");
		tempDir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "pi-shorthand-"));
		const open = process.platform === "darwin" ? openMacOverlay : openLinuxOverlay;
		const overlay = await open(repo, tempDir);
		finishPhase("workspaceSetupMs");
		let program: ProgramRun;
		let changes: Change[];
		let executionError: unknown;
		try {
			reportProgress("running edit program");
			program = await runProgram({ ...options, cwd }, abort, overlay, repo, tempDir);
			finishPhase("programMs");
			reportProgress("scanning changes");
			try {
				changes = abort.aborted ? [] : await findChanges(overlay);
			} catch (error) {
				// Cancellation can stop observation before its first handshake. There
				// is no candidate to publish; do not demand a completed journal just
				// to discard it. Every non-cancelled path still fails closed.
				if (!abort.aborted) throw error;
				changes = [];
			}
			const preserved: { file: string; base64: string }[] = [];
			if (process.env.PI_SHORTHAND_PRESERVE_TEXT !== "0") {
				for (const change of changes) {
					if (change.before?.type !== "file" || change.after?.type !== "file") continue;
					const contents = preserveTextFormat(change.before.contents, change.after.contents);
					if (contents === change.after.contents) continue;
					change.after = { ...change.after, contents };
					preserved.push({ file: change.file, base64: Buffer.from(contents).toString("base64") });
				}
				changes = changes.filter((change) => !entriesEqual(change.before, change.after));
			}
			finishPhase("scanChangesMs");
			const files = changes.filter((change) => change.after?.type === "file").map((change) => change.file);
			if (
				program.exitCode === 0 &&
				program.failedFiles.length === 0 &&
				!abort.aborted &&
				files.some(supportsFormatting) &&
				overlay.formattingAvailable !== false &&
				process.env.PI_SHORTHAND_FORMAT !== "0"
			) {
				reportProgress("running automatic formatter");
				try {
					const module = executionPath(path.join(import.meta.dir, "format.ts"), repo, overlay);
					const formatting = await runProgram(
						{
							...options,
							cwd: repo,
							timeoutMs: 10_000,
							testHooks: undefined,
							program: `import { formatChanged } from ${JSON.stringify(module)};
for (const { file, base64 } of ${JSON.stringify(preserved)}) await Bun.write(file, Buffer.from(base64, "base64"));
console.log(JSON.stringify(await formatChanged(${JSON.stringify(files)}, process.cwd())));`,
						},
						abort,
						overlay,
						repo,
						tempDir,
					);
					if (formatting.exitCode !== 0)
						formatWarnings.push(
							`Automatic formatting ${formatting.timedOut ? "timed out" : "failed"}; completed edits are retained. ${formatting.output.trim().slice(-2000)}`,
						);
					else {
						const formatted = JSON.parse(formatting.output);
						formatWarnings.push(...formatted.warnings);
						if (formatted.warnings.length === 0) {
							// Keep the already captured candidate unless the entire formatting pass succeeds.
							// These snapshots also exclude additional writes/deletions from failed formatters.
							changes = await findChanges(overlay);
							if (formatted.messages.length) program.output += "\n" + formatted.messages.join("\n") + "\n";
						} else {
							formatWarnings.push("Formatting changes discarded; completed edits are retained.");
						}
					}
				} catch (error) {
					formatWarnings.push(`Automatic formatting failed; completed edits are retained: ${String(error)}`);
				}
				finishPhase("formatMs");
			}
		} catch (error) {
			diagnosticFailure();
			executionError = error;
			throw error;
		} finally {
			reportProgress("closing isolated workspace");
			try {
				await closeOverlay(overlay, options.testHooks?.workspaceCleanupFailure);
			} catch (error) {
				const warning = cleanupWarning("isolated workspace", error);
				if (executionError) attachCleanupWarning(executionError, warning);
				else runCleanupWarnings.push(warning);
			}
			finishPhase("workspaceCloseMs");
		}

		const shown = (file: string) => path.relative(cwd, path.join(repo, file));
		const { applied: requested, rolledBack } = whatToApply(changes, program, options.rollback, abort.aborted);
		reportProgress("checking for conflicts");
		let conflicts = abort.aborted
			? []
			: [
					...new Set([...(await overlay.dependencyConflicts()), ...(await conflictingFiles(repo, requested))]),
				].toSorted();
		finishPhase("checkConflictsMs");
		let applied: Change[] = [];
		let applicationWarnings: string[] = [];
		if (conflicts.length === 0) {
			reportProgress("applying changes");
			({
				applied,
				conflicts,
				warnings: applicationWarnings,
			} = await applyChanges(repo, requested, { abort, testHooks: options.testHooks?.apply }));
		}
		finishPhase("applyMs");
		reportProgress("rendering diff");
		const describedChanges = changes.map((change) => describe(shown(change.file), change));
		finishPhase("renderDiffMs");
		const durationMs = performance.now() - startedAt;
		const measuredMs = Object.values(measured).reduce((sum, milliseconds) => sum + (milliseconds ?? 0), 0);
		const timings: RunTimings = {
			resolveRepositoryMs: Math.round(measured.resolveRepositoryMs ?? 0),
			waitForLockMs: Math.round(measured.waitForLockMs ?? 0),
			workspaceSetupMs: Math.round(measured.workspaceSetupMs ?? 0),
			programMs: Math.round(measured.programMs ?? 0),
			scanChangesMs: Math.round(measured.scanChangesMs ?? 0),
			formatMs: Math.round(measured.formatMs ?? 0),
			workspaceCloseMs: Math.round(measured.workspaceCloseMs ?? 0),
			checkConflictsMs: Math.round(measured.checkConflictsMs ?? 0),
			applyMs: Math.round(measured.applyMs ?? 0),
			renderDiffMs: Math.round(measured.renderDiffMs ?? 0),
			unattributedMs: Math.max(0, Math.round(durationMs - measuredMs)),
		};
		result = {
			exitCode: program.exitCode,
			timedOut: program.timedOut,
			durationMs: Math.round(durationMs),
			timings,
			output: program.output,
			warnings: [
				...lint(options.program),
				...(program.exitCode !== 0 && !program.timedOut
					? [
							...typeScriptApiHint(options.program, program.output, typeScriptVersion(cwd)),
							...outsideRepositoryHint(program.output, repo, (file) => insideRepository(repo, file)),
						]
					: []),
				...formatWarnings,
				...applicationWarnings,
				...runCleanupWarnings,
			],
			cleanupWarnings: [...applicationWarnings, ...runCleanupWarnings],
			changes: describedChanges,
			applied: applied.map((change) => shown(change.file)),
			conflicts: conflicts.map(shown),
			rolledBack: rolledBack.map((change) => shown(change.file)),
			writerInspectionFailed: program.openForWriting === null,
			stillRunning: program.stillRunning,
			lastStep: program.timedOut ? program.lastStep : undefined,
			errorLine: program.exitCode !== 0 ? failingLine(options.program, program.output) : undefined,
			timeoutMs: options.timeoutMs,
			helperMs: program.helperMs,
			rollback: options.rollback,
		};
		return result;
	} catch (error) {
		diagnosticFailure();
		primaryError = error;
		for (const warning of runCleanupWarnings) attachCleanupWarning(error, warning);
		throw error;
	} finally {
		const cleanupStartedAt = performance.now();
		reportProgress("cleaning temporary workspace and releasing lock");
		const finalWarnings: string[] = [];
		try {
			if (options.testHooks?.finalCleanupDelayMs) await Bun.sleep(options.testHooks.finalCleanupDelayMs);
			if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		} catch (error) {
			finalWarnings.push(cleanupWarning("temporary workspace", error));
		}
		try {
			await releaseLock();
		} catch (error) {
			finalWarnings.push(cleanupWarning("repository lock", error));
		}
		if (result) {
			result.warnings.push(...finalWarnings);
			result.cleanupWarnings.push(...finalWarnings);
			const finishedAt = performance.now();
			measured.workspaceCloseMs = (measured.workspaceCloseMs ?? 0) + finishedAt - cleanupStartedAt;
			result.durationMs = Math.round(finishedAt - startedAt);
			if (result.timings) {
				result.timings.workspaceCloseMs = Math.round(measured.workspaceCloseMs);
				const accountedMs = Object.values(measured).reduce((sum, milliseconds) => sum + (milliseconds ?? 0), 0);
				result.timings.unattributedMs = Math.max(0, Math.round(finishedAt - startedAt - accountedMs));
			}
		} else if (primaryError) {
			for (const warning of finalWarnings) attachCleanupWarning(primaryError, warning);
		}
	}
}

async function closeOverlay(overlay: Overlay, injectFailure = false) {
	await overlay.close();
	if (injectFailure) throw new Error("Injected isolated-workspace cleanup failure.");
}

function cleanupWarning(resource: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	const warning = `The run reached its reported outcome, but cleanup of its ${resource} failed: ${detail}`;
	return warning;
}

function attachCleanupWarning(error: unknown, warning: string) {
	if (!(error instanceof Error)) return;
	const annotated = error as Error & { cleanupWarnings?: string[] };
	annotated.cleanupWarnings = [...(annotated.cleanupWarnings ?? []), warning];
}

/** Serializes shorthand baselines and commits for one repository, including across runner processes. */
async function takeRepositoryLock(repo: string, abort: AbortSignal): Promise<() => Promise<void>> {
	const lock = await repositoryLockPath(repo);
	const ownerFile = path.join(lock, "owner.json");
	for (let attempt = 0; attempt < 3000; attempt++) {
		abort.throwIfAborted();
		try {
			await fs.mkdir(lock);
			try {
				await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid }));
			} catch (error) {
				await fs.rmdir(lock).catch(() => {});
				throw error;
			}
			return async () => {
				await fs.rm(ownerFile, { force: true });
				await fs.rmdir(lock);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = await Bun.file(ownerFile)
			.json()
			.catch(() => null);
		if (typeof owner?.pid === "number" && !processAlive(owner.pid)) {
			await fs.rm(ownerFile, { force: true });
			await fs.rmdir(lock).catch(() => {});
			continue;
		}
		if (!owner && (await olderThan(lock, 1000))) {
			await fs.rmdir(lock).catch(() => {});
			continue;
		}
		await Bun.sleep(20);
	}
	throw new Error("Another shorthand run on this repository did not finish within a minute.");
}

/** A per-checkout lock in stable user-writable storage (the macOS overlay moves the checkout). */
async function repositoryLockPath(repo: string): Promise<string> {
	const lockRoot = path.join(homedir(), ".cache", "pi-shorthand", "locks");
	await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
	const stats = await fs.lstat(lockRoot);
	if (!stats.isDirectory() || stats.isSymbolicLink() || (process.getuid && stats.uid !== process.getuid())) {
		throw new Error(`Unsafe shorthand lock directory: ${lockRoot}`);
	}
	if ((stats.mode & 0o077) !== 0) await fs.chmod(lockRoot, 0o700);
	const checkout = createHash("sha256").update(repo).digest("hex").slice(0, 16);
	return path.join(lockRoot, checkout);
}

async function olderThan(file: string, milliseconds: number): Promise<boolean> {
	const stats = await fs.stat(file).catch(() => null);
	return Boolean(stats && Date.now() - stats.mtimeMs > milliseconds);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Changed destinations make the whole host-side application fail before its first write. */
async function conflictingFiles(repo: string, changes: Change[]): Promise<string[]> {
	const conflicts = [];
	for (const change of changes) {
		if (!(await destinationMatches(repo, change))) conflicts.push(change.file);
	}
	return conflicts;
}

/** Compares the complete no-follow filesystem entry and rechecks the path leading to it. */
async function destinationMatches(repo: string, change: Change): Promise<boolean> {
	const target = path.join(repo, change.file);
	if (!(await safeParentChain(repo, target, change.before === null))) return false;
	try {
		const current = await snapshotEntry(target);
		return entriesEqual(current, change.before) && (await safeParentChain(repo, target, change.before === null));
	} catch (error) {
		if (error instanceof UnsupportedEntryError) return false;
		throw error;
	}
}

/** Every existing ancestor must remain a real directory inside the checkout, never a symlink. */
async function safeParentChain(repo: string, target: string, allowMissing = false): Promise<boolean> {
	const relative = path.relative(repo, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
	let parent = path.dirname(target);
	while (parent !== repo) {
		try {
			const stats = await fs.lstat(parent);
			if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
		} catch (error) {
			if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
		parent = path.dirname(parent);
	}
	return true;
}

/** Retain independent file edits, excluding failed operations and interrupted writers. */
function whatToApply(changes: Change[], program: ProgramRun, rollback: RunOptions["rollback"], aborted: boolean) {
	if (aborted) return { applied: [], rolledBack: [] };
	if (rollback === "all") return { applied: program.exitCode === 0 ? changes : [], rolledBack: [] };
	if (program.openForWriting === null) return { applied: [], rolledBack: changes };

	const failed = new Set([...program.failedFiles, ...program.openForWriting]);
	return {
		applied: changes.filter((change) => !failed.has(change.file)),
		rolledBack: changes.filter((change) => failed.has(change.file)),
	};
}

/** A `$` command that isn't awaited never runs: Bun's shell starts a command when it's awaited. */
const UNAWAITED_SHELL = {
	rule: {
		kind: "call_expression",
		has: { field: "function", regex: "^\\$$" },
		not: {
			inside: {
				any: [{ kind: "await_expression" }, { kind: "return_statement" }],
				stopBy: { kind: "statement_block" },
			},
		},
	},
};

/** Likely mistakes in the program, found without running it. */
function lint(program: string): string[] {
	const root = parse(Lang.TypeScript, program).root();
	return [
		...discardedEdits(root),
		...root.findAll(UNAWAITED_SHELL).map((node) => {
			const line = node.range().start.line + 1;
			return `line ${line}: ${node.text().split("\n")[0]} isn't awaited, so the command may not have run`;
		}),
	];
}

/** The TypeScript version a program started in `cwd` would import: the project's own, else ours. */
function typeScriptVersion(cwd: string): string | undefined {
	for (const from of [cwd, import.meta.dir]) {
		try {
			const manifest = Bun.resolveSync("typescript/package.json", from);
			return JSON.parse(readFileSync(manifest, "utf8")).version;
		} catch {
			// Not installed here; try the next location.
		}
	}
	return undefined;
}

/** A run that can't start because of where it was asked to run. Reported as its message alone, without a stack. */
class OutsideRepositoryError extends Error {}

async function findRepository(cwd: string): Promise<string> {
	const result = await $`git rev-parse --show-toplevel`.cwd(cwd).nothrow().quiet();
	if (result.exitCode !== 0)
		throw new OutsideRepositoryError(
			`shorthand only works inside a git repository, and ${cwd} isn't in one. Edit files outside a repository directly.`,
		);
	return fs.realpath(result.text().trim());
}

/** Whether `file` is inside `repo`, comparing real paths so /tmp and /private/tmp agree. */
function insideRepository(repo: string, file: string): boolean {
	let existing = path.resolve(file);
	const rest: string[] = [];
	while (!existsSync(existing) && path.dirname(existing) !== existing) {
		rest.unshift(path.basename(existing));
		existing = path.dirname(existing);
	}
	let real: string;
	try {
		real = path.join(realpathSync(existing), ...rest);
	} catch {
		real = path.resolve(file);
	}
	return real === repo || real.startsWith(repo + path.sep);
}

// ── Running the program ───────────────────────────────────────────────────────────

interface ProgramRun {
	exitCode: number | null;
	timedOut: boolean;
	output: string;
	openForWriting: string[] | null; // on failure/timeout: open writers, or null when inspection was unavailable
	failedFiles: string[];
	stillRunning: string[]; // on timeout: the commands it was still running
	lastStep?: string;
	helperMs: number;
}

async function runProgram(
	options: RunOptions,
	abort: AbortSignal,
	overlay: Overlay,
	repo: string,
	tempDir: string,
): Promise<ProgramRun> {
	abort.throwIfAborted();
	// The program file goes into the working directory, so its relative imports resolve as usual.
	const programPath = path.join(options.cwd, PROGRAM_FILE);
	const programFile = path.join(overlay.writableDir, path.relative(repo, programPath));
	const executionCwd = path.join(overlay.executionDir, path.relative(repo, options.cwd));
	const executionProgramPath = path.join(executionCwd, PROGRAM_FILE);
	const executionPrelude = executionPath(PRELUDE, repo, overlay);
	// Bun shows the wrong source beside an error on a last line with no newline after it.
	const source = options.program.endsWith("\n") ? options.program : `${options.program}\n`;
	// On macOS, a file the runner creates in a subdirectory of the AgentFS mount before the program starts leaves
	// that directory's working-directory lookups failing (ENOENT) for the program and everything it runs. From a
	// subdirectory, an entry at the root writes the program there from inside the process, then runs it.
	const subdirectory = executionCwd !== overlay.executionDir;
	const executionEntry = subdirectory ? path.join(overlay.executionDir, PROGRAM_FILE) : executionProgramPath;
	if (subdirectory)
		await Bun.write(
			path.join(overlay.writableDir, PROGRAM_FILE),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(executionProgramPath)}, ${JSON.stringify(source)});\nawait import(${JSON.stringify(executionProgramPath)});\n`,
		);
	else await Bun.write(programFile, source);

	const excludesFile = overlay.executionExcludesFile ?? path.join(tempDir, "exclude");
	await Bun.write(excludesFile, [PROGRAM_FILE, ...overlay.gitExcludes, await globalGitExcludes()].join("\n"));

	// Output goes to a file rather than a pipe, so a process the program leaves running can't hold it open.
	// detached: the program gets its own process group, so killing the group kills anything it started too.
	const outputFile = path.join(tempDir, "output");
	const output = await fs.open(outputFile, "w");
	const trackFiles = options.rollback === "file";
	const outcomePath = path.join(tempDir, "file-outcomes");
	const outcomeFile = await fs.open(outcomePath, "w");
	const graphProxy = await openGraphProxy(tempDir, options.cwd, repo, {
		delayMs: options.testHooks?.graphColdStartDelayMs,
		disabled: options.graph === false,
	});
	try {
		// Started at the workspace root, then moved into its directory by the first preload: see start-directory.ts.
		const [command, ...args] = overlay.wrap(
			[
				process.execPath,
				"--preload",
				executionPath(START_DIRECTORY, repo, overlay),
				"--preload",
				executionPrelude,
				executionEntry,
			],
			overlay.executionDir,
		);
		if (options.testHooks?.programStartMarker) await Bun.write(options.testHooks.programStartMarker, "started");
		const child = spawn(command, args, {
			cwd: overlay.executionDir,
			detached: true,
			stdio: ["ignore", output.fd, output.fd, trackFiles ? outcomeFile.fd : "ignore", "pipe"],
			env: {
				...process.env,
				...overlay.environment,
				...programEnvironment(excludesFile, repo, overlay),
				PI_SHORTHAND_OUTCOMES_FD: trackFiles ? "3" : "",
				PI_SHORTHAND_PROGRESS_FD: "4",
				PI_SHORTHAND_EXECUTION_ROOT: overlay.executionDir,
				PI_SHORTHAND_START_DIRECTORY: executionCwd,
				PI_SHORTHAND_INSPECTION_FAILURE: options.testHooks?.writerInspectionFailure ? "1" : "",
				PI_SHORTHAND_GRAPH_SOCKET: graphProxy.path,
			},
		});
		const clock = new ProgramClock();
		const progress = trackProgress(child, clock);
		const killAll = () => {
			if (overlay.stopProgram) {
				// Native observers do not exit until their tracees are gone. Never
				// signal their former PID after exit: it may already have been reused.
				if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
				try {
					overlay.stopProgram(child.pid);
				} catch {
					/* already exited */
				}
			} else killGroup(child);
		};
		abort.addEventListener("abort", killAll);
		if (abort.aborted) killAll();

		const { exitCode, timedOut, openForWriting, stillRunning } = await measure(
			"sandbox wait (includes preloads and program)",
			() =>
				waitWithTimeout(
					child,
					options.timeoutMs,
					clock,
					overlay.executionDir,
					options.testHooks?.writerInspectionFailure,
					killAll,
				),
		);
		killAll(); // anything it left running
		abort.removeEventListener("abort", killAll);
		const helperMs = Math.round(clock.excludedMs());
		if (helperMs > 0) diagnosticCounter("helper ms excluded from timeout", helperMs);
		try {
			await measure("descendant cleanup", async () => {
				await overlay.terminateProcesses?.();
			});
		} finally {
			await Promise.all([output.close(), outcomeFile.close()]);
			await measure("progress pipe close", () => progress.closed);
			await fs.rm(programFile, { force: true });
		}
		const outcomes = fileOutcomes(await Bun.file(outcomePath).text());

		// Keep the tail, where errors are. Show stack traces as "program.ts:3:11", and drop Bun's version footer.
		let text = await Bun.file(outputFile).text();
		if (text.length > MAX_OUTPUT_CHARS) {
			text = `[${text.length - MAX_OUTPUT_CHARS} earlier characters dropped]\n${text.slice(-MAX_OUTPUT_CHARS)}`;
		}
		text = text.replaceAll(executionProgramPath, "program.ts").replace(/\nBun v[\d.]+ \([^)]*\)\n?$/, "\n");

		return {
			exitCode,
			timedOut,
			output: text,
			openForWriting: trackFiles && exitCode !== 0 && !timedOut ? outcomes.writers : openForWriting,
			stillRunning,
			failedFiles: outcomes.failedFiles,
			lastStep: progress.latest(),
			helperMs,
		};
	} finally {
		await graphProxy.close();
	}
}

/** Report infrastructure phases as well as commands, so a slow call says what it is waiting on. */
function reportProgress(step: string, phase = true) {
	if (phase) diagnosticPhase(step);
	try {
		writeSync(3, JSON.stringify({ step }) + "\n");
	} catch {
		// Direct runner callers do not provide a progress descriptor.
	}
}

/** Keep the latest command/helper in memory and relay it to index.ts over the runner's descriptor 3. */
function trackProgress(child: ChildProcess, clock: ProgramClock) {
	const stream = child.stdio[4];
	let buffer = "";
	let lastStep: string | undefined;
	const closed = new Promise<void>((resolve) => {
		if (!stream || !("setEncoding" in stream)) return resolve();
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const event = JSON.parse(line) as {
						type?: unknown;
						command?: unknown;
						helper?: unknown;
						id?: unknown;
						ms?: unknown;
					};
					if (event.type === "command" && typeof event.command === "string") lastStep = `$ ${event.command}`;
					else if (event.type === "helper-start" && typeof event.helper === "string") {
						if (typeof event.id === "number") clock.helperStarted(event.id);
						lastStep = `${event.helper} (running)`;
					} else if (event.type === "helper-yield" && typeof event.helper === "string") {
						// The helper is running the program's own callback, which counts toward the timeout.
						if (typeof event.id === "number") clock.helperFinished(event.id);
						lastStep = `${event.helper} callback (running)`;
					} else if (event.type === "helper-resume" && typeof event.helper === "string") {
						if (typeof event.id === "number") clock.helperStarted(event.id);
						lastStep = `${event.helper} (running)`;
					} else if (event.type === "helper" && typeof event.helper === "string" && typeof event.ms === "number") {
						if (typeof event.id === "number") clock.helperFinished(event.id);
						lastStep = `${event.helper} (${event.ms} ms)`;
					} else continue;
					reportProgress(lastStep, false);
				} catch {
					// Progress is advisory; malformed events do not affect the run.
				}
			}
		});
		stream.once("end", resolve);
		stream.once("error", resolve);
	});
	return { closed, latest: () => lastStep };
}

/** Replay helper outcomes after all program processes have stopped. */
function fileOutcomes(text: string) {
	const active = new Map<number, string[]>();
	const failed = new Set<string>();
	let writers: string[] | null = null;
	for (const line of text.split("\n").slice(0, -1).filter(Boolean)) {
		const event = JSON.parse(line) as FileOutcomeEvent;
		if (event.type === "begin") active.set(event.id, event.files);
		else if (event.type === "end") active.delete(event.id);
		else if (event.type === "fail") {
			for (const file of active.get(event.id) ?? []) failed.add(file);
			active.delete(event.id);
		} else if (event.type === "error") {
			for (const file of event.files) failed.add(file);
		} else if (event.type === "writers") writers = event.files;
	}
	return { writers, failedFiles: [...new Set([...failed, ...[...active.values()].flat()])] };
}

/**
 * Waits for the program to exit, or kills it after timeoutMs of program time (see ProgramClock). Before killing it, notes which files
 * it (or anything it started) still has open for writing, since they may be half-written, and which
 * commands it was still running, since one of them is probably why it timed out.
 */
async function waitWithTimeout(
	child: ChildProcess,
	timeoutMs: number,
	clock: ProgramClock,
	repo: string,
	forceInspectionFailure = false,
	stop = () => killGroup(child),
) {
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	let timer: Timer | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		// While a pausing helper runs, the remaining time does not shrink, so this rechecks at that interval.
		const check = () => {
			const remaining = timeoutMs - clock.elapsedMs();
			if (remaining <= 0) resolve("timeout");
			else timer = setTimeout(check, remaining);
		};
		timer = setTimeout(check, timeoutMs);
	});
	const winner = await Promise.race([exited, timeout]);
	clearTimeout(timer);
	if (winner !== "timeout") return { exitCode: winner, timedOut: false, openForWriting: [], stillRunning: [] };

	const [openForWriting, stillRunning] = await Promise.all([
		filesOpenForWriting(repo, forceInspectionFailure),
		commandsRunning(child.pid!),
	]);
	stop();
	await exited;
	return {
		exitCode: null,
		timedOut: true,
		openForWriting,
		stillRunning,
	};
}

/**
 * The commands running in a process group, with how long each has been running, e.g.
 * "find / -name x (running 58s)". Leaves out the program itself and bubblewrap, which wraps it.
 */
async function commandsRunning(processGroup: number): Promise<string[]> {
	const pids = (await $`pgrep -g ${processGroup}`.nothrow().quiet().text()).split("\n").filter(Boolean);
	if (pids.length === 0) return [];
	const output = await $`ps -o etime=,command= -p ${pids.join(",")}`.nothrow().quiet().text();

	const commands: string[] = [];
	for (const line of output.split("\n")) {
		const match = line.trim().match(/^(\S+)\s+(.+)$/);
		if (!match) continue;
		const [, elapsed, command] = match;
		if (command.includes(PROGRAM_FILE) || /^\S*bwrap /.test(command)) continue;
		commands.push(`${command.slice(0, 200)} (for ${seconds(elapsed)}s)`);
	}
	return commands;
}

/**
 * The line of the program an error came from, found from Bun's "at program.ts:3:11" rather than its
 * source excerpt, which leaves out long lines and then mislabels the ones around them.
 */
function failingLine(program: string, output: string): string | undefined {
	const location = output.match(/\bprogram\.ts:(\d+):\d+/);
	if (!location) return undefined;
	const text = program.split("\n")[Number(location[1]) - 1]?.trim();
	return text ? `line ${location[1]}: ${text}`.slice(0, 160) : undefined;
}

/** ps's elapsed time, "[[dd-]hh:]mm:ss", in seconds. */
function seconds(elapsed: string): number {
	const [days, clock] = elapsed.includes("-") ? elapsed.split("-") : ["0", elapsed];
	const parts = clock.split(":").map(Number);
	const [hours, minutes, secs] = [0, 0, ...parts].slice(-3);
	return Number(days) * 86400 + hours * 3600 + minutes * 60 + secs;
}

function killGroup(child: ChildProcess) {
	try {
		process.kill(-child.pid!, "SIGKILL");
	} catch {
		// already gone
	}
}

/**
 * Adds our git excludes on top of any GIT_CONFIG_* the user already set. core.excludesFile
 * replaces the user's global excludes file, so globalGitExcludes() copies that file's patterns in.
 */
function programEnvironment(excludesFile: string, repo: string, overlay: Overlay) {
	const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
	const nodeModules = NODE_MODULES.map((directory) => executionPath(directory, repo, overlay));
	return {
		PATH: [...nodeModules.map((dir) => path.join(dir, ".bin")), process.env.PATH].join(path.delimiter),
		NO_COLOR: "1",
		// So programs can import the extension's own packages, e.g. "@ast-grep/napi". A repository's own
		// node_modules still wins: NODE_PATH is only a fallback.
		NODE_PATH: [...nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
		GIT_OPTIONAL_LOCKS: "0", // read-only git commands should not dirty copied or mounted metadata
		GIT_CONFIG_COUNT: String(count + 1),
		[`GIT_CONFIG_KEY_${count}`]: "core.excludesFile",
		[`GIT_CONFIG_VALUE_${count}`]: excludesFile,
	};
}

/** Maps extension files into the isolated execution copy when the tool is editing its own checkout. */
function executionPath(file: string, repo: string, overlay: Overlay): string {
	const relative = path.relative(repo, file);
	return relative.startsWith("..") || path.isAbsolute(relative) ? file : path.join(overlay.executionDir, relative);
}

/** The patterns in the user's global git excludes file, if they have one. */
async function globalGitExcludes(): Promise<string> {
	const configured = (await $`git config --global --path --get core.excludesFile`.nothrow().quiet().text()).trim();
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
	const file = Bun.file(configured || path.join(xdgConfig, "git", "ignore"));
	return (await file.exists()) ? file.text() : "";
}

/** Files under this transaction's private overlay that any process has open for writing. */
async function filesOpenForWriting(dir: string, forceFailure: boolean): Promise<string[] | null> {
	if (forceFailure) return null;
	// -F an: one field per line. "a" is the access mode (r, w, or u for read/write), "n" the file name.
	// Filter lsof's output by the unique overlay path ourselves. Unlike -g, this includes writers that
	// detached or were reparented; unlike lsof +D, it doesn't walk every file in a large repository.
	// -w drops warnings, such as one about a file system lsof can't stat (a Time Machine network share), which
	// would otherwise count as a failed inspection; real failures still exit nonzero.
	const result = await $`lsof -w -n -P -F an`.nothrow().quiet();
	if (result.exitCode !== 0 || result.stderr.length > 0) return null;
	return parseOpenWriters(result.stdout.toString(), dir);
}

// ── Finding, describing and applying changes ──────────────────────────────────────

/** Compares what the overlay reports with the originals. Only files git sees count. */
async function findChanges(overlay: Overlay): Promise<Change[]> {
	const candidates = (await overlay.changes()).filter(({ file }) => path.basename(file) !== PROGRAM_FILE);
	const ignored = overlay.ignoredPaths
		? new Set(overlay.ignoredPaths)
		: await gitIgnored(
				overlay,
				candidates.map(({ file }) => file),
			);

	const changes: Change[] = [];
	const seen = new Set<string>(); // an overlay may report a file twice, e.g. a deleted directory and the files in it
	for (const { file, entry: after } of candidates) {
		if (ignored.has(file) || seen.has(file)) continue;
		seen.add(file);
		const before = await overlay.original(file);
		if (!before && !after) continue;
		if (entriesEqual(before, after)) continue; // read or copy-up, not changed
		changes.push({ file, before, after });
	}
	return changes.toSorted((a, b) => a.file.localeCompare(b.file));
}

/** Apply the final overlay's ignore policy; Git itself preserves every path already in the index. */
async function gitIgnored(overlay: Overlay, files: string[]): Promise<Set<string>> {
	if (files.length === 0) return new Set();
	const input = new Response(`${files.join("\0")}\0`);
	const command = overlay.wrap(["git", "check-ignore", "-z", "--stdin"], overlay.executionDir);
	const result = await $`${command} < ${input}`.cwd(overlay.executionDir).nothrow().quiet();
	if (result.exitCode > 1) {
		throw new Error(`Could not evaluate final ignore rules: ${result.stderr.toString().trim()}`);
	}
	return new Set(result.stdout.toString().split("\0").filter(Boolean));
}

interface PreparedChange {
	change: Change;
	target: string;
	staged?: string;
	backupDir?: string;
	backup?: string;
	backedUp: boolean;
	backupIdentity?: { dev: number; ino: number; mode: number };
	installed?: { dev: number; ino: number; mode: number };
}

interface CreatedDirectory {
	path: string;
	dev: number;
	ino: number;
}

/** Create missing parents individually, checking existing ancestors without following symlinks. */
async function createParents(repo: string, target: string, created: CreatedDirectory[]): Promise<boolean> {
	if (!(await safeParentChain(repo, target, true))) return false;
	const parts = path.relative(repo, path.dirname(target)).split(path.sep).filter(Boolean);
	let directory = repo;
	for (const part of parts) {
		directory = path.join(directory, part);
		if (!(await safeParentChain(repo, directory))) return false;
		try {
			await fs.mkdir(directory);
			const stats = await fs.lstat(directory);
			created.push({ path: directory, dev: stats.dev, ino: stats.ino });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stats = await fs.lstat(directory);
		if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
	}
	return true;
}

/** Remove only empty, unchanged directories created by this transaction. */
export async function applyChanges(
	repo: string,
	changes: Change[],
	options: { abort: AbortSignal; testHooks?: ApplicationTestHooks },
): Promise<{ applied: Change[]; conflicts: string[]; warnings: string[] }> {
	const created: CreatedDirectory[] = [];
	try {
		return await applyPreparedChanges(repo, changes, options, created);
	} finally {
		for (const directory of created.toReversed()) {
			if (!(await safeParentChain(repo, directory.path))) continue;
			const stats = await fs.lstat(directory.path).catch(() => null);
			if (stats?.isDirectory() && stats.dev === directory.dev && stats.ino === directory.ino) {
				await fs.rmdir(directory.path).catch(() => {});
			}
		}
	}
}

/** Prepares every resource first, then rolls the complete commit back on any failure or conflict. */
async function applyPreparedChanges(
	repo: string,
	changes: Change[],
	options: { abort: AbortSignal; testHooks?: ApplicationTestHooks },
	created: CreatedDirectory[],
): Promise<{ applied: Change[]; conflicts: string[]; warnings: string[] }> {
	const { abort, testHooks = {} } = options;
	const {
		failAfter,
		delayMs,
		delayAfter = 1,
		failAfterBackup,
		beforeCommitDelayMs,
		beforeCommitMarker,
		cleanupFailure,
	} = testHooks;
	const prepared: PreparedChange[] = [];
	try {
		for (const change of changes) {
			const target = path.join(repo, change.file);
			if (
				!(await destinationMatches(repo, change)) ||
				(change.after && !(await createParents(repo, target, created)))
			) {
				await cleanupPrepared(prepared);
				return { applied: [], conflicts: await conflictingFiles(repo, changes), warnings: [] };
			}
			const item: PreparedChange = { change, target, backedUp: false };
			prepared.push(item);

			if (change.after) {
				item.staged = path.join(path.dirname(target), `.pi-shorthand-${randomUUID()}.tmp`);
				if (change.after.type === "file") {
					const handle = await fs.open(item.staged, "wx", change.after.mode);
					try {
						await handle.writeFile(change.after.contents);
						await handle.chmod(change.after.mode);
					} finally {
						await handle.close();
					}
				} else {
					await fs.symlink(change.after.target, item.staged);
				}
			}
			if (change.before) {
				item.backupDir = await fs.mkdtemp(path.join(path.dirname(target), ".pi-shorthand-backup-"));
				item.backup = path.join(item.backupDir, "original");
			}
		}
	} catch (error) {
		await cleanupPrepared(prepared).catch(() => {});
		throw error;
	}
	if (beforeCommitMarker) await Bun.write(beforeCommitMarker, "ready");
	if (beforeCommitDelayMs) await Bun.sleep(beforeCommitDelayMs);

	const committed: PreparedChange[] = [];
	try {
		for (let index = 0; index < prepared.length; index++) {
			const item = prepared[index];
			if (!(await destinationMatches(repo, item.change))) {
				await rollbackApplied(repo, committed);
				const conflicts = await conflictingFiles(repo, changes);
				const warnings = await cleanupWarnings(prepared, cleanupFailure);
				return { applied: [], conflicts, warnings };
			}
			if (index === 0 && abort.aborted) {
				const warnings = await cleanupWarnings(prepared, cleanupFailure);
				return { applied: [], conflicts: [], warnings };
			}

			committed.push(item);
			if (item.backup) {
				const original = await fs.lstat(item.target);
				item.backupIdentity = { dev: original.dev, ino: original.ino, mode: original.mode };
				await fs.rename(item.target, item.backup);
				item.backedUp = true;
			}
			if (failAfterBackup === index + 1) {
				throw new Error(`Injected application failure after backing up change ${index + 1}.`);
			}
			if (item.staged) {
				const installed = await fs.lstat(item.staged);
				await fs.rename(item.staged, item.target);
				item.staged = undefined;
				item.installed = { dev: installed.dev, ino: installed.ino, mode: installed.mode };
			}

			if (failAfter === index + 1) throw new Error(`Injected application failure after ${index + 1} change(s).`);
			if (delayMs && index + 1 === delayAfter) await Bun.sleep(delayMs);
		}
	} catch (error) {
		try {
			await rollbackApplied(repo, committed);
		} catch (rollbackError) {
			await cleanupStaged(prepared).catch(() => {});
			const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
			const combined = new Error(`Applying changes failed and ${detail}`, { cause: error });
			Object.assign(combined, { rollbackCause: rollbackError });
			throw combined;
		}
		await cleanupPrepared(prepared).catch(() => {});
		throw error;
	}

	const warnings = await cleanupWarnings(prepared, cleanupFailure);
	return { applied: changes, conflicts: [], warnings };
}

async function rollbackApplied(repo: string, items: PreparedChange[]) {
	const errors: Error[] = [];
	for (const item of items.toReversed()) {
		try {
			if (item.backedUp && item.backup) {
				const backup = await fs.lstat(item.backup).catch(() => null);
				const backupContentsStillOriginal =
					item.change.before &&
					(await destinationMatches(repo, {
						file: path.relative(repo, item.backup),
						before: item.change.before,
						after: null,
					}));
				if (
					!backup ||
					!item.backupIdentity ||
					backup.dev !== item.backupIdentity.dev ||
					backup.ino !== item.backupIdentity.ino ||
					backup.mode !== item.backupIdentity.mode ||
					!backupContentsStillOriginal
				) {
					throw new Error(
						`Could not safely roll back ${JSON.stringify(item.change.file)}: its backup changed ` +
							`(present=${Boolean(backup)}, identity=${Boolean(item.backupIdentity)}, ` +
							`device=${backup?.dev === item.backupIdentity?.dev}, inode=${backup?.ino === item.backupIdentity?.ino}, ` +
							`mode=${backup?.mode === item.backupIdentity?.mode}, contents=${Boolean(backupContentsStillOriginal)}).`,
					);
				}
			}
			if (item.installed) {
				const current = await fs.lstat(item.target).catch(() => null);
				const contentsStillOurs =
					item.change.after &&
					(await destinationMatches(repo, {
						...item.change,
						before: item.change.after,
					}));
				if (
					!current ||
					current.dev !== item.installed.dev ||
					current.ino !== item.installed.ino ||
					current.mode !== item.installed.mode ||
					!contentsStillOurs
				) {
					throw new Error(`Could not safely roll back ${JSON.stringify(item.change.file)}: its destination changed.`);
				}
				await fs.rm(item.target, { force: true });
				item.installed = undefined;
			}
			if (item.backedUp && item.backup) {
				if (await fs.lstat(item.target).catch(() => null)) {
					throw new Error(`Could not safely restore ${JSON.stringify(item.change.file)}: its destination reappeared.`);
				}
				await fs.rename(item.backup, item.target);
				item.backedUp = false;
			}
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	if (errors.length > 0) {
		const details = errors.map((error) => error.message).join("; ");
		const failure = new Error(`Rollback did not complete: ${details}`, { cause: errors[0] });
		Object.assign(failure, { rollbackErrors: errors });
		throw failure;
	}
}

async function cleanupPrepared(items: PreparedChange[]) {
	await cleanupStaged(items);
	for (const item of items) {
		if (item.backupDir) await fs.rm(item.backupDir, { recursive: true, force: true });
	}
}

async function cleanupStaged(items: PreparedChange[]) {
	for (const item of items) {
		if (item.staged) await fs.rm(item.staged, { force: true });
	}
}

async function cleanupWarnings(items: PreparedChange[], failCleanup = false): Promise<string[]> {
	try {
		if (failCleanup) throw new Error("Injected transaction backup cleanup failure.");
		await cleanupPrepared(items);
		return [];
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const warning = `Changes reached their reported state, but transaction backup cleanup failed: ${detail}`;
		return [warning];
	}
}

/** A change as a git-style patch. */
function describe(file: string, { before, after }: Change): FileChange {
	const kind: FileChange["kind"] = !before ? "added" : !after ? "deleted" : "modified";
	const lines = [`diff --git a/${file} b/${file}`];
	if (kind === "added") lines.push(`new file mode ${gitMode(after!)}`);
	if (kind === "deleted") lines.push(`deleted file mode ${gitMode(before!)}`);
	if (before && after && gitMode(before) !== gitMode(after)) {
		lines.push(`old mode ${gitMode(before)}`, `new mode ${gitMode(after)}`);
	}

	const oldBytes = entryBytes(before);
	const newBytes = entryBytes(after);
	const described = {
		path: file,
		kind,
		beforeType: before?.type,
		afterType: after?.type,
		beforeMode: before?.type === "file" ? before.mode : undefined,
		afterMode: after?.type === "file" ? after.mode : undefined,
	};
	if (isBinary(oldBytes) || isBinary(newBytes)) {
		lines.push("Binary file changed");
		return { ...described, patch: lines.join("\n") };
	}

	lines.push(kind === "added" ? "--- /dev/null" : `--- a/${file}`);
	lines.push(kind === "deleted" ? "+++ /dev/null" : `+++ b/${file}`);
	const oldText = new TextDecoder().decode(oldBytes);
	const newText = new TextDecoder().decode(newBytes);
	for (const hunk of structuredPatch(file, file, oldText, newText, "", "", { context: 3 }).hunks) {
		lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines);
	}
	return { ...described, patch: lines.join("\n") };
}

function gitMode(entry: FilesystemEntry): string {
	return entry.type === "symlink" ? "120000" : (0o100000 | entry.mode).toString(8).padStart(6, "0");
}

function entryBytes(entry: FilesystemEntry | null): Uint8Array {
	if (!entry) return new Uint8Array();
	return entry.type === "file" ? entry.contents : new TextEncoder().encode(entry.target);
}

function isBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

/** dir and each directory above it, up to the root. */
function ancestors(dir: string): string[] {
	const parent = path.dirname(dir);
	return parent === dir ? [dir] : [dir, ...ancestors(parent)];
}

class UnsupportedEntryError extends Error {}

/** Reads one regular file or symlink without following it, rejecting unstable or unsupported entries. */
async function snapshotEntry(file: string): Promise<FilesystemEntry | null> {
	let initial;
	try {
		initial = await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (initial.isSymbolicLink()) {
		const target = await fs.readlink(file);
		const final = await fs.lstat(file).catch(() => null);
		if (!final || !sameIdentity(initial, final))
			throw new Error(`Filesystem entry changed while reading ${JSON.stringify(file)}.`);
		return { type: "symlink", target };
	}
	if (!initial.isFile()) throw new UnsupportedEntryError(`Unsupported filesystem entry at ${JSON.stringify(file)}.`);

	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || !sameIdentity(initial, before)) {
			throw new Error(`Filesystem entry changed while opening ${JSON.stringify(file)}.`);
		}
		const contents = await handle.readFile();
		const after = await handle.stat();
		if (!sameIdentity(before, after))
			throw new Error(`Filesystem entry changed while reading ${JSON.stringify(file)}.`);
		const leaf = await fs.lstat(file).catch(() => null);
		if (!leaf || !sameIdentity(after, leaf))
			throw new Error(`Filesystem entry changed while reading ${JSON.stringify(file)}.`);
		return { type: "file", contents, mode: after.mode & 0o7777 };
	} finally {
		await handle?.close().catch(() => {});
	}
}

function sameIdentity(a: Stats, b: Stats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.mode === b.mode &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs
	);
}

function entriesEqual(a: FilesystemEntry | null, b: FilesystemEntry | null): boolean {
	if (!a || !b) return a === b;
	if (a.type !== b.type) return false;
	if (a.type === "symlink" || b.type === "symlink")
		return a.type === "symlink" && b.type === "symlink" && a.target === b.target;
	return a.mode === b.mode && Buffer.from(a.contents).equals(b.contents);
}

if (import.meta.main) {
	const abort = new AbortController();
	process.on("SIGTERM", () => abort.abort());
	const options: RunOptions = await Bun.stdin.json();
	let diagnostics: Diagnostics | undefined;
	let hasDiagnosticChannel = false;
	try {
		const completed = await withDiagnostics(
			() => run(options, abort.signal),
			(snapshot) => {
				diagnostics = snapshot;
				try {
					writeSync(3, JSON.stringify({ diagnostics: snapshot }) + "\n");
					hasDiagnosticChannel = true;
				} catch {
					/* direct invocation */
				}
			},
		);
		completed.value.diagnostics = completed.diagnostics;
		console.log(JSON.stringify(completed.value));
	} catch (error) {
		console.error(error instanceof OutsideRepositoryError || error instanceof RefusedRunError ? error.message : error);
		if (diagnostics && !hasDiagnosticChannel) console.error(diagnosticLines(diagnostics).join("\n"));
		process.exitCode = 1;
	}
}
