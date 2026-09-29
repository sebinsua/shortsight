/** Starts the Bun runner (runner.ts) for one program and collects its result. */
import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Readable } from "node:stream";
import type { RunOptions, RunResult } from "./runner.ts";
import { type Diagnostics, completeDiagnostics } from "./diagnostics.ts";

// Runs typically take well under a second. Longer transformations can request more time.
export const DEFAULT_TIMEOUT_SECONDS = 5;

export class RunnerError extends Error {
	constructor(
		message: string,
		readonly diagnostics: Diagnostics,
	) {
		super(message);
	}
}

/**
 * Runs a program from Node or Bun. The work happens in a Bun process (runner.ts). On abort it's asked
 * to stop (it then puts the repository back and applies nothing). It has its own process group,
 * which is killed afterwards so no subprocess the program started is left behind.
 */
export function runWithBun(
	options: RunOptions,
	signal?: AbortSignal,
	onProgress?: (step: string) => void,
): Promise<RunResult> {
	const startedAt = performance.now();
	let firstEventAt: number | undefined;
	let diagnostics: Diagnostics = { spans: [], counters: {} };
	const finishDiagnostics = () => {
		const now = performance.now();
		return completeDiagnostics(diagnostics, now - startedAt, (firstEventAt ?? now) - startedAt);
	};
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Aborted"));
		const runner = spawn("bun", [path.join(import.meta.dirname, "runner.ts")], {
			detached: true,
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		if (runner.pid === undefined) {
			// It didn't start, e.g. Bun isn't installed. Bun leaves the streams null, so report the error alone.
			runner.once("error", (error: NodeJS.ErrnoException) =>
				reject(new RunnerError(spawnFailure(error), finishDiagnostics())),
			);
			return;
		}
		const stop = () => runner.kill("SIGTERM");
		signal?.addEventListener("abort", stop);

		let stdout = "";
		let stderr = "";
		runner.stdout.setEncoding("utf8"); // so a multi-byte character split across chunks decodes intact
		runner.stderr.setEncoding("utf8");
		runner.stdout.on("data", (chunk) => (stdout += chunk));
		runner.stderr.on("data", (chunk) => (stderr += chunk));
		let progressBuffer = "";
		const progress = runner.stdio[3] as Readable;
		progress.setEncoding("utf8");
		progress.on("data", (chunk) => {
			progressBuffer += chunk;
			const lines = progressBuffer.split("\n");
			progressBuffer = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const event = JSON.parse(line) as { step?: unknown; diagnostics?: Diagnostics };
					firstEventAt ??= performance.now();
					if (event.diagnostics) {
						diagnostics = event.diagnostics;
						const active = diagnostics.spans.findLast((span) => span.durationMs === undefined);
						if (active) onProgress?.(active.name);
					}
					if (typeof event.step === "string") onProgress?.(event.step);
				} catch {
					// Progress is advisory; malformed events do not affect the run.
				}
			}
		});
		runner.on("error", (error: NodeJS.ErrnoException) => {
			signal?.removeEventListener("abort", stop);
			reject(new RunnerError(spawnFailure(error), finishDiagnostics()));
		});
		runner.on("close", (code) => {
			signal?.removeEventListener("abort", stop);
			try {
				process.kill(-runner.pid!, "SIGKILL"); // anything the program left running
			} catch {
				// nothing left
			}
			if (code === 0) {
				let result: RunResult;
				try {
					result = JSON.parse(stdout);
				} catch {
					reject(new RunnerError("Runner returned invalid JSON", finishDiagnostics()));
					return;
				}
				diagnostics = result.diagnostics ?? diagnostics;
				result.diagnostics = finishDiagnostics();
				if (!signal?.aborted || result.applied.length > 0 || result.cleanupWarnings.length > 0) resolve(result);
				else reject(new Error("Aborted"));
			} else
				reject(
					new RunnerError(
						stderr.trim() || (signal?.aborted ? "Aborted" : `runner exited with ${code}`),
						finishDiagnostics(),
					),
				);
		});

		runner.stdin.end(JSON.stringify(options));
	});
}

function spawnFailure(error: NodeJS.ErrnoException): string {
	return error.code === "ENOENT"
		? "Bun was not found on PATH. Shorthand runs programs with Bun: install it from https://bun.sh"
		: error.message;
}
