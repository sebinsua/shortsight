/**
 * What the model reads after a run: a summary line, the files, any warnings, then the output and diff.
 * Callers pass their own truncation limits; Pi passes its standard tool-output ones.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { FileChange, RunResult } from "../runner/runner.ts";
import { diagnosticLines } from "../runner/diagnostics.ts";
import { modelDiff } from "./model-diff.ts";
import { countLines, fileMetadataSummary, timeoutBudgetMs, timingBreakdown } from "./run-summary.ts";

/** e.g. "✓ exit 0 · 326 ms · 6 files · +48 −17 · applied" */
function summaryLine(run: RunResult): string {
	const parts = [];
	parts.push(run.timedOut ? "timed out" : `exit ${run.exitCode}`);
	if (run.conflicts.length > 0) parts.push("conflict");
	parts.push(`${run.durationMs} ms`);

	if (run.changes.length === 0) {
		parts.push("no changes");
	} else {
		const counts = run.changes.map((change) => countLines(change.patch));
		const additions = counts.reduce((sum, count) => sum + count.additions, 0);
		const deletions = counts.reduce((sum, count) => sum + count.deletions, 0);
		const files = run.changes.length === 1 ? "1 file" : `${run.changes.length} files`;
		parts.push(`${files} · +${additions} −${deletions}`);

		if (run.applied.length === run.changes.length) parts.push("applied");
		else if (run.applied.length === 0) parts.push("NOT applied");
		else parts.push(`${run.applied.length} of ${run.changes.length} applied`);
	}
	return `${run.exitCode === 0 && run.conflicts.length === 0 ? "✓" : "✕"} ${parts.join(" · ")}`;
}

/** e.g. "  M src/a.ts +3 −1" */
function fileLine(change: FileChange): string {
	const letter = { added: "A", modified: "M", deleted: "D" }[change.kind];
	const { additions, deletions } = countLines(change.patch);
	const metadata = fileMetadataSummary(change);
	return `  ${letter} ${change.path}${metadata ? ` (${metadata})` : ""} +${additions} −${deletions}`;
}

/** Cuts text to the caller's limits, keeping its start (head) or end (tail) and saying how much it kept. */
export type Truncate = (content: string) => {
	content: string;
	truncated: boolean;
	outputLines: number;
	totalLines: number;
};

export interface ModelTextOptions {
	/** Base name of the temporary files that hold a full output or diff when the text shows only part of it. */
	name: string;
	truncateHead: Truncate;
	truncateTail: Truncate;
}

/** The plain-text result the model reads after a run. */
export function textForModel(run: RunResult, options: ModelTextOptions): string {
	const lines = [summaryLine(run)];
	const timing = timingBreakdown(run);
	if (timing) lines.push(`Timing: ${timing}`);

	if (run.applied.length === 0 && run.changes.length > 0) {
		lines.push("The real workspace is unchanged. Below is the candidate diff.");
	}
	if (run.conflicts.length > 0) lines.push(`Changed while the program ran: ${run.conflicts.join(", ")}`);
	for (const change of run.changes) lines.push(fileLine(change));
	for (const warning of run.warnings) lines.push(`warning: ${warning}`);
	if (run.rolledBack.length > 0) {
		const reason = run.writerInspectionFailed
			? "open writers could not be inspected at the timeout"
			: run.timedOut
				? "they were half-written when the program was killed"
				: "finished writes could not be identified after the program exited";
		lines.push(`Rolled back, because ${reason}: ${run.rolledBack.join(", ")}`);
	}
	if (run.stillRunning.length > 0) {
		lines.push("Still running when it was killed:", ...run.stillRunning.map((command) => `  ${command}`));
	} else if (run.lastStep) {
		lines.push(`Its last logged step before the timeout: ${run.lastStep}`);
	}

	const output = outputForModel(run, options);
	const diff = diffForModel(run, options);

	// On failure the error goes last, where it's easiest to find; on success, the diff does.
	if (run.exitCode === 0 && run.conflicts.length === 0) lines.push(...output, ...diff);
	else lines.push(...diff, ...output);
	// Timing explains a timeout or a slow run; an ordinary error in the program is about its code.
	if (run.diagnostics && (run.timedOut || (run.diagnostics.wallMs ?? run.durationMs) >= timeoutBudgetMs(run)))
		lines.push("", ...diagnosticLines(run.diagnostics));
	return lines.join("\n");
}

/** The program's output, within the caller's limits for tool output. Says so if anything was cut. */
function outputForModel(run: RunResult, { name, truncateTail }: ModelTextOptions): string[] {
	const output = run.output.trim();
	if (!output) return [];

	const truncated = truncateTail(output);
	if (!truncated.truncated) return ["", "output:", output];

	const fullOutputPath = path.join(tmpdir(), `${name}.output`);
	writeFileSync(fullOutputPath, output);
	const notice = `[output truncated: the last ${truncated.outputLines} of ${truncated.totalLines} lines; full output: ${fullOutputPath}]`;
	return ["", "output:", notice, truncated.content];
}

function diffForModel(run: RunResult, { name, truncateHead }: ModelTextOptions): string[] {
	const diff = run.changes.map((change) => change.patch).join("\n");
	if (!diff) return [];

	// A large diff is shown as one example of each distinct change, then cut to the caller's limits.
	const shown = modelDiff(run.changes);
	const truncated = truncateHead(shown.text);
	const lines = ["", truncated.content];
	if (shown.summarized || truncated.truncated) {
		const fullDiffPath = path.join(tmpdir(), `${name}.diff`);
		writeFileSync(fullDiffPath, diff);
		lines.push(
			truncated.truncated
				? `[diff truncated at ${truncated.outputLines} of ${truncated.totalLines} lines; full diff: ${fullDiffPath}]`
				: `[full diff: ${fullDiffPath}]`,
		);
	}
	return lines;
}
