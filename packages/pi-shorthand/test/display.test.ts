/** How results look in Pi, checked as plain text against hand-built results. */

import { beforeAll, describe, expect, test } from "bun:test";
import { highlightCode, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { callLine, resultLines, unstructuredResultText } from "../src/display.ts";
import { Text } from "@earendil-works/pi-tui";
import { FitsScreen, renderCodeResult } from "../src/index.ts";
import type { FileChange, RunResult } from "shorthand-code";

// Plain text: no colours, so the tests read the words and layout.
const theme = {
	name: "dark",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getBgAnsi: () => "\x1b[48;2;40;50;40m",
	getFgAnsi: (color: string) => (color === "toolDiffAdded" ? "\x1b[38;2;181;189;104m" : "\x1b[38;2;204;102;102m"),
} as unknown as Theme;
beforeAll(() => initTheme("dark")); // renderDiff uses Pi's global theme

const change = (path: string, added = 1, removed = 1): FileChange => ({
	path,
	kind: "modified",
	patch: [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${removed} +1,${added} @@`,
		...Array.from({ length: removed }, (_, i) => `-old ${i}`),
		...Array.from({ length: added }, (_, i) => `+new ${i}`),
	].join("\n"),
});

const result = (overrides: Partial<RunResult>): RunResult => ({
	exitCode: 0,
	timedOut: false,
	durationMs: 600,
	output: "",
	warnings: [],
	cleanupWarnings: [],
	changes: [],
	applied: [],
	conflicts: [],
	rolledBack: [],
	writerInspectionFailed: false,
	stillRunning: [],
	timeoutMs: 2000,
	rollback: "all",
	...overrides,
});

const show = (run: RunResult, expanded = false) =>
	resultLines(run, expanded, theme).map((line) => Bun.stripANSI(line).trimEnd());

describe("the verdict", () => {
	test("success", () => {
		const run = result({ changes: [change("a.ts"), change("b.ts")], applied: ["a.ts", "b.ts"] });
		expect(show(run)[0]).toBe("✓ Applied 2 files · +2 −2 · 0.6s");
	});

	test("file lines show mode and type transitions", () => {
		const executable = {
			...change("script"),
			beforeType: "file" as const,
			afterType: "file" as const,
			beforeMode: 0o644,
			afterMode: 0o755,
		};
		const symlink = { ...change("link"), beforeType: "file" as const, afterType: "symlink" as const };
		const lines = show(result({ changes: [executable, symlink], applied: ["script", "link"] }));

		expect(lines).toContain("script (644 → 755) +1 −1");
		expect(lines).toContain("link (file → symlink) +1 −1");
	});

	test("no changes", () => {
		expect(show(result({}))[0]).toBe("✓ No changes · 0.6s");
	});

	test("slow runs show a phase breakdown", () => {
		const lines = show(
			result({
				durationMs: 34_382,
				output: "program output",
				timings: {
					resolveRepositoryMs: 12,
					waitForLockMs: 100,
					workspaceSetupMs: 32_500,
					programMs: 40,
					scanChangesMs: 200,
					formatMs: 1_400,
					workspaceCloseMs: 90,
					checkConflictsMs: 10,
					applyMs: 20,
					renderDiffMs: 10,
					unattributedMs: 0,
				},
			}),
		);
		expect(lines[0]).toBe("✓ No changes · 34.4s");
		expect(lines).toContain("program output");
		expect(lines.at(-1)).toStartWith("timing: workspace setup 32.5s · formatter 1.4s");
	});

	test('a failure with rollback "all" says it rolled back everything', () => {
		const run = result({ exitCode: 1, changes: [change("a.ts")] });
		expect(show(run)[0]).toBe("✕ Failed · rolled back all changes · exit 1 · 0.6s");
	});

	test('a timeout with rollback "file" says what it kept and rolled back', () => {
		const run = result({
			exitCode: null,
			timedOut: true,
			timeoutMs: 1000,
			rollback: "file",
			changes: [change("a.ts"), change("b.ts")],
			applied: ["a.ts"],
			rolledBack: ["b.ts"],
		});
		const lines = show(run);
		expect(lines[0]).toBe("⚠ Program timed out after 1s · kept 1 file, rolled back 1 · +1 −1 · 0.6s");
		expect(lines[1]).toBe("  rolled back b.ts: file edit failed or was interrupted");
	});

	test('a failure with rollback "file" explains why every changed file was rolled back', () => {
		const run = result({
			exitCode: 1,
			rollback: "file",
			changes: [change("a.ts")],
			rolledBack: ["a.ts"],
		});
		const lines = show(run);
		expect(lines[0]).toBe("✕ Failed · nothing to keep · exit 1 · 0.6s");
		expect(lines[1]).toBe("  rolled back a.ts: file edit failed or was interrupted");
	});

	test("a timeout explains when writer inspection failed closed", () => {
		const run = result({
			exitCode: null,
			timedOut: true,
			rollback: "file",
			changes: [change("a.ts")],
			rolledBack: ["a.ts"],
			writerInspectionFailed: true,
		});
		const lines = show(run);
		expect(lines[1]).toBe("  rolled back a.ts: open writers could not be inspected");
	});

	test("caught file errors still show partial application as a warning", () => {
		const run = result({
			rollback: "file",
			changes: [change("a.ts"), change("b.ts")],
			applied: ["a.ts"],
			rolledBack: ["b.ts"],
		});
		const lines = show(run);
		expect(lines[0]).toStartWith("⚠ Failed · kept 1 file, rolled back 1");
		expect(lines[1]).toBe("  rolled back b.ts: file edit failed or was interrupted");
	});

	test("a conflict says nothing was applied and names the changed destination", () => {
		const run = result({ changes: [change("a.ts")], conflicts: ["a.ts"] });
		expect(show(run).slice(0, 2)).toEqual(["✕ Conflict · nothing applied · 0.6s", "  changed while running: a.ts"]);
	});

	test("a conflict preserves a failure or timeout from the program", () => {
		expect(show(result({ exitCode: 2, conflicts: ["a.ts"] }))[0]).toBe("✕ Conflict · nothing applied · exit 2 · 0.6s");
		expect(show(result({ exitCode: null, timedOut: true, timeoutMs: 1000, conflicts: ["a.ts"] }))[0]).toBe(
			"✕ Conflict · nothing applied · timed out after 1s · 0.6s",
		);
	});

	test("a late conflict reports files already applied", () => {
		const run = result({ changes: [change("a.ts"), change("b.ts")], applied: ["a.ts"], conflicts: ["b.ts"] });
		expect(show(run)[0]).toBe("✕ Conflict · 1 file applied · 0.6s");
	});

	test("the call line names a non-default rollback mode and the timeout", () => {
		expect(callLine({ title: "Rename", rollback: "all", timeout: 5 }, theme)).toBe(
			"code Rename (rollback all, program timeout 5s)",
		);
		expect(callLine({ title: "Rename" }, theme)).toBe("code Rename");
		expect(callLine({ title: "Rename", cwd: "child" }, theme)).toBe("code Rename (cwd child)");
	});
});

describe("unstructured completed results", () => {
	test("infrastructure diagnostics appear once in muted text", () => {
		const calls: Array<{ color: string; text: string }> = [];
		const recordingTheme = {
			...theme,
			fg: (color: string, text: string) => {
				calls.push({ color, text });
				return text;
			},
		} as unknown as Theme;
		renderCodeResult(
			{
				content: [],
				details: {
					infrastructureError: "observation failed",
					diagnostics: {
						spans: [{ name: "observer preparation", startMs: 0, durationMs: 23, failed: true }],
						counters: {},
						failurePhase: "creating workspace",
					},
				},
			},
			{ expanded: false, isPartial: false },
			recordingTheme,
		);
		expect(calls.filter((call) => call.color === "error").map((call) => call.text)).toEqual(["observation failed"]);
		expect(calls.filter((call) => call.text.includes("observer preparation"))).toEqual([
			{ color: "muted", text: "  observer preparation: 23ms (failed)" },
		]);
	});

	test("slow startup prints diagnostics even when the runner itself was quick", () => {
		const lines = show(
			result({
				durationMs: 10,
				diagnostics: { spans: [], counters: {}, wallMs: 3010, startupMs: 3000, runnerMs: 10, responseMs: 0 },
			}),
		);
		expect(lines.at(-1)).toContain("runner startup/IPC 3000ms");
	});

	test("show the final infrastructure error instead of pending progress", () => {
		expect(unstructuredResultText([{ type: "text", text: "runner failed: EACCES" }])).toBe("runner failed: EACCES");

		const partial = renderCodeResult(
			{ content: [{ type: "text", text: "running" }], details: { progress: "1.0 s · grep" } },
			{ expanded: false, isPartial: true },
			theme,
		);
		expect(Bun.stripANSI(partial.render(200).join("\n")).trimEnd()).toBe("running… 1.0 s · grep");

		const completed = renderCodeResult(
			{ content: [{ type: "text", text: "runner failed: EACCES" }] },
			{ expanded: false, isPartial: false },
			theme,
		);
		expect(Bun.stripANSI(completed.render(200).join("\n")).trimEnd()).toBe("runner failed: EACCES");

		const empty = renderCodeResult(
			{ content: [{ type: "image", data: "ignored" }] },
			{ expanded: false, isPartial: false },
			theme,
		);
		const emptyText = Bun.stripANSI(empty.render(200).join("\n")).trimEnd();
		expect(emptyText).toBe("Code failed without result details");
		expect(emptyText).not.toContain("running");
	});
});

describe("what went wrong", () => {
	test("a failure shows the error, then the program line it came from", () => {
		const run = result({ exitCode: 1, output: "error: expected 1 match, found 3\n", errorLine: "line 3: throw x;" });
		expect(show(run).slice(0, 3)).toEqual([
			"✕ Failed · no changes · exit 1 · 0.6s",
			"  expected 1 match, found 3",
			"  line 3: throw x;",
		]);
	});

	test("a timeout names the command still running, or else the last step", () => {
		const stuck = result({ exitCode: null, timedOut: true, stillRunning: ["find / -name x (for 2s)"] });
		expect(show(stuck)[1]).toBe("  stuck on $ find / -name x (for 2s)");
		const inCode = result({ exitCode: null, timedOut: true, lastStep: 'grep("x") (3 ms)' });
		expect(show(inCode)[1]).toBe('  last step: grep("x") (3 ms)');
	});

	test("warnings, found before or printed while running, are indented under the verdict", () => {
		const run = result({
			warnings: ["line 1: $`x` isn't awaited"],
			output: "warning: sg.rewrite matched nothing\nhello\n",
		});
		expect(show(run)).toEqual([
			"✓ No changes · 0.6s",
			"  ⚠ line 1: $`x` isn't awaited",
			"  ⚠ sg.rewrite matched nothing",
			"",
			"hello",
		]);
	});
});

describe("sections", () => {
	test("code diffs combine syntax highlighting with colored change gutters", () => {
		const typescript = change("src/example.ts");
		typescript.patch = typescript.patch
			.replace("-old 0", "-export const oldValue = 1;")
			.replace("+new 0", "+export const newValue = 2;");
		const lines = resultLines(result({ changes: [typescript], applied: [typescript.path] }), true, theme);
		const removed = lines.find((line) => Bun.stripANSI(line).includes("-1 export const oldValue"));
		const added = lines.find((line) => Bun.stripANSI(line).includes("+1 export const newValue"));

		expect(removed).toContain(highlightCode("export const oldValue = 1;", "typescript")[0]);
		expect(added).toContain(highlightCode("export const newValue = 2;", "typescript")[0]);
		expect(removed).toContain("\x1b[48;2;");
		expect(added).toContain("\x1b[48;2;");
		expect(removed).toEndWith("\x1b[48;2;40;50;40m");
		expect(added).toEndWith("\x1b[48;2;40;50;40m");

		const indexedTheme = {
			...theme,
			getColorMode: () => "256color",
			getBgAnsi: () => "\x1b[48;5;235m",
			getFgAnsi: (color: string) => (color === "toolDiffAdded" ? "\x1b[38;5;64m" : "\x1b[38;5;124m"),
		} as unknown as Theme;
		const indexed = resultLines(result({ changes: [typescript], applied: [typescript.path] }), true, indexedTheme);
		const indexedAdded = indexed.find((line) => Bun.stripANSI(line).includes("+1 export const newValue"));
		expect(indexedAdded).toStartWith("\x1b[48;5;22m");
		expect(indexedAdded).toEndWith("\x1b[48;5;235m");
	});

	test("output is labelled as the program's when there's also a diff", () => {
		const run = result({ changes: [change("a.ts")], applied: ["a.ts"], output: "done\n" });
		const lines = show(run);
		expect(lines.slice(lines.indexOf("Program output"))).toEqual(["Program output", "done"]);
	});

	test("a diff too tall for the screen collapses to a short list", () => {
		const changes = Array.from({ length: 300 }, (_, i) => change(`f${i}.ts`));
		const run = result({ changes, applied: changes.map((c) => c.path) });
		const fit = new FitsScreen(
			new Text(resultLines(run, false, theme).join("\n"), 0, 0),
			new Text(resultLines(run, false, theme, true).join("\n"), 0, 0),
			() => 50,
		);
		const lines = fit.render(120).map((line) => Bun.stripANSI(line).trimEnd());
		expect(lines[0]).toBe("✓ Applied 300 files · +300 −300 · 0.6s");
		expect(lines).toContain("… and 292 more files");
		expect(lines.length).toBeLessThan(15);
	});

	test("a diff stays whole while it fits on the screen, counting wrapped lines", () => {
		// +10 −5 in five places of one file: over 40 lines once context is included.
		const hunks = [0, 1, 2, 3, 4].flatMap((i) => [
			`@@ -${i * 20 + 1},${i === 4 ? 6 : 7} +${i * 20 + 1},${i === 4 ? 8 : 9} @@`,
			" a",
			" b",
			" c",
			...(i === 4 ? [] : ["-old"]),
			"+new",
			"+new",
			...(i === 4 ? ["-old"] : []),
			" d",
			" e",
			" f",
		]);
		const patch = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", ...hunks].join("\n");
		const run = result({ changes: [{ path: "a.ts", kind: "modified", patch }], applied: ["a.ts"] });
		const fit = (rows: number) =>
			new FitsScreen(
				new Text(resultLines(run, false, theme).join("\n"), 0, 0),
				new Text(resultLines(run, false, theme, true).join("\n"), 0, 0),
				() => rows,
			);
		const whole = fit(60).render(120);
		expect(whole.length).toBeGreaterThan(40);
		expect(whole.join("\n")).not.toContain("to see the diff");
		expect(fit(40).render(120).join("\n")).toContain("to see the diff");
		// The same diff wrapped into a narrow terminal no longer fits in 60 rows.
		expect(fit(60).render(12).length).toBeLessThan(15);
	});

	test("a failure's diff is one line until expanded", () => {
		const run = result({ exitCode: 1, changes: [change("a.ts")] });
		expect(show(run).at(-1)).toMatch(/^Would have changed 1 file · \+1 −1 \(/);
		expect(show(run, true)).toContain("a.ts +1 −1");
	});
});
