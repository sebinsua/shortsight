/**
 * macOS has no mount namespaces, so AgentFS is mounted at a private temporary path rather than at
 * the public checkout. The program runs inside that mount while editors and other host processes
 * continue to see the real repository. AgentFS retains private writes; the NFS observer retains
 * on-demand originals and validates all observed dependencies before anything is published.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { REFUSED, RefusedRunError } from "../transaction/transaction-journal.ts";
import { $ } from "bun";
import { Database } from "bun:sqlite";
import { measure } from "../runner/diagnostics.ts";
import { createAgentFsDatabase } from "./agentfs-database.ts";
import { openNfsObservation, type NfsObservation } from "./nfs-worker.ts";
import type { FilesystemEntry, Overlay } from "../runner/runner.ts";

export async function openMacOverlay(repo: string, tempDir: string): Promise<Overlay> {
	const agentfs = process.env.AGENTFS_BIN ?? Bun.which("agentfs");
	if (!agentfs) throw new Error("shorthand needs AgentFS: curl -fsSL https://agentfs.ai/install | bash");
	const gitMetadata = await measure("resolving macOS Git metadata", () => gitMetadataDirectories(repo));
	const cleanupHelper = await measure("preparing macOS cleanup helper", macProcessCleanupHelper);
	const processDeniedCanary = path.join(tempDir, `process-denied-${randomUUID()}`);
	const processAllowedCanary = path.join(tempDir, `process-allowed-${randomUUID()}`);
	await Promise.all([
		fs.writeFile(processDeniedCanary, "", { flag: "wx", mode: 0o600 }),
		fs.writeFile(processAllowedCanary, "", { flag: "wx", mode: 0o600 }),
	]);

	const stateFile = await recoveryFile(repo);
	await recoverCrashedRun(stateFile);
	const mountContainer = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "pi-shorthand-workspace-"));
	const mount = path.join(mountContainer, "repo");
	const scratch = path.join(mountContainer, "tmp");
	await fs.mkdir(mount);
	await fs.mkdir(scratch);
	const state: RecoveryState = { runnerPid: process.pid, tempDir, mountContainer, mount };
	await writeRecoveryState(stateFile, state);

	try {
		const database = await measure("preparing AgentFS database", () => createAgentFsDatabase(agentfs, repo, tempDir));
		const { server, observation, ports } = await serveAndMount(agentfs, database, repo, mount, async (serverPid) => {
			state.serverPid = serverPid;
			await writeRecoveryState(stateFile, state);
		});
		let closed = false;
		let dependencyConflicts: string[] | undefined;
		let refusal: string | undefined;

		return {
			original: (file) => observation.original(file),
			dependencyConflicts: async () => {
				if (refusal) throw new RefusedRunError(refusal);
				if (!dependencyConflicts)
					throw new Error("Transaction observation did not finish successfully; nothing can be applied.");
				return dependencyConflicts;
			},
			writableDir: mount,
			executionDir: mount,
			environment: { TMPDIR: scratch, TMP: scratch, TEMP: scratch },
			gitExcludes: ["._*"],
			wrap: (command) => [
				"/usr/bin/sandbox-exec",
				"-p",
				sandboxProfile(
					repo,
					tempDir,
					mount,
					stateFile,
					gitMetadata,
					processDeniedCanary,
					cleanupHelper,
					scratch,
					ports,
				),
				...command,
			],
			terminateProcesses: async () => {
				const result = await $`${cleanupHelper} ${processDeniedCanary} ${processAllowedCanary}`.nothrow().quiet();
				if (result.exitCode !== 0) {
					throw new Error(`Could not terminate every sandbox subprocess (cleanup exit ${result.exitCode}).`);
				}
			},
			changes: () => changesInDatabase(database, observation, mount),
			close: async () => {
				if (closed) return;
				closed = true;
				try {
					await measure("unmounting AgentFS", () => unmount(mount));
					try {
						dependencyConflicts = await observation.finish();
					} catch (error) {
						// A refusal isn't a failure to clean up: it's why nothing will be applied (see dependencyConflicts).
						if (!(error instanceof Error && error.message.startsWith(REFUSED))) throw error;
						refusal = error.message;
					}
				} finally {
					await observation.abort();
					server.kill();
					await server.exited;
				}
				await fs.rm(mountContainer, { recursive: true, force: true });
				await fs.rm(stateFile, { force: true });
			},
		};
	} catch (error) {
		await cleanupRecoveredRun(state, stateFile).catch(() => {});
		throw error;
	}
}

interface RecoveryState {
	runnerPid: number;
	tempDir: string;
	mountContainer: string;
	mount: string;
	serverPid?: number;
}

async function recoveryFile(repo: string): Promise<string> {
	const directory = path.join(homedir(), ".cache", "pi-shorthand", "macos-mounts");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stats = await fs.lstat(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink() || (process.getuid && stats.uid !== process.getuid())) {
		throw new Error(`Unsafe shorthand recovery directory: ${directory}`);
	}
	if ((stats.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
	const checkout = createHash("sha256").update(repo).digest("hex").slice(0, 16);
	return path.join(directory, `${checkout}.json`);
}

async function recoverCrashedRun(stateFile: string) {
	const state = (await Bun.file(stateFile)
		.json()
		.catch(() => null)) as RecoveryState | null;
	if (!state) return;
	await validateRecoveryState(state);
	if (isAlive(state.runnerPid)) throw new Error("Another shorthand macOS workspace is still active.");
	await cleanupRecoveredRun(state, stateFile);
}

async function cleanupRecoveredRun(state: RecoveryState, stateFile: string) {
	await validateRecoveryState(state);
	const serverIsOurs = await isExpectedServer(state);
	await $`umount -f ${state.mount}`.nothrow().quiet();
	if (state.serverPid && serverIsOurs) {
		try {
			process.kill(state.serverPid, "SIGKILL");
		} catch {
			// already stopped
		}
	}
	await fs.rm(state.mountContainer, { recursive: true, force: true });
	await fs.rm(state.tempDir, { recursive: true, force: true });
	await fs.rm(stateFile, { force: true });
}

async function validateRecoveryState(state: RecoveryState) {
	const temporaryRoot = await fs.realpath(tmpdir());
	const isOwnedTemporary = (candidate: unknown, prefix: string) => {
		if (typeof candidate !== "string" || path.resolve(candidate) !== candidate) return false;
		return path.dirname(candidate) === temporaryRoot && path.basename(candidate).startsWith(prefix);
	};
	const valid =
		Number.isSafeInteger(state.runnerPid) &&
		state.runnerPid > 0 &&
		(state.serverPid === undefined || (Number.isSafeInteger(state.serverPid) && state.serverPid > 0)) &&
		isOwnedTemporary(state.tempDir, "pi-shorthand-") &&
		isOwnedTemporary(state.mountContainer, "pi-shorthand-workspace-") &&
		state.mount === path.join(state.mountContainer, "repo");
	if (!valid) throw new Error("Refusing to clean an invalid shorthand macOS recovery record.");
}

/** A stale PID is signalled only if it is still our AgentFS process for this exact database. */
async function isExpectedServer(state: RecoveryState): Promise<boolean> {
	if (!state.serverPid) return false;
	const output = (await $`ps -ww -o uid=,command= -p ${state.serverPid}`.nothrow().quiet().text()).trim();
	if (!output) return false;
	const match = output.match(/^(\d+)\s+(.+)$/s);
	const database = path.join(state.tempDir, ".agentfs", "run.db");
	if (!match || Number(match[1]) !== process.getuid?.() || !match[2].includes(database)) {
		throw new Error("Refusing to signal a process that is not the recorded shorthand AgentFS server.");
	}
	return true;
}

async function writeRecoveryState(file: string, state: RecoveryState) {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, file);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function serveAndMount(
	agentfs: string,
	database: string,
	repo: string,
	mount: string,
	onSpawn: (pid: number) => Promise<void>,
) {
	const port = freePort();
	const server = Bun.spawn([agentfs, "nfs", database, "--port", String(port)], {
		stdout: "ignore",
		stderr: "ignore",
	});
	let observation: NfsObservation | undefined;
	try {
		await measure("starting AgentFS server", async () => {
			await onSpawn(server.pid);
			await waitForPort(port);
		});
		observation = await measure("starting NFS observation worker", () =>
			openNfsObservation({ root: repo, backendPort: port, requestTimeoutMs: 10_000 }),
		);
		// AgentFS copy-up can change directory attributes. Stale NFS directory caches can make
		// getcwd() fail in nested directories; keep file caching but revalidate directories immediately.
		const options = `locallocks,vers=3,tcp,port=${observation.port},mountport=${observation.port},soft,timeo=100,retrans=5,acdirmin=0,acdirmax=0`;
		await measure("mounting AgentFS", async () => {
			await $`/sbin/mount_nfs -o ${options} 127.0.0.1:/ ${mount}`.quiet();
		});
		return { server, observation, ports: [port, observation.port] };
	} catch (error) {
		await observation?.abort();
		server.kill();
		await server.exited;
		throw error;
	}
}

/** Restrict writes to the workspace, private scratch space and devices. */
export function sandboxProfile(
	repo: string,
	tempDir: string,
	mount: string,
	stateFile: string,
	gitMetadata: string[],
	processDeniedCanary: string,
	cleanupHelper: string,
	scratch: string,
	protectedPorts: number[] = [],
): string {
	return [
		"(version 1)",
		"(allow default)",
		...protectedPorts.map((port) => `(deny network-outbound (remote tcp ${JSON.stringify(`*:${port}`)}))`),
		"(deny file-write*)",
		`(allow file-write* (require-all (subpath ${JSON.stringify(mount)}) (require-not (subpath ${JSON.stringify(path.join(mount, ".git"))}))))`,
		`(allow file-write* (subpath ${JSON.stringify(scratch)}))`,
		'(allow file-write-data (literal "/dev/null") (literal "/dev/tty"))',
		`(deny file-read* (subpath ${JSON.stringify(repo)}))`,
		`(deny file-write* (subpath ${JSON.stringify(repo)}))`,
		`(deny file-write* (subpath ${JSON.stringify(tempDir)}))`,
		`(deny file-write* (subpath ${JSON.stringify(path.dirname(stateFile))}))`,
		`(deny file-write* (subpath ${JSON.stringify(path.dirname(cleanupHelper))}))`,
		`(deny file-write* (subpath ${JSON.stringify(path.join(mount, ".git"))}))`,
		`(deny file-read-data (literal ${JSON.stringify(processDeniedCanary)}))`,
		...gitMetadata.map((directory) => `(deny file-write* (subpath ${JSON.stringify(directory)}))`),
	].join("\n");
}

/** Build a local helper whose kernel sandbox queries identify reparented descendants exactly. */
async function macProcessCleanupHelper(): Promise<string> {
	const source = path.join(import.meta.dir, "macos-process-cleanup.c");
	const sourceBytes = await Bun.file(source).bytes();
	const digest = createHash("sha256").update(sourceBytes).digest("hex").slice(0, 16);
	const directory = path.join(homedir(), ".cache", "pi-shorthand", "native");
	const helper = path.join(directory, `macos-process-cleanup-${digest}`);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryStats = await fs.lstat(directory);
	if (
		!directoryStats.isDirectory() ||
		directoryStats.isSymbolicLink() ||
		(process.getuid && directoryStats.uid !== process.getuid())
	) {
		throw new Error(`Unsafe shorthand native helper directory: ${directory}`);
	}
	if ((directoryStats.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);

	const existing = await fs.lstat(helper).catch(() => null);
	if (existing) {
		if (
			!existing.isFile() ||
			existing.isSymbolicLink() ||
			(existing.mode & 0o111) === 0 ||
			(process.getuid && existing.uid !== process.getuid())
		) {
			throw new Error(`Unsafe shorthand native helper: ${helper}`);
		}
		return helper;
	}

	const compiler = Bun.which("clang") ?? Bun.which("cc");
	if (!compiler) throw new Error("shorthand needs clang on macOS to build its process-lifecycle helper.");
	const temporary = `${helper}.${randomUUID()}.tmp`;
	try {
		const compilation = await $`${compiler} -O2 ${source} -o ${temporary}`.nothrow().quiet();
		if (compilation.exitCode !== 0) {
			throw new Error(`Could not build the macOS process-lifecycle helper:\n${compilation.stderr}`);
		}
		await fs.chmod(temporary, 0o700);
		await fs.rename(temporary, helper);
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => {});
	}
	return helper;
}

/** Resolve both per-worktree and common Git storage before entering the private checkout. */
async function gitMetadataDirectories(repo: string): Promise<string[]> {
	const [gitDirOutput, commonDirOutput] = await Promise.all([
		$`git rev-parse --absolute-git-dir`.cwd(repo).text(),
		$`git rev-parse --git-common-dir`.cwd(repo).text(),
	]);
	const directories = [gitDirOutput, commonDirOutput]
		.map((output) => path.resolve(repo, output.trim()))
		.map((directory) => fs.realpath(directory));
	return [...new Set(await Promise.all(directories))];
}

/** Snapshot the AgentFS database while its server owns the live database lock. */
async function changesInDatabase(database: string, observation: NfsObservation, mount: string) {
	const snapshotDir = path.join(path.dirname(path.dirname(database)), "database-snapshot");
	await measure("copying AgentFS change database", () =>
		cloneDatabase(path.dirname(database), "run.db", snapshotDir, "run.db"),
	);
	const records = await measure("enumerating AgentFS change records", async () =>
		agentFsChangeRecords(path.join(snapshotDir, "run.db")),
	);

	const changes: { file: string; entry: FilesystemEntry | null }[] = [];
	await measure("reading AgentFS changed entries", async () => {
		for (const record of records) {
			const { file } = record;
			if (path.basename(file).startsWith("._")) continue;
			if (file === ".git" || file.startsWith(".git/")) continue;

			if (record.deleted) {
				for (const descendant of await observation.originalFiles(file)) {
					changes.push({ file: descendant, entry: null });
				}
				continue;
			}

			switch (record.type) {
				case "f":
				case "l":
					changes.push({ file, entry: await readChangedEntry(mount, file) });
					break;
				case "d": {
					const original = await observation.originalKind(file);
					if (original !== "absent" && original !== "directory") {
						throw new Error(`Unsupported directory replacement at ${JSON.stringify(file)}.`);
					}
					break;
				}
				case "unsupported":
					throw new Error(`Unsupported AgentFS entry type at ${JSON.stringify(file)}.`);
			}
		}
	});
	return changes;
}

type AgentFsEntryType = "d" | "f" | "l" | "unsupported";
type AgentFsChangeRecord = { file: string; type: AgentFsEntryType; deleted: false } | { file: string; deleted: true };

/** Reads structured delta paths from AgentFS's SQLite database; CLI `diff` cannot represent newlines safely. */
export function agentFsChangeRecords(database: string): AgentFsChangeRecord[] {
	const sqlite = new Database(database, { readonly: true, strict: true });
	try {
		const children = sqlite.query(
			"SELECT d.name, d.ino, i.mode FROM fs_dentry d JOIN fs_inode i ON d.ino = i.ino WHERE d.parent_ino = ? ORDER BY d.name",
		);
		const records: AgentFsChangeRecord[] = [];
		const directories: Array<{ inode: number; prefix: string }> = [{ inode: 1, prefix: "" }];
		const visited = new Set<number>([1]);
		for (const directory of directories) {
			for (const row of children.all(directory.inode) as Array<{ name: string; ino: number; mode: number }>) {
				const name = agentFsComponent(row.name);
				const file = directory.prefix ? `${directory.prefix}/${name}` : name;
				const type = agentFsType(row.mode);
				records.push({ file, type, deleted: false });
				if (type === "d") {
					if (visited.has(row.ino)) throw new Error(`AgentFS directory cycle at ${JSON.stringify(file)}.`);
					visited.add(row.ino);
					directories.push({ inode: row.ino, prefix: file });
				}
			}
		}
		for (const row of sqlite.query("SELECT path FROM fs_whiteout ORDER BY path").all() as Array<{ path: string }>) {
			records.push({ file: agentFsPath(row.path), deleted: true });
		}
		return records.toSorted((a, b) => a.file.localeCompare(b.file));
	} finally {
		sqlite.close();
	}
}

function agentFsComponent(name: string): string {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
		throw new Error(`Invalid AgentFS path component ${JSON.stringify(name)}.`);
	}
	return name;
}

function agentFsPath(value: string): string {
	const components = value.replace(/^\/+/, "").split("/").map(agentFsComponent);
	if (components.length === 0) throw new Error(`Invalid AgentFS path ${JSON.stringify(value)}.`);
	return components.join("/");
}

function agentFsType(mode: number): AgentFsEntryType {
	switch (mode & 0o170000) {
		case 0o040000:
			return "d";
		case 0o100000:
			return "f";
		case 0o120000:
			return "l";
		default:
			return "unsupported";
	}
}

async function cloneDatabase(fromDir: string, fromName: string, toDir: string, toName: string) {
	await fs.mkdir(toDir, { recursive: true });
	for (const file of await fs.readdir(fromDir)) {
		if (!file.startsWith(fromName)) continue;
		await Bun.write(path.join(toDir, file.replace(fromName, toName)), Bun.file(path.join(fromDir, file)));
	}
}

/**
 * A changed entry, as the mount shows it. AgentFS can record a change at a path where the mount has nothing, as after
 * a directory from before the run is emptied and removed and a file is then created: refuse, rather than guess.
 */
async function readChangedEntry(mount: string, file: string): Promise<FilesystemEntry> {
	try {
		return await readEntry(path.join(mount, file));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		throw new RefusedRunError(
			`${REFUSED}AgentFS recorded a change to ${JSON.stringify(file)} that the workspace doesn't have, which happens on macOS after removing a directory from before the run and then creating files. Remove the directory in a later run.`,
		);
	}
}

async function readEntry(file: string): Promise<FilesystemEntry> {
	const stats = await fs.lstat(file);
	if (stats.isFile()) return { type: "file", contents: await Bun.file(file).bytes(), mode: stats.mode & 0o7777 };
	if (stats.isSymbolicLink()) return { type: "symlink", target: await fs.readlink(file) };
	throw new Error(`Unsupported filesystem entry at ${JSON.stringify(file)}.`);
}

async function unmount(mount: string) {
	const result = await $`umount -f ${mount}`.nothrow().quiet();
	if (result.exitCode !== 0)
		throw new Error(`Could not unmount the shorthand workspace: ${result.stderr.toString().trim()}`);
}

function freePort(): number {
	const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	listener.stop(true);
	return listener.port;
}

async function waitForPort(port: number) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		try {
			const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
			socket.end();
			return;
		} catch {
			await Bun.sleep(2);
		}
	}
	throw new Error("AgentFS's NFS server didn't start.");
}
