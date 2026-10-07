import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
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
		if (current?.root === projectRoot) {
			if (!sameFiles(current.files, projectFiles(projectRoot))) disposeCurrent();
		} else {
			disposeCurrent();
		}
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
	const projects = files
		.filter((file) => /(^|[\\/])tsconfig(\.[\w-]+)?\.json$/.test(file))
		.map((file) => dirname(file));
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
			// Rename without aliases: by default a renamed declaration is re-exported as `new as old`, so importers
			// through a barrel keep the old name. typescript-refactors.ts keeps object literal keys unchanged instead.
			initializationOptions: { userPreferences: { providePrefixAndSuffixTextForRename: false } },
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

function sameFiles(left: Map<string, string>, right: Map<string, string>): boolean {
	return left.size === right.size && [...left].every(([file, signature]) => right.get(file) === signature);
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
	server.process[method]();
	for (const stream of [server.process.stdin, server.process.stdout, server.process.stderr])
		(stream as unknown as Record<typeof method, () => void>)[method]?.();
	process.removeListener("beforeExit", disposeCurrent);
	if (!referenced) process.once("beforeExit", disposeCurrent);
}

function disposeCurrent(): void {
	if (!current) return;
	const { connection, process: server } = current;
	current = undefined;
	connection.dispose();
	if (server.exitCode === null) server.kill("SIGKILL");
	server.unref();
}

function typeScriptExecutable(): string {
	const require = createRequire(import.meta.url);
	const typescriptPackage = require.resolve("typescript/package.json");
	const requireTypeScriptDependency = createRequire(typescriptPackage);
	const nativePackage = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
	const packageFile = requireTypeScriptDependency.resolve(nativePackage);
	return resolvePath(dirname(packageFile), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
}
