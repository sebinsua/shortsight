import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { roundAttempts, roundColumns, roundRows } from "../round.ts";
import { endMarker, problems, renderTable, startMarker } from "../table.ts";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every attempt of a complete round, passing in 30s, except Shorthand, which passes in 20s. */
function completeRound() {
	return roundRows.flatMap((row) => [
		{ kind: "experiment" as const, taskId: row.task, promptStyle: row.prompt },
		...roundColumns.flatMap((column) =>
			Array.from({ length: roundAttempts }, (_, attempt) => ({
				kind: "run" as const,
				taskId: row.task,
				promptStyle: row.prompt,
				setup: column.setup,
				sightread: column.sightread,
				skill: column.setup === "code" ? "shorthand" : "none",
				documentation: "shipped",
				model: "openai-codex/gpt-5.6-sol",
				reasoning: "high",
				name: `2026-09-28T21-0${attempt}-00-000Z-${column.setup}`,
				seconds: column.setup === "code" && column.sightread === "off" ? 20 : 30,
				verified: true,
				providerError: null,
				extension: column.setup === "code" ? { revision: "abc", dirty: [] } : null,
			})),
		),
	]);
}

test("a complete round renders one row per task and prompt, bolding the fastest setup", () => {
	const records = completeRound();
	expect(problems(records)).toEqual([]);
	const table = renderTable(records);
	expect(table).toStartWith("Measured on 28 September 2026 with `gpt-5.6-sol` (high reasoning), 2 attempts per setup.");
	expect(table).toContain("| `rename-symbol` | brief | 100 | 30s | 30s | **20s** | 30s |");
	expect(table).toContain("| `empty-average` | outcome | 1 |");
	expect(table.split("\n").filter((line) => line.startsWith("| `"))).toHaveLength(roundRows.length);
});

test("a round missing an attempt, or with one the provider ended, is refused with each gap named", () => {
	const records = completeRound();
	records.splice(
		records.findIndex((record) => record.kind === "run" && record.sightread === "on"),
		1,
	);
	const ended = records.find((record) => record.kind === "run" && record.setup === "code")!;
	Object.assign(ended, { providerError: "OAuth refresh failed" });
	expect(problems(records)).toEqual([
		"rename-symbol-100 (brief), Stock + sightread: 1 attempts, not 2",
		"rename-symbol-100 (brief), Shorthand: 1 ended by the model provider, so measured nothing",
	]);
});

test("a round is refused if a task didn't finish, or the code was uncommitted or mixed", () => {
	const records = completeRound().filter(
		(record) => !(record.kind === "experiment" && record.taskId === "empty-average"),
	);
	const shorthand = records.filter((record) => record.kind === "run" && record.setup === "code");
	Object.assign(shorthand[0]!, { extension: { revision: "def", dirty: ["e2e/run.ts"] } });
	expect(problems(records)).toEqual([
		"empty-average (outcome): not run, or didn't finish",
		'attempts differ in code revision: "def", "abc"',
		"some attempts ran uncommitted code; commit it and run the round again",
	]);
});

test("a failed attempt shows in its cell rather than disappearing from the average", () => {
	const records = completeRound();
	const stock = records.filter(
		(record) => record.kind === "run" && record.setup === "baseline" && record.sightread === "off",
	);
	Object.assign(stock[0]!, { verified: false });
	Object.assign(stock[1]!, { verified: false });
	Object.assign(stock[3]!, { verified: false });
	const table = renderTable(records);
	expect(table).toContain("| `rename-symbol` | brief | 100 | failed |");
	expect(table).toContain("| `rename-symbol` | outcome | 100 | 30s (1 of 2) |");
});

test("the table is written between the README's markers and refused for a partial round", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-table-test-"));
	temporary.push(root);
	const readme = path.join(root, "README.md");
	await writeFile(readme, `# Results\n\nBefore.\n\n${startMarker}\n\nold table\n\n${endMarker}\n\nAfter.\n`);
	const records = completeRound();
	await writeFile(path.join(root, "summary.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
	const table = (args: string[]) =>
		Bun.spawn(["bun", path.resolve("e2e/table.ts"), root, ...args], { stdout: "pipe", stderr: "pipe" });
	const written = table(["--write", readme]);
	expect(await written.exited).toBe(0);
	const text = await readFile(readme, "utf8");
	expect(text).not.toContain("old table");
	expect(text).toContain("Before.");
	expect(text).toContain("After.");
	expect(text).toContain("Measured on 28 September 2026");

	await writeFile(
		path.join(root, "summary.jsonl"),
		records
			.slice(1)
			.map((record) => JSON.stringify(record))
			.join("\n") + "\n",
	);
	await writeFile(readme, `${startMarker}\n\nold table\n\n${endMarker}\n`);
	const refused = table(["--write", readme]);
	const [exit, stderr] = await Promise.all([refused.exited, new Response(refused.stderr).text()]);
	expect(exit).toBe(1);
	expect(stderr).toContain("rename-symbol-100 (brief): not run, or didn't finish");
	expect(await readFile(readme, "utf8")).toContain("old table");
});

test("a round can't be narrowed or changed from the command line", async () => {
	const child = Bun.spawn(["bun", path.resolve("e2e/suite.ts"), "--round", "--tasks", "empty-average", "--runs", "1"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(exit).not.toBe(0);
	expect(stderr).toContain("--round runs every task in every setup; drop --tasks, --runs");
});
