/**
 * Task registry and evaluator. Suites: `pilot` (the original compact tasks), `guidance` (held-out fixtures for
 * documentation comparisons) and `scale` (generated repository-scale refactors with drift measurement).
 *
 *   bun e2e/tasks.ts <task-id> <working-directory>
 */
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { guidanceTasks } from "./tasks/guidance.ts";
import { pilotTasks } from "./tasks/pilot.ts";
import { scaleTasks } from "./tasks/scale.ts";
import type { Task } from "./tasks/task.ts";

export type { PromptStyle, Task } from "./tasks/task.ts";
export { promptFor } from "./tasks/task.ts";

export const suites = { pilot: pilotTasks, guidance: guidanceTasks, scale: scaleTasks } as const;
export type Suite = keyof typeof suites;
export const allTasks: Task[] = Object.values(suites).flat();

export function taskById(id: string): Task {
	const task = allTasks.find((item) => item.id === id);
	if (!task) throw new Error(`Unknown task ${id}; choose ${allTasks.map((item) => item.id).join(", ")}`);
	return task;
}

/** Apply a reference solution; `null` removes a file. */
export async function applySolution(task: Task, root: string): Promise<void> {
	for (const [file, content] of Object.entries(task.solution)) {
		const target = path.join(root, file);
		if (content === null) await rm(target, { force: true });
		else {
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, content);
		}
	}
}

/** A tool installed in this checkout, linked into fixtures rather than downloaded. */
async function tool(name: string) {
	const directory = path.resolve(import.meta.dir, "../node_modules", name);
	return { directory, version: JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).version };
}

/** `formatted: false` keeps generated layout, for replaying sessions recorded before fixtures were formatted. */
export async function materializeTask(task: Task, root: string, { formatted = true } = {}): Promise<void> {
	await mkdir(root, { recursive: true });
	for (const [file, content] of Object.entries(task.files)) {
		await mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await writeFile(path.join(root, file), content);
	}
	await writeFile(
		path.join(root, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "bundler",
				jsx: "preserve",
				noEmit: true,
			},
			include: task.include ?? ["*.ts"],
		}),
	);
	// Provision the same compiler and formatter for ordinary shell calls and shorthand programs, which formats
	// the files it changes with the project's formatter. Links reuse the installed toolchain without downloads.
	const [typescript, oxfmt] = await Promise.all([tool("typescript"), tool("oxfmt")]);
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "shorthand-benchmark-fixture",
			private: true,
			type: "module",
			scripts: { check: "tsc --noEmit", format: "oxfmt" },
			devDependencies: { typescript: typescript.version, oxfmt: oxfmt.version },
		}),
	);
	await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
	await writeFile(path.join(root, ".oxfmtrc.json"), "{}\n");
	await mkdir(path.join(root, "node_modules/.bin"), { recursive: true });
	await symlink(typescript.directory, path.join(root, "node_modules/typescript"), "dir");
	await symlink("../typescript/bin/tsc", path.join(root, "node_modules/.bin/tsc"));
	await symlink(oxfmt.directory, path.join(root, "node_modules/oxfmt"), "dir");
	await symlink("../oxfmt/bin/oxfmt", path.join(root, "node_modules/.bin/oxfmt"));
	// A project with a formatter keeps its files formatted, so start from that; `// prettier-ignore` keeps the
	// layouts a task depends on, such as calls split over lines.
	if (formatted) await $`${path.join(root, "node_modules/.bin/oxfmt")} .`.cwd(root).quiet();
	await $`git init -q`.cwd(root).quiet();
	await $`git add .`.cwd(root).quiet();
	// Otherwise git packs the new loose objects in the background, deleting them while the fixture is copied.
	await $`git -c user.name=Benchmark -c user.email=benchmark@localhost -c commit.gpgsign=false -c maintenance.auto=false commit -qm ${task.revision}`
		.cwd(root)
		.quiet();
}

if (import.meta.main) {
	const [id, root] = process.argv.slice(2);
	if (!id || !root) throw new Error("Usage: bun e2e/tasks.ts <task-id> <working-directory>");
	const task = taskById(id);
	const directory = path.resolve(root);
	// Report drift before verification, so failed attempts still record how far they strayed.
	if (task.drift) console.log(`DRIFT ${JSON.stringify(await task.drift(directory))}`);
	await task.verify(directory);
	const tsc = path.resolve(import.meta.dir, "../node_modules/.bin/tsc");
	await $`${tsc} -p ${path.join(directory, "tsconfig.json")}`;
	console.log("Behavioural, structural and type checks passed");
}
