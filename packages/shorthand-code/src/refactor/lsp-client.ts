import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { API, type Project, type Snapshot } from "typescript/unstable/async";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from "vscode-jsonrpc/node";

interface TypeScriptServer {
	root: string;
	process: ChildProcessWithoutNullStreams;
	connection: MessageConnection;
	files: Map<string, string>;
	/** Files opened so their projects load, by version: their text overrides the disk, so it's kept current. */
	opened: Map<string, number>;
	/** TypeScript's checker on the same files, started when first needed. */
	checker?: Checker;
}

/**
 * A checker API session beside the language server: the server renames, and the checker answers what the server
 * can't, such as which symbol a place means or which file an import resolves to. It opens every tsconfig rather
 * than files, as an opened file keeps the contents it had then, and is told of each change the server is.
 */
interface Checker {
	api: API;
	snapshot: Snapshot;
	pending: { changed: Set<string>; created: Set<string>; deleted: Set<string> };
}

let current: TypeScriptServer | undefined;
let operations = Promise.resolve();
process.once("exit", disposeCurrent);

export async function withTypeScriptServer<T>(
	root: string,
	use: (connection: MessageConnection) => Promise<T>,
): Promise<T> {
	const result = operations.then(async () => {
		const projectRoot = realpathSync(root);
		if (current?.root === projectRoot) await catchUp(current, projectFiles(projectRoot));
		else disposeCurrent();
		if (!current) {
			current = await startTypeScriptServer(projectRoot);
		}
		const server = current;
		setReferenced(server, true);
		try {
			return await use(server.connection);
		} finally {
			if (current === server) setReferenced(server, false);
		}
	});
	operations = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/** Keep a reused server current; a failed notification only forfeits reuse of that server. */
export async function notifyTypeScriptServer(
	connection: MessageConnection,
	method: string,
	params: unknown,
): Promise<void> {
	try {
		await connection.sendNotification(method, params);
	} catch {
		if (current?.connection === connection) disposeCurrent();
	}
}

export function recordTypeScriptFiles(connection: MessageConnection, files: string[]): void {
	if (current?.connection !== connection) return;
	for (const file of files) {
		const value = fingerprint(file);
		const pending = current.checker?.pending;
		if (pending) (value ? (current.files.has(file) ? pending.changed : pending.created) : pending.deleted).add(file);
		if (value) current.files.set(file, value);
		else current.files.delete(file);
		const version = current.opened.get(file);
		if (version === undefined) continue;
		const uri = pathToFileURL(file).href;
		if (!value) {
			current.opened.delete(file);
			void connection.sendNotification("textDocument/didClose", { textDocument: { uri } }).catch(() => {});
			continue;
		}
		current.opened.set(file, version + 1);
		void connection
			.sendNotification("textDocument/didChange", {
				textDocument: { uri, version: version + 1 },
				contentChanges: [{ text: documentText(file) }],
			})
			.catch(() => {});
	}
}

export interface Diagnostic {
	code?: number | string;
	/** 1 is an error; warnings, hints and suggestions such as an unused name are higher. */
	severity?: number;
	message: string;
	range: { start: { line: number; character: number } };
}

/**
 * A file's type errors and other diagnostics, as the server sees the file on disk now. The server only checks open
 * documents, so a file that isn't open is opened for the request and closed again.
 */
export async function documentDiagnostics(connection: MessageConnection, file: string): Promise<Diagnostic[]> {
	const uri = pathToFileURL(file).href;
	const open = current?.connection === connection && current.opened.has(file);
	if (!open)
		await connection.sendNotification("textDocument/didOpen", {
			textDocument: { uri, languageId: languageId(file), version: 1, text: documentText(file) },
		});
	try {
		const report = await connection.sendRequest<{ items?: Diagnostic[] } | null>("textDocument/diagnostic", {
			textDocument: { uri },
		});
		return report?.items ?? [];
	} finally {
		if (!open) await connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
	}
}

/**
 * The checker's view of the files now, and the project holding `file` in it, if any: a file outside every
 * tsconfig has none.
 */
export async function checkerProject(connection: MessageConnection, file: string): Promise<Project | undefined> {
	if (current?.connection !== connection) return undefined;
	const server = current;
	if (!server.checker) {
		const api = new API({ cwd: server.root });
		const projects = [...server.files.keys()].filter((candidate) => CONFIG.test(candidate));
		server.checker = {
			api,
			snapshot: await api.updateSnapshot({ openProjects: projects }),
			pending: { changed: new Set(), created: new Set(), deleted: new Set() },
		};
		// Unreferenced once and for all, so it doesn't keep the program running: while a refactor waits on it, the
		// server is referenced. (Referenced again, Bun keeps its output stream referenced after all.)
		const child = checkerProcess(server.checker);
		for (const handle of [child, child?.stdin, child?.stdout, child?.stderr])
			(handle as unknown as { unref?: () => void } | null | undefined)?.unref?.();
	}
	const checker = server.checker;
	const { changed, created, deleted } = checker.pending;
	if (changed.size || created.size || deleted.size) {
		checker.pending = { changed: new Set(), created: new Set(), deleted: new Set() };
		checker.snapshot = await checker.api.updateSnapshot({
			fileChanges: { changed: [...changed], created: [...created], deleted: [...deleted] },
		});
	}
	for (const project of checker.snapshot.getProjects())
		if (await project.program.getSourceFile(file).catch(() => undefined)) return project;
	return undefined;
}

const CONFIG = /(^|[\\/])tsconfig(\.[\w-]+)?\.json$/;

/** A file's text as the server reads it from disk: without a byte order mark, which it doesn't count. */
function documentText(file: string): string {
	return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

function languageId(file: string): string {
	if (/\.[cm]?tsx$/.test(file)) return "typescriptreact";
	if (/\.[cm]?jsx$/.test(file)) return "javascriptreact";
	return /\.[cm]?js$/.test(file) ? "javascript" : "typescript";
}

/**
 * Opens a script in each TypeScript project, so rename and references see them all: the server only loads the
 * projects of files it has open, and in a monorepo of project references (`"files": [], "references": [...]`) an
 * edit's importers can be in another one.
 */
async function openEveryProject(connection: MessageConnection, root: string): Promise<Map<string, number>> {
	const files = [...projectFiles(root).keys()];
	const scripts = files.filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !file.endsWith(".d.ts"));
	const projects = files.filter((file) => CONFIG.test(file)).map((file) => dirname(file));
	const opened = new Map<string, number>();
	for (const project of projects) {
		const script = scripts.find((file) => file.startsWith(project + sep) && !file.includes(`${sep}node_modules${sep}`));
		if (!script || opened.has(script)) continue;
		opened.set(script, 1);
		await connection.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri: pathToFileURL(script).href,
				languageId: languageId(script),
				version: 1,
				text: documentText(script),
			},
		});
	}
	return opened;
}

async function startTypeScriptServer(root: string): Promise<TypeScriptServer> {
	const server = spawn(typeScriptExecutable(), ["--lsp", "--stdio"], { cwd: root, env: process.env });
	await new Promise<void>((ready, reject) => {
		server.once("spawn", ready);
		server.once("error", reject);
	});
	let opened = new Map<string, number>();
	const connection = createMessageConnection(
		new StreamMessageReader(server.stdout),
		new StreamMessageWriter(server.stdin),
	);
	connection.listen();
	try {
		await connection.sendRequest("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(root).href,
			// Renames keep what other code sees, as aliases typescript-refactors.ts then follows: `{ old: new }`.
			initializationOptions: { userPreferences: { providePrefixAndSuffixTextForRename: true } },
			capabilities: {
				workspace: {
					workspaceEdit: { documentChanges: true },
					fileOperations: { didRename: true, willRename: true },
				},
				textDocument: { rename: { prepareSupport: true } },
			},
		});
		await connection.sendNotification("initialized", {});
		opened = await openEveryProject(connection, root);
	} catch (error) {
		connection.dispose();
		if (server.exitCode === null) server.kill("SIGKILL");
		throw error;
	}
	server.stderr.resume();
	const started = { root, process: server, connection, files: projectFiles(root), opened };
	server.once("exit", () => {
		if (current?.process !== server) return;
		connection.dispose();
		current = undefined;
	});
	setReferenced(started, false);
	return started;
}

/**
 * Brings a running server up to date with files the program changed since its last call, with `edit`, `sg` or
 * its own writes, rather than starting it again. A changed tsconfig or package.json can change which projects
 * exist, so the server starts again for those.
 */
async function catchUp(server: TypeScriptServer, files: Map<string, string>): Promise<void> {
	const changed = [...files].filter(
		([file, signature]) => server.files.has(file) && server.files.get(file) !== signature,
	);
	const created = [...files.keys()].filter((file) => !server.files.has(file));
	const deleted = [...server.files.keys()].filter((file) => !files.has(file));
	if (!changed.length && !created.length && !deleted.length) return;
	const configuration = /(^|[\\/])(?:tsconfig(?:\.[\w-]+)?|jsconfig|package)\.json$/;
	if ([...changed.map(([file]) => file), ...created, ...deleted].some((file) => configuration.test(file))) {
		disposeCurrent();
		return;
	}
	const touched = [...changed.map(([file]) => file), ...created, ...deleted];
	recordTypeScriptFiles(server.connection, touched);
	await notifyTypeScriptServer(server.connection, "workspace/didChangeWatchedFiles", {
		changes: [
			...changed.map(([file]) => ({ uri: pathToFileURL(file).href, type: 2 })),
			...created.map((file) => ({ uri: pathToFileURL(file).href, type: 1 })),
			...deleted.map((file) => ({ uri: pathToFileURL(file).href, type: 3 })),
		],
	});
}

function projectFiles(root: string): Map<string, string> {
	// The runner only applies Git-visible files, so ignored build output cannot make reuse stale.
	const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		encoding: "utf8",
	});
	if (listed.status === 0) {
		return new Map(
			listed.stdout
				.split("\0")
				.filter((file) => file && /\.(?:[cm]?[jt]sx?|json)$/.test(file))
				.flatMap((file) => {
					const absolute = resolvePath(root, file);
					const value = fingerprint(absolute);
					return value ? [[absolute, value] as const] : [];
				}),
		);
	}

	const files = new Map<string, string>();
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const file = resolvePath(directory, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) {
				files.set(file, fingerprint(file)!);
			}
		}
	};
	visit(root);
	return files;
}

function fingerprint(file: string): string | undefined {
	const stats = statSync(file, { bigint: true, throwIfNoEntry: false });
	return stats?.isFile() ? `${stats.mtimeNs}:${stats.size}` : undefined;
}

function setReferenced(server: TypeScriptServer, referenced: boolean): void {
	const method = referenced ? "ref" : "unref";
	for (const handle of [server.process, server.process.stdin, server.process.stdout, server.process.stderr])
		(handle as unknown as Record<typeof method, (() => void) | undefined>)[method]?.();
	process.removeListener("beforeExit", disposeCurrent);
	if (!referenced) process.once("beforeExit", disposeCurrent);
}

function disposeCurrent(): void {
	if (!current) return;
	const { connection, process: server, checker } = current;
	current = undefined;
	connection.dispose();
	// Closing only asks the checker's process to end; the runner waits for a program's processes to exit.
	const checkerChild = checkerProcess(checker);
	void checker?.api.close().catch(() => {});
	if (checkerChild?.exitCode === null) checkerChild.kill("SIGKILL");
	if (server.exitCode === null) server.kill("SIGKILL");
	server.unref();
}

/** The checker's process, which is the API client's own: reached so it doesn't keep the program running. */
function checkerProcess(checker: Checker | undefined): ChildProcessWithoutNullStreams | undefined {
	return (checker?.api as unknown as { client?: { process?: ChildProcessWithoutNullStreams } } | undefined)?.client
		?.process;
}

function typeScriptExecutable(): string {
	const require = createRequire(import.meta.url);
	const typescriptPackage = require.resolve("typescript/package.json");
	const requireTypeScriptDependency = createRequire(typescriptPackage);
	const nativePackage = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
	const packageFile = requireTypeScriptDependency.resolve(nativePackage);
	return resolvePath(dirname(packageFile), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
}
