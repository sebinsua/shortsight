import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const prelude = path.resolve(import.meta.dir, "../src/program/prelude.ts");
const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function runPrelude(cwd: string, code: string, environment: Record<string, string> = {}) {
	const child = Bun.spawn([process.execPath, "--preload", prelude, "-e", code], {
		cwd,
		env: { ...process.env, ...environment },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

test("runner root hint survives descriptor cleanup without a Git subprocess", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "shorthand-prelude-root-"));
	temporary.push(root);
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	await fs.writeFile(path.join(bin, "git"), "#!/bin/sh\nexit 77\n", { mode: 0o700 });
	const result = await runPrelude(root, 'console.log(process.env.PI_SHORTHAND_EXECUTION_ROOT ?? "cleared")', {
		PI_SHORTHAND_EXECUTION_ROOT: root,
		PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
	});
	expect(result).toEqual({ stdout: "cleared\n", stderr: "", exitCode: 0 });
});

test("standalone prelude still discovers the Git root from a nested directory", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "shorthand-prelude-standalone-"));
	temporary.push(root);
	const nested = path.join(root, "src");
	const bin = path.join(root, "bin");
	const marker = path.join(root, "git-commands");
	await fs.mkdir(nested);
	await fs.mkdir(bin);
	await fs.writeFile(path.join(nested, "file.txt"), "content");
	const git = Bun.spawn(["git", "init", "-q"], { cwd: root });
	expect(await git.exited).toBe(0);
	await fs.writeFile(
		path.join(bin, "git"),
		`#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(marker)}\nexec ${JSON.stringify(Bun.which("git"))} "$@"\n`,
		{ mode: 0o700 },
	);
	const result = await runPrelude(nested, 'console.log("ready")', {
		PI_SHORTHAND_EXECUTION_ROOT: "",
		PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
	});
	expect(result).toEqual({ stdout: "ready\n", stderr: "", exitCode: 0 });
	expect(await fs.readFile(marker, "utf8")).toBe("rev-parse\n");
});

test("ignore rules narrow a broad search, but a scope that names an ignored path is searched", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "shorthand-prelude-ignored-")));
	temporary.push(root);
	const files = {
		".gitignore": "scratch/\nnode_modules/\n",
		"src/a.ts": "oldApi(1);\n",
		"scratch/check.ts": "oldApi(2);\n",
		"scratch/notes/plan.md": "oldApi in prose\n",
		"scratch/nested/inner.ts": "oldApi(3);\n",
		"node_modules/x/index.ts": "oldApi(4);\n",
	};
	for (const [file, contents] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.writeFile(path.join(root, file), contents);
	}
	for (const directory of [root, path.join(root, "scratch/nested")]) {
		expect(await Bun.spawn(["git", "init", "-q"], { cwd: directory }).exited).toBe(0);
	}
	const result = await runPrelude(
		root,
		`const files = (matches) => [...new Set(matches.map((match) => match.file))];
		console.log(JSON.stringify({
			broad: [glob("**/*"), files(grep("oldApi")), files(sg.find("oldApi($A)", "."))],
			directory: [glob("**/*", "scratch"), files(grep("oldApi", "scratch")), files(sg.find("oldApi($A)", "scratch"))],
			pattern: [glob("scratch/**/*.md"), files(grep(/oldApi/, "scratch/*.ts"))],
			file: [glob("scratch/check.ts"), files(sg.find("oldApi($A)", "scratch/check.ts"))],
			mixed: files(grep("oldApi", ["src", "scratch/check.ts"])),
			missing: glob("scratch/absent/*.ts"),
		}));`,
		{ PI_SHORTHAND_EXECUTION_ROOT: "" },
	);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({
		broad: [[".gitignore", "src/a.ts"], ["src/a.ts"], ["src/a.ts"]],
		// A nested repository's files are its own.
		directory: [
			["scratch/check.ts", "scratch/notes/plan.md"],
			["scratch/check.ts", "scratch/notes/plan.md"],
			["scratch/check.ts"],
		],
		pattern: [["scratch/notes/plan.md"], ["scratch/check.ts"]],
		file: [["scratch/check.ts"], ["scratch/check.ts"]],
		mixed: ["src/a.ts", "scratch/check.ts"],
		missing: [],
	});
});
