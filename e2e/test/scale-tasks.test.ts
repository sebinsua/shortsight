import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { $ } from "bun";
import { Lang, parse } from "@ast-grep/napi";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { applySolution, materializeTask, taskById } from "../tasks.ts";
import { scaleTasks } from "../tasks/scale.ts";

const temporary: string[] = [];
async function fixture(id: string) {
	const root = await mkdtemp(path.join(tmpdir(), "scale-task-test-"));
	temporary.push(root);
	await materializeTask(taskById(id), root);
	return root;
}
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const edit = async (root: string, file: string, change: (text: string) => string) =>
	writeFile(path.join(root, file), change(await readFile(path.join(root, file), "utf8")));

test("impact fixture keeps realistic JSX ranges by parsing its actual .tsx extension", () => {
	const source = taskById("impact-report-10").files["src/features/feature0.tsx"]!;
	const jsx = parse(Lang.Tsx, source).root();
	const plain = parse(Lang.TypeScript, source).root();
	const component = jsx.find({ rule: { kind: "function_declaration", regex: "Preview" } });
	expect(component?.range().end.index).toBe(source.length - 1);
	expect(jsx.findAll({ rule: { kind: "ERROR" } })).toHaveLength(0);
	expect(plain.findAll({ rule: { kind: "ERROR" } }).length).toBeGreaterThan(0);
	expect(plain.find({ rule: { kind: "function_declaration", regex: "Preview" } })?.range().end.index).not.toBe(
		component?.range().end.index,
	);
});

test("every scale task has a brief and an unchanged starting fixture reports only missed sites", async () => {
	for (const task of scaleTasks) {
		expect(task.brief).toBeString();
		const root = await fixture(task.id);
		const drift = await task.drift!(root);
		expect(drift.missed.length).toBe(drift.sites);
		expect({ overmatched: drift.overmatched, unrelated: drift.unrelated }).toEqual({ overmatched: [], unrelated: [] });
	}
	// Every scale fixture, each committed and formatted: past Bun's five-second default on CI's macOS runners.
}, 60_000);

test("a textual rename over-matches decoys that a scoped rename leaves alone", async () => {
	const task = taskById("rename-symbol-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	for (const file of Object.keys(task.files))
		await edit(root, file, (text) => text.replaceAll("formatAmount", "formatPrice"));
	const drift = await task.drift!(root);
	expect(drift.missed).toEqual([]);
	expect(drift.overmatched.length).toBe(drift.decoys);
	expect(drift.unrelated).toContain("src/legacy/format.ts");
});

test("a partial migration reports the files it missed", async () => {
	const task = taskById("logger-migration-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	const skipped = "src/features/g1/feature1.ts";
	await writeFile(path.join(root, skipped), task.files[skipped]!);
	const drift = await task.drift!(root);
	expect(drift.missed).toEqual([expect.stringContaining(skipped)]);
	await expect(task.verify(root)).rejects.toThrow();
});

/** Each consumer file of an irregular-logger fixture, with its migration applied by `rewrite`, and log.ts deleted. */
async function rewriteConsumers(root: string, rewrite: (text: string) => string) {
	const task = taskById("irregular-logger-10");
	for (const file of Object.keys(task.files).filter((name) => name.startsWith("src/features/")))
		await edit(root, file, (text) =>
			rewrite(text).replace(
				/import \{ log(?: as \w+)?(, type LogLevel)? \} from "(.+)\/log";/,
				'import { logger$1 } from "$2/logger";',
			),
		);
	await rm(path.join(root, "src/lib/log.ts"));
	return task;
}

test("a rewrite fitted to one-line calls misses the irregular logger's other call shapes", async () => {
	const root = await fixture("irregular-logger-10");
	// As a script fitted to logger-migration's consumers would: whole-line, double-quoted, literal-level calls.
	const task = await rewriteConsumers(root, (text) =>
		text.replace(
			/^(\s*)log\("(info|warn|error)", ("[^"]+")(?:, (\w+))?\);$/gm,
			(_, indent, level, message, error) =>
				`${indent}logger.${level}(${message}${error ? `, { error: ${error} }` : ""});`,
		),
	);
	const drift = await task.drift!(root);
	expect(drift.missed.length).toBeGreaterThan(0);
	expect(drift.overmatched).toEqual([]);
	await expect(task.verify(root)).rejects.toThrow();
});

test("a pattern rewrite of every log(level, message) call also rewrites a local log parameter's call", async () => {
	const root = await fixture("irregular-logger-10");
	const task = await rewriteConsumers(root, (text) => {
		const source = parse(Lang.TypeScript, text).root();
		const edits = source
			.findAll("log($LEVEL, $MESSAGE)")
			.map((call) =>
				call.replace(`logger.log(${call.getMatch("LEVEL")!.text()}, ${call.getMatch("MESSAGE")!.text()})`),
			);
		return source.commitEdits(edits);
	});
	// Files 3 and 8 of ten each have a local log parameter.
	expect((await task.drift!(root)).overmatched).toEqual([
		"src/features/feature3.ts: the local log parameter's call",
		"src/features/g0/feature8.ts: the local log parameter's call",
	]);
});

test("drift ignores reformatting but reports unrelated edits and scratch files", async () => {
	const task = taskById("options-migration-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	for (const file of Object.keys(task.solution))
		await edit(root, file, (text) => text.replaceAll('"', "'").replaceAll("\n", "\n\n"));
	expect(await task.drift!(root)).toMatchObject({ missed: [], overmatched: [], unrelated: [] });
	await edit(root, "src/lib/cache.ts", (text) => text.replace("ttl }", "ttl: ttl * 2 }"));
	await writeFile(path.join(root, "migrate.ts"), "// scratch\n");
	expect((await task.drift!(root)).unrelated).toEqual(["migrate.ts", "src/lib/cache.ts"]);
});

test("a module move that leaves the old file behind is incomplete", async () => {
	const task = taskById("move-module-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	await writeFile(path.join(root, "src/utils/date.ts"), 'export * from "../shared/time/date";\n');
	const drift = await task.drift!(root);
	expect(drift.missed).toEqual(["src/utils/date.ts removed"]);
});

test("the evaluator prints drift before failing", async () => {
	const root = await fixture("rename-symbol-10");
	const child = Bun.spawn(["bun", path.resolve("e2e/tasks.ts"), "rename-symbol-10", root], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	expect(exit).not.toBe(0);
	const line = stdout.split("\n").find((item) => item.startsWith("DRIFT "));
	expect(JSON.parse(line!.slice("DRIFT ".length)).missed.length).toBeGreaterThan(0);
});

test("a migrated logger call counts however its arguments are written", async () => {
	const task = taskById("logger-migration-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	await edit(root, "src/features/g1/feature1.ts", (text) =>
		text.replace("{ error: err }", "err === undefined ? undefined : { error: err }"),
	);
	await edit(root, "src/features/g2/feature2.ts", (text) =>
		text.replace('logger.log(level, "m301")', 'logger[level]("m301")'),
	);
	await edit(root, "src/features/feature0.ts", (text) =>
		text.replace('logger.info("m101")', 'logger.log("info", "m101")'),
	);
	expect(await task.drift!(root)).toMatchObject({ missed: [], overmatched: [], unrelated: [] });
	await task.verify(root);
});

test("a destructured options parameter counts as the options signature", async () => {
	const task = taskById("options-migration-10");
	const root = await fixture(task.id);
	await applySolution(task, root);
	await edit(root, "src/lib/http.ts", (text) =>
		text
			.replace("options: RequestOptions = {}", "{ retries = 0, timeoutMs = 1000 }: RequestOptions = {}")
			.replace("retries: options.retries ?? 0, timeoutMs: options.timeoutMs ?? 1000", "retries, timeoutMs"),
	);
	expect(await task.drift!(root)).toMatchObject({ missed: [], overmatched: [], unrelated: [] });
	await task.verify(root);
});

test("a module moved with git mv is not reported as an unrelated change", async () => {
	const task = taskById("move-module-10");
	const root = await fixture(task.id);
	await mkdir(path.join(root, "src/shared/time"), { recursive: true });
	await $`git mv src/utils/date.ts src/shared/time/date.ts`.cwd(root).quiet();
	await applySolution(task, root);
	expect(await task.drift!(root)).toMatchObject({ missed: [], overmatched: [], unrelated: [] });
});

for (const size of [10, 40, 100]) {
	test(`impact-report-${size} requires the exact sorted names and excludes decoys`, async () => {
		const task = taskById(`impact-report-${size}`);
		const root = await fixture(task.id);
		expect(task.files["src/features/feature0.tsx"]).toBeString();
		await expect(task.verify(root)).rejects.toThrow();
		await applySolution(task, root);
		await task.verify(root);
		const correct = await readFile(path.join(root, "IMPACT.txt"), "utf8");
		await writeFile(path.join(root, "IMPACT.txt"), correct + "feature4\n");
		expect((await task.drift!(root)).overmatched).toContain("IMPACT.txt: feature4");
		await expect(task.verify(root)).rejects.toThrow();
		await writeFile(path.join(root, "IMPACT.txt"), correct.replace("feature0\n", ""));
		expect((await task.drift!(root)).missed).toContain("IMPACT.txt: feature0");
	});

	test(`method-migration-${size} records fresh options at every Row.get call`, async () => {
		const task = taskById(`method-migration-${size}`);
		const initial = await fixture(task.id);
		await expect(task.verify(initial)).rejects.toThrow();
		const root = await fixture(task.id);
		await applySolution(task, root);
		await task.verify(root);
		const first = "src/features/feature0.ts";
		await writeFile(path.join(root, first), task.files[first]!);
		expect((await task.drift!(root)).missed.some((site) => site.includes(first))).toBe(true);
	});
}
