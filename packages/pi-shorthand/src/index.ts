/**
 * The `shorthand` tool: the model writes one Bun program that makes a multi-step change to the repository.
 * Its writes go to a copy-on-write overlay; if it succeeds, they're applied and the diff is returned.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type Theme, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_TIMEOUT_SECONDS,
	type Diagnostics,
	type RunResult,
	RunnerError,
	diagnosticLines,
	runFailed,
	runWithBun,
	sightreadAvailable,
	textForModel,
} from "shorthand-code";
import { callLine, resultLines, unstructuredResultText } from "./display.ts";

const DESCRIPTION = `Edit repository files with a TypeScript program run by Bun. Best for changes across many files, repeated edits and semantic TypeScript renames or moves; a small change to one file is quicker as a direct edit. Top-level await and ordinary Bun/Node APIs work. Use repository-relative paths. Only edits files inside a git repository; use edit or write for anything else. Set cwd to a checkout path when Pi's working directory is outside the repository, such as a child worktree in a bare worktree container. The program runs in an isolated workspace; changes apply on successful exit by default and the tool reports the diff. Tests, type-checks and builds belong outside the program: in a shell call, or, when a codemode script calls shorthand, later in that script.

Common operations:
- edit({ path, oldText, newText }) replaces exactly one literal occurrence; missing or ambiguous text is an error. Use text edits for known source, structural matching when it saves enumerating occurrences or preserves varying syntax.
- await Bun.file(path).text(); await Bun.write(path, text)
- sg.rewrite(pattern, replacement, files?) discovers and rewrites matching code; omit files for the working directory. $X captures one node; $$$X captures a sequence.
- sg.one(pattern, files?) selects exactly one match; sg.find returns an array. sg.rewrite also accepts a selected match or array without a file scope.
- A rewrite callback receives a match and returns text, a native node.replace(text) edit, or null to skip. Return native edits to apply them. Pass selected arrays together for independent edits; select again after changing their file.
- await refactor.rename({ file, symbol, to }) renames one resolved TypeScript symbol across the project without changing unrelated names.
- await refactor.references({ file, symbol }) returns resolved identifier matches that pass straight to sg.rewrite(matches, callback).
- await refactor.renameFile({ from, to }) moves a TypeScript file and updates module paths that resolve to it.
- await refactor.move({ file, symbol, to }) moves a top-level declaration to another file and updates the imports that follow it.

See the shorthand skill for renames, moves and call-site migrations. Read its advanced-refactors.md guide only to extract code, move syntax or use rule objects. The default timeout is five seconds; request more for longer programs. Time spent inside the helpers above does not count toward it, up to 60 extra seconds.`;

const GRAPH_DESCRIPTION =
	"- await graph.query(request | request[]) queries symbols and relationships; graph results can be passed to sg as scope. The graph shows the repository before this program's edits.\n";

export const SKILLS_DIRECTORY = path.join(
	path.dirname(createRequire(import.meta.url).resolve("shorthand-code/package.json")),
	"skills",
);

export function shorthandDescription(graphAvailable: boolean): string {
	return graphAvailable
		? DESCRIPTION.replace("\n\nSee the shorthand skill", `\n${GRAPH_DESCRIPTION}\nSee the shorthand skill`)
		: DESCRIPTION;
}

const paths = (description: string) => Type.Array(Type.String(), { description });

/**
 * What a script gets back from `shorthand`, for example one run by Pi's codemode tool. The model still sees the text.
 * A failed run resolves to this too, so a script checks `exitCode`.
 */
export const SHORTHAND_OUTPUT_SCHEMA = Type.Object({
	exitCode: Type.Optional(
		Type.Union([Type.Number(), Type.Null()], { description: "0 on success; null when the program was killed" }),
	),
	timedOut: Type.Optional(Type.Boolean()),
	output: Type.Optional(Type.String({ description: "The program's stdout and stderr" })),
	errorLine: Type.Optional(Type.String({ description: "On failure, the program line the error came from" })),
	warnings: Type.Optional(Type.Array(Type.String(), { description: "Likely mistakes spotted before it ran" })),
	changes: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.String(),
				kind: StringEnum(["added", "modified", "deleted"] as const),
				patch: Type.String(),
			}),
		),
	),
	applied: Type.Optional(paths("Changed files written to the repository")),
	conflicts: Type.Optional(paths("Files that changed outside the run while it ran; if any, nothing was applied")),
	rolledBack: Type.Optional(paths("Changed files not kept after a failure")),
	infrastructureError: Type.Optional(Type.String({ description: "Set, alone, when the program couldn't be run" })),
});

export function shorthandOutput(result: RunResult) {
	const { exitCode, timedOut, output, errorLine, warnings, applied, conflicts, rolledBack } = result;
	const changes = result.changes.map((change) => ({ path: change.path, kind: change.kind, patch: change.patch }));
	return {
		exitCode,
		timedOut,
		output,
		...(errorLine === undefined ? {} : { errorLine }),
		warnings,
		changes,
		applied,
		conflicts,
		rolledBack,
	};
}

/**
 * Base name of the temporary files that hold a large run's full diff or output. A call a codemode script makes has
 * an id like `<parent id>/1`, and ids can hold `|`, so anything but a safe file-name character is replaced.
 */
export function spillName(toolCallId: string): string {
	return `pi-shorthand-${toolCallId.replace(/[^\w.-]/g, "_")}`;
}

export default async function (pi: ExtensionAPI, findGraph: () => Promise<unknown> = sightreadAvailable) {
	// The shorthand skill ships with shorthand-code, whose `shorthand --skill` prints it for other agents.
	pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIRECTORY] }));
	const graphAvailable = Boolean(await findGraph());
	// A failed run is an error, both for the model and for how Pi shows it. (execute() returns its details
	// rather than throwing, since a thrown error loses them.)
	pi.on("tool_result", async (event) => {
		const run = event.details as RunResult | undefined;
		if (event.toolName === "shorthand" && run && runFailed(run)) return { isError: true };
	});

	pi.registerTool({
		name: "shorthand",
		label: "Shorthand",
		description: shorthandDescription(graphAvailable),
		promptSnippet:
			"Make multi-file, repetitive or rename/move changes with one Bun program; a small change to one file is quicker as a direct edit. Keep verification outside the program",

		parameters: Type.Object({
			title: Type.String({ description: "A few words describing the change, shown to the user" }),
			program: Type.String({ description: "TypeScript program run with Bun (top-level await allowed)" }),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the program; relative to Pi's working directory, or an absolute path. Defaults to Pi's working directory. Must be inside a git worktree.",
				}),
			),
			rollback: Type.Optional(
				StringEnum(["all", "file"] as const, {
					description:
						'On failure: "file" (default) rolls back failed or interrupted file edits and retains the others; "all" applies nothing',
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Seconds of program time before it is killed (default 2); time inside helpers is excluded",
				}),
			),
		}),
		outputSchema: SHORTHAND_OUTPUT_SCHEMA,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// While it runs, show how long it's been going and the latest reported step.
			const startedAt = Date.now();
			let latest: string | undefined;
			const progress = setInterval(() => {
				const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
				onUpdate?.({
					content: [{ type: "text", text: "running" }],
					details: { progress: latest ? `${elapsed} · ${latest}` : elapsed },
				});
			}, 500);

			let result: RunResult;
			try {
				result = await runWithBun(
					{
						cwd: path.resolve(ctx.cwd, params.cwd ?? "."),
						program: params.program,
						timeoutMs: (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
						rollback: params.rollback ?? "file",
						graph: graphAvailable,
					},
					signal,
					(step) => (latest = step),
				);
			} catch (error) {
				if (!(error instanceof RunnerError)) throw error;
				return {
					isError: true,
					content: [{ type: "text" as const, text: [error.message, ...diagnosticLines(error.diagnostics)].join("\n") }],
					details: { infrastructureError: error.message, diagnostics: error.diagnostics },
					structuredContent: { infrastructureError: error.message },
				};
			} finally {
				clearInterval(progress);
			}
			return {
				content: [
					{
						type: "text",
						text: textForModel(result, { name: spillName(toolCallId), truncateHead, truncateTail }),
					},
				],
				details: result,
				structuredContent: shorthandOutput(result),
			};
		},

		renderCall(args, theme) {
			return new Text(callLine(args, theme), 0, 0);
		},

		renderResult(result, options, theme) {
			return renderShorthandResult(result, options, theme);
		},
	});
}

export function renderShorthandResult(
	result: { content: readonly unknown[]; details?: unknown },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Component {
	if (isPartial) {
		const progress = (result.details as { progress?: string } | undefined)?.progress;
		return new Text(theme.fg("muted", progress ? `running… ${progress}` : "running…"), 0, 0);
	}
	if (result.details && typeof result.details === "object" && "infrastructureError" in result.details) {
		const failure = result.details as { infrastructureError: string; diagnostics: Diagnostics };
		return new Text(
			[
				theme.fg("error", failure.infrastructureError),
				"",
				...diagnosticLines(failure.diagnostics).map((line) => theme.fg("muted", line)),
			].join("\n"),
			0,
			0,
		);
	}
	const run = result.details as RunResult | undefined;
	if (!run) return new Text(theme.fg("error", unstructuredResultText(result.content)), 0, 0);
	const full = new Text(resultLines(run, expanded, theme).join("\n"), 0, 0);
	if (expanded) return full;
	return new FitsScreen(full, new Text(resultLines(run, false, theme, true).join("\n"), 0, 0));
}

/** Rows Pi keeps for itself below a tool result: the editor, its borders and the footer. */
const PI_CHROME_ROWS = 8;

/**
 * Shows the whole result while it fits on screen once wrapped, like Pi's edit tool, and otherwise the version
 * with the diff collapsed to a list of files. Measured on each render, so resizing the terminal is followed.
 */
export class FitsScreen implements Component {
	constructor(
		private readonly full: Component,
		private readonly collapsed: Component,
		private readonly rows = () => process.stdout.rows || 24,
	) {}

	render(width: number): string[] {
		const lines = this.full.render(width);
		return lines.length <= this.rows() - PI_CHROME_ROWS ? lines : this.collapsed.render(width);
	}

	invalidate(): void {
		this.full.invalidate();
		this.collapsed.invalidate();
	}
}
