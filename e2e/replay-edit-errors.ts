/** Replay observed failed edits and minimal corrections locally; never calls a model. */
import { parseArgs } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runWithBun } from "shorthand-code";
import { allTasks, materializeTask } from "./tasks.ts";
import { runVerification } from "./harness.ts";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const { values } = parseArgs({ options: { out: { type: "string" } } });
const output = path.resolve(values.out ?? path.join(import.meta.dir, "results", `recovery-${Date.now()}`));
await mkdir(output, { recursive: true });
if (await Bun.file(path.join(output, "results.json")).exists()) throw new Error(`Results already exist: ${output}`);
const results = [];
for (const name of ["method-pattern", "file-target"]) {
	const dir = path.join(import.meta.dir, "recovery-programs");
	const metadata = JSON.parse(await readFile(path.join(dir, `${name}.json`), "utf8"));
	const task = allTasks.find((item) => item.id === metadata.task)!;
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-recovery-"));
	try {
		// The recorded failures happened against the generated layout, before fixtures were formatted.
		await materializeTask(task, root, { formatted: false });
		const execute = async (phase: string) => {
			const program = await readFile(path.join(dir, `${name}.${phase}.ts.txt`), "utf8");
			await writeFile(path.join(output, `${name}.${phase}.ts.txt`), program);
			return runWithBun({ cwd: root, program, timeoutMs: 15_000, rollback: "all" });
		};
		const failed = await execute("failed");
		const supported = name === "file-target";
		if (!supported && (failed.exitCode === 0 || failed.applied.length))
			throw new Error(`Expected ${name} to fail without applying changes`);
		const corrected = supported ? null : await execute("corrected");
		const command = ["bun", path.join(import.meta.dir, "tasks.ts"), task.id, root].map(quote).join(" ");
		const verification = await runVerification(command, root, 30_000);
		const result = {
			name,
			...metadata,
			failed,
			corrected,
			verification,
			verified: (corrected ?? failed).exitCode === 0 && verification.passed,
		};
		results.push(result);
		console.log(
			`${name}: ${supported ? "original program" : "minimal correction"} ${result.verified ? "PASS" : "FAIL"}`,
		);
		if (!result.verified) console.log((corrected ?? failed).output || verification.stderr);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
await writeFile(
	path.join(output, "results.json"),
	JSON.stringify(
		{
			kind: "Deterministic failed-call replay and manual minimal correction; not model recovery measurements",
			results,
		},
		null,
		2,
	) + "\n",
);
if (results.some((result) => !result.verified)) process.exitCode = 1;
