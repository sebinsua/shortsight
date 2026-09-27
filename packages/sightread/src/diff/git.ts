// Read working-tree changes and base content with repository-root path coordinates.
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { relative, resolve, sep } from "node:path";

const runFile = promisify(execFile);
const types = ["*.ts", "*.tsx", "*.mts", "*.cts"];
export const isTypeScript = (file: string) => /\.(?:ts|tsx|mts|cts)$/.test(file);

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await runFile("git", ["-c", "core.quotePath=false", ...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout;
}

function path(value: string): string {
	if (value.startsWith('"') || /[\r\n]/.test(value)) throw new Error("unsupported quoted git path");
	return value;
}

function patchPath(value: string): string {
	const clean = value.split("\t", 1)[0];
	const decoded = clean.startsWith('"') ? (JSON.parse(clean) as string) : clean;
	return path(decoded.startsWith("b/") ? decoded.slice(2) : decoded);
}

export interface GitFile {
	path: string;
	oldPath?: string;
	status: "added" | "deleted" | "edited" | "renamed" | "untracked";
	hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }>;
}

export interface GitChanges {
	repository: string;
	base: string;
	baseRef?: string;
	baseNote?: string;
	project: string;
	files: GitFile[];
	baseText(file: string): Promise<string | undefined>;
	grep(name: string): Promise<Array<{ file: string; line: number }>>;
	projectPath(file: string): { path?: string; outside: boolean };
}

/**
 * Where the current branch left the default branch, when no base is given.
 *
 * Tries `origin/HEAD`, then the branch `origin/HEAD` names (from the ref, or offline from
 * `git remote show -n origin`), then a local `main`, then `master`, skipping the current branch. With
 * none of those, the base is `HEAD`, so the diff is the uncommitted changes.
 * The fallbacks exist because a bare clone has no `refs/remotes/origin/*`, so worktrees made from
 * one never have `origin/HEAD`.
 */
async function defaultBase(repository: string): Promise<{ revision: string; ref: string; note?: string }> {
	let remoteBranch: string | undefined;
	try {
		remoteBranch = (await git(repository, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
	} catch {
		try {
			const offline = await git(repository, ["remote", "show", "-n", "origin"]);
			const branch = /^\s*HEAD branch:\s*(\S+)\s*$/m.exec(offline)?.[1];
			if (branch && branch !== "(unknown)") remoteBranch = `origin/${branch}`;
		} catch {
			// A repository without origin can still have a local default branch.
		}
	}
	const ownBranch = (await git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
	for (const candidate of ["origin/HEAD", remoteBranch, ...(remoteBranch ? [] : ["main", "master"])]) {
		if (!candidate || candidate === ownBranch || candidate === `origin/${ownBranch}`) continue;
		if (candidate === "origin/HEAD" && remoteBranch === `origin/${ownBranch}`) continue;
		try {
			await git(repository, ["rev-parse", "--verify", `${candidate}^{commit}`]);
			return { revision: (await git(repository, ["merge-base", "HEAD", candidate])).trim(), ref: candidate };
		} catch {
			// Try the next local or offline ref.
		}
	}
	const branches = (await git(repository, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]))
		.trim()
		.split("\n")
		.filter(Boolean);
	const other = branches.filter((branch) => branch !== ownBranch);
	const onDefault = remoteBranch
		? remoteBranch === `origin/${ownBranch}`
		: ownBranch === "main" || ownBranch === "master";
	const example = other.length === 1 ? `diff ${other[0]}` : "diff <base>";
	const note =
		other.length && !onDefault
			? `no default branch found; this compares against HEAD, so committed changes aren't included. Pass a base, like ${example}, to compare a branch.`
			: undefined;
	return { revision: (await git(repository, ["rev-parse", "HEAD"])).trim(), ref: "HEAD", note };
}

/** Resolve the revision and enumerate all paths, including untracked and renamed files. */
export async function readGitChanges(projectRoot: string, base?: string): Promise<GitChanges> {
	const repository = await realpath((await git(projectRoot, ["rev-parse", "--show-toplevel"])).trim());
	const root = await realpath(projectRoot);
	const {
		revision,
		ref: baseRef,
		note: baseNote,
	} = base
		? {
				revision: (await git(repository, ["rev-parse", "--verify", `${base}^{commit}`])).trim(),
				ref: undefined,
				note: undefined,
			}
		: await defaultBase(repository);
	const project = relative(repository, root).replaceAll(sep, "/") || ".";
	const projectPath = (file: string) => {
		const absolute = resolve(repository, file);
		const local = relative(root, absolute).replaceAll(sep, "/");
		return local === ".." || local.startsWith("../") || local.startsWith("/")
			? { outside: true }
			: { path: local, outside: false };
	};
	const names = (await git(repository, ["diff", "--name-status", "-z", "-M", "-w", revision, "--"])).split("\0");
	const files: GitFile[] = [];
	for (let index = 0; index < names.length && names[index];) {
		const status = names[index++];
		const old = path(names[index++] ?? "");
		if (status.startsWith("R"))
			files.push({ path: path(names[index++] ?? ""), oldPath: old, status: "renamed", hunks: [] });
		else files.push({ path: old, status: status === "A" ? "added" : status === "D" ? "deleted" : "edited", hunks: [] });
	}
	const tracked = new Set(files.map((file) => file.path));
	for (const file of (await git(repository, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"])).split(
		"\0",
	)) {
		if (file && !tracked.has(file)) files.push({ path: path(file), status: "untracked", hunks: [] });
	}
	const patch = await git(repository, ["diff", "-U0", "-M", "-w", revision, "--", ...types]);
	let current: GitFile | undefined;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++ b/") || line.startsWith('+++ "b/'))
			current = files.find((file) => file.path === patchPath(line.slice(4)));
		else if (line.startsWith("+++ /dev/null")) current = undefined;
		else if (line.startsWith("@@ ")) {
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (match && current)
				current.hunks.push({
					oldStart: +match[1],
					oldCount: +(match[2] ?? 1),
					newStart: +match[3],
					newCount: +(match[4] ?? 1),
				});
		}
	}
	return {
		repository,
		base: revision,
		baseRef,
		baseNote,
		project,
		files,
		projectPath,
		async baseText(file) {
			try {
				return await git(repository, ["show", `${revision}:${file}`]);
			} catch {
				return undefined;
			}
		},
		async grep(name) {
			try {
				const output = await git(repository, [
					"grep",
					"-n",
					"-z",
					"-F",
					"-w",
					"--untracked",
					"-e",
					name,
					"--",
					...types,
				]);
				return output.split("\n").flatMap((entry) => {
					const separator = entry.indexOf("\0");
					const match = separator < 0 ? undefined : /^(\d+)\0/.exec(entry.slice(separator + 1));
					return match ? [{ file: path(entry.slice(0, separator)), line: +match[1] }] : [];
				});
			} catch {
				return [];
			}
		},
	};
}
