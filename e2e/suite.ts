import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { materializeTask, promptFor, suites, taskById, type PromptStyle, type Suite, type Task } from "./tasks.ts";
import { parseSetups, parseSightread } from "./conditions.ts";
import { roundOptions, roundRows } from "./round.ts";

const { values, tokens } = parseArgs({
	tokens: true,
	options: {
		execute: { type: "boolean", default: false },
		round: { type: "boolean", default: false },
		suite: { type: "string", default: "pilot" },
		tasks: { type: "string" },
		prompts: { type: "string", default: "outcome" },
		setups: { type: "string", default: "baseline,replace,code" },
		documentation: { type: "string", default: "shipped" },
		skills: { type: "string", default: "none" },
		sightread: { type: "string", default: "off" },
		runs: { type: "string", default: "3" },
		model: { type: "string", default: "anthropic/claude-sonnet-4-6" },
		reasoning: { type: "string", default: "high" },
		"budget-seconds": { type: "string", default: "600" },
		"budget-dollars": { type: "string" },
		"results-dir": { type: "string" },
	},
});

let pairs: [Task, PromptStyle][];
if (values.round) {
	// A round is the whole table, so nothing that narrows or changes it may be passed alongside.
	const fixed = ["suite", "tasks", "prompts", ...Object.keys(roundOptions)];
	const given = tokens.flatMap((token) =>
		token.kind === "option" && fixed.includes(token.name) ? [`--${token.name}`] : [],
	);
	if (given.length) throw new Error(`--round runs every task in every setup; drop ${given.join(", ")}`);
	Object.assign(values, roundOptions);
	values["results-dir"] ??= path.join(import.meta.dir, "results", `round-${new Date().toISOString().slice(0, 10)}`);
	const results = values["results-dir"]!;
	if (values.execute && existsSync(results) && readdirSync(results).length)
		throw new Error(`${results} already has results; a round needs an empty directory of its own`);
	pairs = roundRows.map((row) => [taskById(row.task), row.prompt]);
} else {
	if (!Object.hasOwn(suites, values.suite!))
		throw new Error(`--suite must be one of ${Object.keys(suites).join(", ")}`);
	// Explicit task IDs may come from any suite.
	const selected = values.tasks ? values.tasks.split(",").map(taskById) : suites[values.suite as Suite];
	const prompts = values.prompts!.split(",") as PromptStyle[];
	if (!prompts.length || prompts.some((style) => style !== "outcome" && style !== "brief"))
		throw new Error("--prompts must be outcome and/or brief");
	pairs = selected.flatMap((task) => prompts.map((style): [Task, PromptStyle] => [task, style]));
}
// Fail before any model call if a selected task has no brief.
for (const [task, style] of pairs) promptFor(task, style);
const setups = parseSetups(values.setups!);
const sightread = parseSightread(values.sightread!);
if (!Number.isInteger(Number(values.runs)) || Number(values.runs) < 1)
	throw new Error("--runs must be positive integer");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
for (const [task, style] of pairs)
	console.log(
		JSON.stringify({
			task: task.id,
			revision: task.revision,
			category: task.category,
			promptStyle: style,
			prompt: promptFor(task, style),
			setups,
			documentation: values.documentation,
			skills: values.skills,
			sightread,
			repetitions: Number(values.runs),
			execute: values.execute,
		}),
	);
if (values.round) console.log(`Round results go to ${values["results-dir"]}.`);

if (!values.execute) {
	console.log("Plan only. No model was called. Pass --execute to run paid model sessions.");
} else {
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-suite-"));
	try {
		for (const [task, style] of pairs) {
			const fixture = path.join(root, task.id);
			if (!existsSync(fixture)) await materializeTask(task, fixture);
			await runTask(task, style, fixture);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** One run.ts experiment per task and prompt style, so each summary compares conditions on identical input. */
async function runTask(task: Task, style: PromptStyle, fixture: string) {
	const evaluator = path.join(import.meta.dir, "tasks.ts");
	const command = [
		"bun",
		path.join(import.meta.dir, "run.ts"),
		"--repo",
		fixture,
		"--task",
		promptFor(task, style),
		"--task-id",
		task.id,
		"--category",
		task.category,
		"--prompt-style",
		style,
		"--check",
		`bun ${quote(evaluator)} ${quote(task.id)} "$PWD"`,
	];
	for (const key of [
		"setups",
		"documentation",
		"skills",
		"sightread",
		"runs",
		"model",
		"reasoning",
		"budget-seconds",
		"budget-dollars",
		"results-dir",
	] as const) {
		if (values[key] !== undefined) command.push(`--${key}`, values[key]!);
	}
	const child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
	if ((await child.exited) !== 0) throw new Error(`Runner failed for ${task.id} (${style})`);
}
