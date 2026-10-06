#!/usr/bin/env bun
/**
 * The `shorthand` command: runs one program the way Pi's `shorthand` tool does and prints what the model would
 * read, so an agent can use it from its shell tool. Exit codes: 0 applied (or nothing to apply), 1 the run
 * failed (a failed program, a conflict or a rollback), 2 a usage error or the runner itself failing, 130 stopped with Ctrl-C.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_TIMEOUT_SECONDS, RunnerError, runWithBun } from "../runner/client.ts";
import { diagnosticLines } from "../runner/diagnostics.ts";
import { runFailed } from "../report/run-summary.ts";
import { textForModel } from "../report/text-for-model.ts";
import { truncateHead, truncateTail } from "../report/truncate.ts";

const USAGE = `Usage: shorthand [options] [program.ts]

Runs a TypeScript program with Bun in an isolated copy of the repository. If it succeeds, its changes
are applied and the diff is printed. The program is read from stdin when no file is given.

Options:
  --cwd <dir>            Working directory for the program; must be inside a Git worktree (default: .)
  --timeout <seconds>    Program time before it is killed; time inside helpers is excluded (default: ${DEFAULT_TIMEOUT_SECONDS})
  --rollback <file|all>  On failure, roll back only failed or interrupted file edits (file), or apply nothing (all) (default: file)
  --json                 Print the full result as JSON instead of text
  --skill                Print the skill that explains how to write programs
  -h, --help             Show this help
  -v, --version          Show the version

Exit codes: 0 applied, 1 the run failed, 2 usage or runner error, 130 stopped.`;

/** The skill Pi loads through pi-shorthand, and that `--skill` prints for other agents. */
const SKILL_DIRECTORY = path.join(import.meta.dir, "../../skills/shorthand");

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			cwd: { type: "string" },
			timeout: { type: "string" },
			rollback: { type: "string" },
			json: { type: "boolean" },
			skill: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	if (values.version) {
		console.log(version());
		return 0;
	}
	if (values.skill) {
		console.log(readFileSync(path.join(SKILL_DIRECTORY, "SKILL.md"), "utf8").trimEnd());
		console.log(`\nAdvanced guide: ${path.join(SKILL_DIRECTORY, "advanced-refactors.md")}`);
		return 0;
	}
	if (positionals.length > 1) throw new UsageError("expected at most one program file");

	const timeout = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
	if (!(timeout > 0)) throw new UsageError(`--timeout must be a positive number of seconds, not ${values.timeout}`);
	const rollback = values.rollback ?? "file";
	if (rollback !== "file" && rollback !== "all")
		throw new UsageError(`--rollback must be file or all, not ${rollback}`);

	const file = positionals[0];
	if (file === undefined && process.stdin.isTTY) throw new UsageError("no program: pass a file or pipe one to stdin");
	const program = file === undefined ? await Bun.stdin.text() : readFileSync(file, "utf8");

	// Ctrl-C asks the runner to stop; it then puts the repository back and applies nothing.
	const abort = new AbortController();
	process.once("SIGINT", () => abort.abort());
	process.once("SIGTERM", () => abort.abort());
	const progress = showProgress();
	try {
		const run = await runWithBun(
			{ cwd: path.resolve(values.cwd ?? "."), program, timeoutMs: timeout * 1000, rollback },
			abort.signal,
			progress.step,
		);
		progress.stop();
		console.log(
			values.json
				? JSON.stringify(run, null, 2)
				: textForModel(run, { name: `shorthand-${randomUUID()}`, truncateHead, truncateTail }),
		);
		return runFailed(run) ? 1 : 0;
	} catch (error) {
		progress.stop();
		if (abort.signal.aborted && !(error instanceof RunnerError)) {
			console.error("Stopped: nothing was applied.");
			return 130;
		}
		if (!(error instanceof RunnerError)) throw error;
		console.error([error.message, ...diagnosticLines(error.diagnostics)].join("\n"));
		return 2;
	}
}

/** While it runs, the elapsed time and latest step on stderr, only for a person at a terminal. */
function showProgress() {
	if (!process.stderr.isTTY) return { step: () => {}, stop: () => {} };
	const startedAt = Date.now();
	let latest: string | undefined;
	const draw = () => {
		const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
		process.stderr.write(`\r\x1b[2Krunning… ${latest ? `${elapsed} · ${latest}` : elapsed}`);
	};
	const timer = setInterval(draw, 500);
	return {
		step: (step: string) => (latest = step),
		stop: () => {
			clearInterval(timer);
			process.stderr.write("\r\x1b[2K");
		},
	};
}

function version(): string {
	const manifest = path.join(import.meta.dir, "../../package.json");
	return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: unknown) => {
			if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
				console.error(`shorthand: ${(error as Error).message}\n\n${USAGE}`);
				process.exit(2);
			}
			if ((error as { code?: string }).code === "ENOENT") {
				console.error(`shorthand: ${(error as Error).message}`);
				process.exit(2);
			}
			throw error;
		},
	);
}
