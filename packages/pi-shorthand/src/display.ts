/**
 * How a code call looks in Pi. (The model gets a separate plain-text version: see textForModel.)
 *
 * A verdict line first, whose colour carries the outcome. Lines indented under it belong to it: what
 * went wrong, or what to watch out for. A blank line starts a new section. The sections come in the
 * order that matters for the outcome: on success the diff (the point of the tool), then the output;
 * on failure the output, then what would have changed; for an exploration, just the output.
 */

import { getLanguageFromPath, highlightCode, keyHint, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type FileChange,
	type RunResult,
	countLines,
	diagnosticLines,
	fileMetadataSummary,
	timeoutBudgetMs,
	timeoutText,
	timingBreakdown,
} from "shorthand-code";

type ToolBackground = "toolSuccessBg" | "toolErrorBg";

const ANSI_CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const ANSI_GRAY_VALUES = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

const OUTPUT_PREVIEW_LINES = 5; // like Pi's bash tool
const LISTED_FILES = 8; // a diff too tall for the screen lists this many files, then "and N more files"
const EXPANDED_DIFF_LINES = 2000; // even expanded, a diff of hundreds of files stops here

export function callLine(
	args: { title?: string; cwd?: string; timeout?: number; rollback?: string },
	theme: Theme,
): string {
	const settings = [
		args.cwd && `cwd ${args.cwd}`,
		args.rollback === "all" && "rollback all",
		args.timeout && `program timeout ${args.timeout}s`,
	];
	const suffix = settings.filter(Boolean).join(", ");
	return `${theme.fg("toolTitle", theme.bold("code"))} ${args.title ?? ""}${suffix ? theme.fg("muted", ` (${suffix})`) : ""}`;
}

/** Text to show when a completed tool result has no structured RunResult details. */
export function unstructuredResultText(content: readonly unknown[]): string {
	const text = content
		.flatMap((block) =>
			typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block
				? [String(block.text)]
				: [],
		)
		.join("\n")
		.trim();
	return text || "Code failed without result details";
}

/** Lines that belong to the verdict line above them. */
function indent(line: string): string {
	return `  ${line}`;
}

/** `collapseDiff` swaps the applied diff for a list of its files; see FitsScreen for when. */
export function resultLines(run: RunResult, expanded: boolean, theme: Theme, collapseDiff = false): string[] {
	const applied = run.changes.filter((change) => run.applied.includes(change.path));
	const notApplied = run.changes.filter(
		(change) => !run.applied.includes(change.path) && !run.rolledBack.includes(change.path),
	);
	const outputLinesAll = run.output.split("\n");
	const printedWarnings = outputLinesAll.filter((line) => line.startsWith("warning: ")).map((line) => line.slice(9));
	const output = outputLinesAll
		.filter((line) => !line.startsWith("warning: "))
		.join("\n")
		.trim();

	// The verdict, and what belongs to it.
	const lines = [verdict(run, applied, theme)];
	const error = run.exitCode !== 0 && !run.timedOut ? errorMessage(run.output) : undefined;
	if (error) lines.push(indent(theme.fg("error", error)));
	if (error && run.errorLine) lines.push(indent(theme.fg("muted", shorten(run.errorLine, 88))));
	for (const file of run.conflicts) lines.push(indent(theme.fg("error", `changed while running: ${file}`)));
	// A command still running is what it was stuck on; otherwise the last step it logged is a clue.
	for (const command of run.stillRunning) lines.push(indent(theme.fg("warning", `stuck on $ ${command}`)));
	if (run.timedOut && run.stillRunning.length === 0 && run.lastStep) {
		lines.push(indent(theme.fg("warning", `last step: ${run.lastStep}`)));
	}
	for (const file of run.rolledBack) {
		const reason = run.writerInspectionFailed
			? "open writers could not be inspected"
			: "file edit failed or was interrupted";
		lines.push(indent(theme.fg("warning", `rolled back ${file}: ${reason}`)));
	}
	for (const warning of [...run.warnings, ...printedWarnings]) lines.push(indent(theme.fg("warning", `⚠ ${warning}`)));

	// The sections, each after a blank line.
	const sections: string[][] = [];
	const background: ToolBackground =
		run.exitCode === 0 && run.conflicts.length === 0 && run.rolledBack.length === 0 ? "toolSuccessBg" : "toolErrorBg";
	if (applied.length > 0) sections.push(diffLines(applied, collapseDiff && !expanded, theme, background));
	if (output && (expanded || !error)) sections.push(outputLines(output, expanded, run.changes.length > 0, theme));
	if (notApplied.length > 0) sections.push(notAppliedLines(notApplied, expanded, theme, background));
	for (const section of sections) lines.push("", ...section);
	const timing = timingBreakdown(run);
	if (timing) lines.push("", theme.fg("muted", `timing: ${timing}`));
	if (run.diagnostics && ((run.diagnostics.wallMs ?? run.durationMs) >= timeoutBudgetMs(run) || run.exitCode !== 0)) {
		lines.push(...diagnosticLines(run.diagnostics).map((line) => theme.fg("muted", line)));
	}
	return lines;
}

/** e.g. "✓ Applied 3 files · +6 −6 · 0.6s" or "✕ Failed · rolled back all changes · exit 1 · 0.2s" */
function verdict(run: RunResult, applied: FileChange[], theme: Theme): string {
	const muted = (text: string) => theme.fg("muted", text);
	const took = muted(` · ${(run.durationMs / 1000).toFixed(1)}s`);
	const failure = run.timedOut ? `Program timed out after ${timeoutText(run)}` : "Failed";
	const exit = run.timedOut ? "" : muted(` · exit ${run.exitCode}`);

	if (run.conflicts.length > 0) {
		const program = run.timedOut
			? ` · timed out after ${timeoutText(run)}`
			: run.exitCode
				? ` · exit ${run.exitCode}`
				: "";
		const application = applied.length === 0 ? "nothing applied" : `${fileCount(applied)} applied`;
		return theme.fg("error", `✕ Conflict · ${application}${program}`) + took;
	}
	if (run.exitCode === 0 && run.changes.length === 0) return theme.fg("success", "✓ No changes") + took;
	if (run.exitCode === 0 && run.rolledBack.length === 0) {
		return theme.fg("success", `✓ Applied ${fileCount(applied)}`) + ` · ${stats(applied, theme)}` + took;
	}
	if (applied.length > 0) {
		const rolledBack = run.rolledBack.length > 0 ? `, rolled back ${run.rolledBack.length}` : "";
		const kept = theme.fg("warning", `⚠ ${failure} · kept ${fileCount(applied)}${rolledBack}`);
		return kept + ` · ${stats(applied, theme)}` + exit + took;
	}
	const undone =
		run.changes.length === 0 ? "no changes" : run.rollback === "all" ? "rolled back all changes" : "nothing to keep";
	return theme.fg("error", `✕ ${failure} · ${undone}`) + exit + took;
}

/** The error Bun printed, e.g. "expected 1 match, found 3" (or "TypeError: …"). */
function errorMessage(output: string): string | undefined {
	const line = output.split("\n").findLast((candidate) => /^(error|\w*Error): /.test(candidate));
	return line?.replace(/^error: /, "");
}

/** The last few lines, like Pi's bash tool; all of it when expanded. Labelled when not alone. */
function outputLines(output: string, expanded: boolean, labelled: boolean, theme: Theme): string[] {
	const lines = output.split("\n").map((line) => theme.fg("toolOutput", line));
	const label = labelled ? [theme.fg("muted", "Program output")] : [];
	if (expanded || lines.length <= OUTPUT_PREVIEW_LINES) return [...label, ...lines];

	const earlier = lines.length - OUTPUT_PREVIEW_LINES;
	const hint =
		theme.fg("muted", `… ${earlier} earlier lines (`) +
		keyHint("app.tools.expand", "to expand") +
		theme.fg("muted", ")");
	return [...label, hint, ...lines.slice(-OUTPUT_PREVIEW_LINES)];
}

/** Each file's diff under its name, in Pi's own diff style, or when collapsed a list of the files. */
function diffLines(changes: FileChange[], collapse: boolean, theme: Theme, background: ToolBackground): string[] {
	if (collapse) {
		return [...fileList(changes, theme), theme.fg("muted", `(${keyHint("app.tools.expand", "to see the diff")})`)];
	}
	const files = changes.map((change) => [fileLine(change, theme), ...renderFileDiff(change, theme, background)]);
	const lines = files.flatMap((file, index) => (index === 0 ? file : ["", ...file]));
	if (lines.length <= EXPANDED_DIFF_LINES) return lines;
	const more = lines.length - EXPANDED_DIFF_LINES;
	return [...lines.slice(0, EXPANDED_DIFF_LINES), theme.fg("muted", `… ${more} more lines of diff`)];
}

function renderFileDiff(change: FileChange, theme: Theme, background: ToolBackground): string[] {
	const diff = toPiDiff(change.patch);
	const language = getLanguageFromPath(change.path);
	if (!language || diff === " binary file changed") return renderDiff(diff).split("\n");

	const rendered: string[] = [];
	let hunk: string[] = [];
	const flush = () => {
		if (hunk.length > 0) rendered.push(...renderSyntaxHunk(hunk, language, theme, background));
		hunk = [];
	};
	for (const line of diff.split("\n")) {
		if (/^\s+\.\.\.$/.test(line)) {
			flush();
			rendered.push(theme.fg("toolDiffContext", line));
		} else {
			hunk.push(line);
		}
	}
	flush();
	return rendered;
}

function renderSyntaxHunk(lines: string[], language: string, theme: Theme, background: ToolBackground): string[] {
	const parsed = lines.map((line) => {
		const match = line.match(/^([+\- ])(\s*\d*) (.*)$/);
		return match ? { prefix: match[1], number: match[2], code: match[3] } : undefined;
	});
	const oldLines = parsed.flatMap((line) => (line && line.prefix !== "+" ? [line.code] : []));
	const newLines = parsed.flatMap((line) => (line && line.prefix !== "-" ? [line.code] : []));
	const oldHighlighted = highlightCode(oldLines.join("\n"), language);
	const newHighlighted = highlightCode(newLines.join("\n"), language);
	let oldIndex = 0;
	let newIndex = 0;

	return parsed.map((line, index) => {
		if (!line) return theme.fg("toolDiffContext", lines[index]);
		if (line.prefix === "-") {
			const content = theme.fg("toolDiffRemoved", `-${line.number} `) + oldHighlighted[oldIndex++];
			return tintedDiffLine(content, "toolDiffRemoved", background, theme);
		}
		if (line.prefix === "+") {
			const content = theme.fg("toolDiffAdded", `+${line.number} `) + newHighlighted[newIndex++];
			return tintedDiffLine(content, "toolDiffAdded", background, theme);
		}
		oldIndex++;
		return theme.fg("toolDiffContext", ` ${line.number} `) + newHighlighted[newIndex++];
	});
}

function tintedDiffLine(
	line: string,
	changeColor: "toolDiffAdded" | "toolDiffRemoved",
	baseBackground: ToolBackground,
	theme: Theme,
): string {
	const base = ansiRgb(theme.getBgAnsi(baseBackground));
	const change = ansiRgb(theme.getFgAnsi(changeColor));
	if (!base || !change) return line;
	const [red, green, blue] = base.map((channel, index) => Math.round(channel * 0.86 + change[index] * 0.14));
	const background =
		theme.getColorMode() === "truecolor"
			? `\x1b[48;2;${red};${green};${blue}m`
			: `\x1b[48;5;${ansi256(red, green, blue)}m`;
	return `${background}${line}${theme.getBgAnsi(baseBackground)}`;
}

function ansiRgb(code: string): [number, number, number] | undefined {
	const truecolor = code.match(/\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	const indexed = code.match(/\[(?:38|48);5;(\d+)m/);
	return indexed ? rgbFromAnsi256(Number(indexed[1])) : undefined;
}

function rgbFromAnsi256(index: number): [number, number, number] | undefined {
	if (index < 0 || index > 255) return undefined;
	if (index < 16) {
		const palette = [
			[0, 0, 0],
			[128, 0, 0],
			[0, 128, 0],
			[128, 128, 0],
			[0, 0, 128],
			[128, 0, 128],
			[0, 128, 128],
			[192, 192, 192],
			[128, 128, 128],
			[255, 0, 0],
			[0, 255, 0],
			[255, 255, 0],
			[0, 0, 255],
			[255, 0, 255],
			[0, 255, 255],
			[255, 255, 255],
		] as const;
		return [...palette[index]];
	}
	if (index >= 232) {
		const gray = 8 + (index - 232) * 10;
		return [gray, gray, gray];
	}
	const cube = index - 16;
	return [
		ansiCubeChannel(Math.floor(cube / 36)),
		ansiCubeChannel(Math.floor((cube % 36) / 6)),
		ansiCubeChannel(cube % 6),
	];
}

function ansiCubeChannel(value: number): number {
	return value === 0 ? 0 : 55 + value * 40;
}

function ansi256(red: number, green: number, blue: number): number {
	const [redIndex, greenIndex, blueIndex] = [red, green, blue].map((channel) =>
		closestIndex(channel, ANSI_CUBE_VALUES),
	);
	const cube = [ANSI_CUBE_VALUES[redIndex], ANSI_CUBE_VALUES[greenIndex], ANSI_CUBE_VALUES[blueIndex]];
	const cubeIndex = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;
	const cubeDistance = colorDistance([red, green, blue], cube);

	const luminance = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
	const grayOffset = closestIndex(luminance, ANSI_GRAY_VALUES);
	const gray = ANSI_GRAY_VALUES[grayOffset];
	const grayDistance = colorDistance([red, green, blue], [gray, gray, gray]);
	const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
	return spread < 10 && grayDistance < cubeDistance ? 232 + grayOffset : cubeIndex;
}

function closestIndex(value: number, choices: number[]): number {
	let closest = 0;
	for (let index = 1; index < choices.length; index++) {
		if (Math.abs(value - choices[index]) < Math.abs(value - choices[closest])) closest = index;
	}
	return closest;
}

function colorDistance(first: number[], second: number[]): number {
	return (
		(first[0] - second[0]) ** 2 * 0.299 + (first[1] - second[1]) ** 2 * 0.587 + (first[2] - second[2]) ** 2 * 0.114
	);
}

function notAppliedLines(changes: FileChange[], expanded: boolean, theme: Theme, background: ToolBackground): string[] {
	const heading = theme.fg("muted", `Would have changed ${fileCount(changes)} · `) + stats(changes, theme);
	if (expanded) return [heading, "", ...diffLines(changes, false, theme, background)];
	return [heading + theme.fg("muted", ` (${keyHint("app.tools.expand", "to see the diff")})`)];
}

/** The first few files, then how many more. */
function fileList(changes: FileChange[], theme: Theme): string[] {
	const listed = changes.slice(0, LISTED_FILES).map((change) => fileLine(change, theme));
	const more = changes.length - LISTED_FILES;
	return more > 0 ? [...listed, theme.fg("muted", `… and ${more} more files`)] : listed;
}

/** e.g. "src/a.ts +3 −1", or "src/new.ts (new) +12 −0" */
function fileLine(change: FileChange, theme: Theme): string {
	const kind = change.kind === "modified" ? "" : theme.fg("muted", change.kind === "added" ? " (new)" : " (deleted)");
	const metadata = fileMetadataSummary(change);
	return `${theme.fg("accent", change.path)}${kind}${metadata ? theme.fg("muted", ` (${metadata})`) : ""} ${stats([change], theme)}`;
}

/** "+6 −2", in the diff colours. */
function stats(changes: FileChange[], theme: Theme): string {
	const counts = changes.map((change) => countLines(change.patch));
	const additions = counts.reduce((sum, count) => sum + count.additions, 0);
	const deletions = counts.reduce((sum, count) => sum + count.deletions, 0);
	return `${theme.fg("toolDiffAdded", `+${additions}`)} ${theme.fg("toolDiffRemoved", `−${deletions}`)}`;
}

/** Cut to fit on one line, since a wrapped line loses its indentation. The full text is in the output. */
function shorten(text: string, length: number): string {
	return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function fileCount(changes: FileChange[]): string {
	return changes.length === 1 ? "1 file" : `${changes.length} files`;
}

/**
 * Converts a git-style patch to the format Pi's renderDiff reads: "+12 added", "-12 removed",
 * " 12 context", and "     ..." between hunks. Removed and context lines use old line numbers.
 */
function toPiDiff(patch: string): string {
	if (patch.includes("\nBinary file changed")) return " binary file changed";
	const lastLines = [...patch.matchAll(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/gm)].flatMap((hunk) => [
		Number(hunk[1]) + Number(hunk[2]),
		Number(hunk[3]) + Number(hunk[4]),
	]);
	const width = String(Math.max(1, ...lastLines)).length;
	const number = (n: number | string) => String(n).padStart(width, " ");

	const out: string[] = [];
	let inHunks = false; // skips the headers before the first hunk
	let oldLine = 0;
	let newLine = 0;
	for (const line of patch.split("\n")) {
		const hunk = line.match(/^@@ -(\d+),\d+ \+(\d+),\d+ @@/);
		if (hunk) {
			if (inHunks) out.push(` ${number("")} ...`);
			inHunks = true;
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
		} else if (!inHunks) {
			continue;
		} else if (line.startsWith("+")) {
			out.push(`+${number(newLine++)} ${line.slice(1)}`);
		} else if (line.startsWith("-")) {
			out.push(`-${number(oldLine++)} ${line.slice(1)}`);
		} else if (line.startsWith(" ")) {
			out.push(` ${number(oldLine++)} ${line.slice(1)}`);
			newLine++;
		}
	}
	return out.join("\n");
}
