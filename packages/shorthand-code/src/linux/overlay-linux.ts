/**
 * Linux: bubblewrap (0.11+) mounts a kernel overlayfs over the repository in a private mount
 * namespace, so only the program sees it. Its writes land in an upper directory in tempDir, which
 * is also where the changes are read from. There's nothing to undo afterwards.
 */

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { FilesystemEntry, Overlay } from "../runner/runner.ts";
import { openLinuxObservation } from "./linux-observation.ts";
import type { TransactionJournal } from "../transaction/transaction-journal.ts";

export async function openLinuxOverlay(repo: string, tempDir: string): Promise<Overlay> {
	const bwrap = Bun.which("bwrap");
	if (!bwrap) throw new Error("shorthand needs bubblewrap (0.11 or later) on Linux.");

	// Best-effort live lower: validation does not remove OverlayFS's documented
	// restriction on concurrent external modifications of an underlying layer.
	const lower = repo;
	const upper = path.join(tempDir, "upper");
	const work = path.join(tempDir, "work");
	const cacheDir = path.join(homedir(), ".cache", "pi-shorthand");
	const internalDir = path.join(cacheDir, "sandbox");
	const sandboxExcludesFile = path.join(internalDir, `${path.basename(tempDir)}.exclude`);
	await fs.mkdir(upper);
	await fs.mkdir(work);
	await fs.mkdir(internalDir, { recursive: true, mode: 0o700 });
	const internalStats = await fs.lstat(internalDir);
	if (
		!internalStats.isDirectory() ||
		internalStats.isSymbolicLink() ||
		(process.getuid && internalStats.uid !== process.getuid())
	) {
		throw new Error(`Unsafe shorthand sandbox directory: ${internalDir}`);
	}
	if ((internalStats.mode & 0o077) !== 0) await fs.chmod(internalDir, 0o700);
	await fs.writeFile(sandboxExcludesFile, "", { flag: "wx", mode: 0o600 });

	const observation = await openLinuxObservation(repo, tempDir).catch(async (error: unknown) => {
		await fs.rm(sandboxExcludesFile, { force: true }).catch(() => {});
		throw error;
	});
	let dependencyConflicts: string[] | undefined;
	const wrap = (command: string[], cwd: string) =>
		observation.wrap([
			bwrap,
			"--die-with-parent", // so killing bwrap also kills the program
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--unshare-pid",
			"--proc",
			"/proc",
			"--overlay-src",
			lower,
			"--overlay",
			upper,
			work,
			repo,
			"--tmpfs",
			"/dev/shm",
			"--chdir",
			cwd, // resolve the working directory again, inside the overlay
			"--",
			...command,
		]);

	const overlay: Overlay = {
		original: (file) => observation.journal.original(file),
		dependencyConflicts: async () => {
			if (!dependencyConflicts)
				throw new Error("Transaction observation did not finish successfully; nothing can be applied.");
			return dependencyConflicts;
		},
		writableDir: upper,
		executionDir: repo,
		gitExcludes: [],
		executionExcludesFile: sandboxExcludesFile,
		environment: { TMPDIR: "/dev/shm", TMP: "/dev/shm", TEMP: "/dev/shm" },
		wrap,
		stopProgram: (pid) => process.kill(pid, "SIGTERM"),
		changes: async () => {
			const { written } = await writtenEntries(upper, observation.journal);
			const observed = (await observation.journal.observedFiles()).filter(
				(file) => file !== ".git" && !file.startsWith(".git/"),
			);
			const inspected = await inspectChanges(observed, written, repo, wrap);
			overlay.formattingAvailable = inspected.formattingAvailable;
			overlay.ignoredPaths = inspected.ignoredPaths;
			return [...written, ...inspected.deleted];
		},
		close: async () => {
			let observationError: unknown;
			try {
				dependencyConflicts = await observation.finish();
			} catch (error) {
				observationError = error;
			}
			// OverlayFS deliberately leaves its private work/work directory inaccessible. Node and Bun
			// recurse into it before unlinking it, so restore owner access before removing the workspace.
			const internalWork = path.join(work, "work");
			try {
				const stats = await fs.lstat(internalWork);
				if (!stats.isDirectory() || stats.isSymbolicLink() || (process.getuid && stats.uid !== process.getuid())) {
					throw new Error(`Unsafe OverlayFS work directory: ${internalWork}`);
				}
				await fs.chmod(internalWork, 0o700);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			try {
				await fs.rm(tempDir, { recursive: true, force: true });
			} finally {
				await fs.rm(sandboxExcludesFile, { force: true });
			}
			if (observationError) throw observationError;
		},
	};
	return overlay;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Files and symlinks represented in the upper layer, except Git's own metadata writes. */
async function writtenEntries(upper: string, journal: TransactionJournal) {
	const written: { file: string; entry: FilesystemEntry }[] = [];
	for (const entry of await fs.readdir(upper, { recursive: true, withFileTypes: true })) {
		const fullPath = path.join(entry.parentPath, entry.name);
		const file = path.relative(upper, fullPath);
		if (file === ".git" || file.startsWith(".git/")) continue;
		if (entry.isDirectory()) {
			const before = await journal.originalKind(file);
			if (before !== "absent" && before !== "directory")
				throw new Error(`Unsupported directory replacement at ${JSON.stringify(file)}.`);
			continue;
		}
		if (entry.isFile()) {
			const stats = await fs.lstat(fullPath);
			written.push({
				file,
				entry: { type: "file", contents: await Bun.file(fullPath).bytes(), mode: stats.mode & 0o7777 },
			});
			continue;
		}
		if (entry.isSymbolicLink()) {
			written.push({ file, entry: { type: "symlink", target: await fs.readlink(fullPath) } });
			continue;
		}
		const stats = await fs.lstat(fullPath);
		if (stats.isCharacterDevice() && stats.rdev === 0) {
			continue;
		}
		throw new Error(`Unsupported filesystem entry at ${JSON.stringify(file)}.`);
	}
	return { written };
}

/**
 * Observed files that are gone from the final overlay. Check the directory entries themselves:
 * staging a file or changing an ignore rule changes Git's classification without deleting the file.
 * Overlayfs's own records aren't enough either: deleting a directory leaves one whiteout for all of
 * it, and recreating a directory hides everything that was in it.
 */
async function inspectChanges(
	observed: string[],
	written: { file: string; entry: FilesystemEntry }[],
	repo: string,
	wrap: (command: string[], cwd: string) => string[],
) {
	// Inspect only observed files plus private writes, never an untouched lower tree.
	const script = `
import { lstatSync } from "node:fs";
const { observed, files, writtenPaths } = await Bun.stdin.json();
const missing = new Set(observed.filter(file => !lstatSync(file, { throwIfNoEntry: false })));
const candidates = [...new Set([...writtenPaths, ...missing])];
let ignoredPaths = [];
if (candidates.length) {
  const git = Bun.spawn(["git", "check-ignore", "-z", "--stdin"], {
    stdin: new Response(candidates.join("\\0") + "\\0"), stdout: "pipe", stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([git.exited, new Response(git.stdout).text(), new Response(git.stderr).text()]);
  if (code !== 0 && code !== 1) throw new Error("Could not evaluate final ignore rules: " + error.trim());
  ignoredPaths = output.split("\\0").filter(Boolean);
}
const ignored = new Set(ignoredPaths);
let formattingAvailable = false;
if (process.env.PI_SHORTHAND_FORMAT !== "0" && files.some(file => !ignored.has(file))) {
  try {
    const { formatterFor } = await import(${JSON.stringify(path.join(import.meta.dir, "../runner/format.ts"))});
    formattingAvailable = files.some(file => !ignored.has(file) && formatterFor(file, process.cwd()) !== null);
  } catch {
    // Discovery is only an optimization. Let the best-effort formatting pass report its own error.
    formattingAvailable = true;
  }
}
console.log(JSON.stringify({ deleted: [...missing], ignoredPaths, formattingAvailable }));
`;
	const filesToFormat = written.filter(({ entry }) => entry.type === "file").map(({ file }) => file);
	const input = new Response(
		JSON.stringify({
			observed,
			files: filesToFormat,
			writtenPaths: written.map(({ file }) => file),
		}),
	);
	// Inside the overlay, one mount at a time: overlayfs won't let two mounts share a work directory.
	const output = await $`${wrap([process.execPath, "-e", script], repo)} < ${input}`.text();
	const {
		deleted: files,
		formattingAvailable,
		ignoredPaths,
	} = JSON.parse(output) as {
		deleted: string[];
		formattingAvailable: boolean;
		ignoredPaths: string[];
	};
	return {
		deleted: files.map((file) => ({ file, entry: null })),
		formattingAvailable,
		ignoredPaths,
	};
}
