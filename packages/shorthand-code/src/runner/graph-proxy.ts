/** A lazy host-side graph connection for sandboxed shorthand programs. */
import { createServer, type Server, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface GraphLibrary {
	openGraph(options: { cwd: string }): Promise<{
		query(request: Record<string, unknown> | Record<string, unknown>[]): Promise<unknown>;
		close(): Promise<void>;
	}>;
}

type Importer = (specifier: string) => Promise<unknown>;
let cached: Promise<GraphLibrary | undefined> | undefined;

interface ResolveOptions {
	importer?: Importer;
	importedEntry?: string;
	executable?: string | null;
	cache?: boolean;
	strictVersion?: boolean;
}

function library(value: unknown): GraphLibrary | undefined {
	if (typeof value === "object" && value !== null && "openGraph" in value && typeof value.openGraph === "function")
		return value as GraphLibrary;
	return undefined;
}

interface SightreadManifest {
	name?: string;
	version?: string;
	exports?: { "."?: string };
}

async function packageFromPath(path: string): Promise<{ directory: string; manifest: SightreadManifest } | undefined> {
	const target = await realpath(path);
	let directory = dirname(target);
	for (;;) {
		try {
			const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as SightreadManifest;
			if (manifest.name === "sightread") return { directory, manifest };
		} catch {
			// Keep looking for the package that owns the executable or entry point.
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

/** An executable on PATH, found with plain filesystem calls: Pi runs extensions under Node, where Bun.which doesn't exist. */
function findExecutable(name: string): string | undefined {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not in this directory.
		}
	}
	return undefined;
}

async function expectedVersion(): Promise<string> {
	return (JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string })
		.version;
}

/**
 * Whether a sightread matching this version is installed, found through module resolution or a `sightread` on
 * PATH. It reads package.json and never imports sightread, because Pi calls it under Node and sightread needs Bun.
 */
export async function sightreadAvailable(executable = findExecutable("sightread")): Promise<boolean> {
	const expected = await expectedVersion();
	const candidates: string[] = [];
	try {
		candidates.push(createRequire(import.meta.url).resolve("sightread/package.json"));
	} catch {
		// Not in this package's dependency tree; a global install may still be on PATH.
	}
	if (executable) candidates.push(executable);
	for (const candidate of candidates) {
		const found = await packageFromPath(candidate).catch(() => undefined);
		if (found?.manifest.version === expected) return true;
	}
	return false;
}

/** Resolve once in production; explicit options make both lookup routes testable. */
export function resolveSightread(options: ResolveOptions = {}) {
	const importer = options.importer ?? ((specifier: string) => import(specifier));
	const executable = options.executable === undefined ? findExecutable("sightread") : options.executable;
	const find = async (): Promise<GraphLibrary | undefined> => {
		const expected = await expectedVersion();
		let mismatch: string | undefined;
		let direct: GraphLibrary | undefined;
		try {
			direct = library(await importer("sightread"));
		} catch {
			// A global CLI can be outside this package's dependency tree.
		}
		if (direct) {
			let found: Awaited<ReturnType<typeof packageFromPath>> = undefined;
			try {
				found = await packageFromPath(options.importedEntry ?? fileURLToPath(import.meta.resolve("sightread")));
			} catch {
				// Try the executable if the imported package has no readable manifest.
			}
			if (found) {
				if (found.manifest.version === expected) return direct;
				mismatch = found.manifest.version ?? "unknown";
			}
		}
		if (executable) {
			const found = await packageFromPath(executable).catch(() => undefined);
			if (found) {
				if (found.manifest.version !== expected) mismatch ??= found.manifest.version ?? "unknown";
				else if (typeof found.manifest.exports?.["."] === "string") {
					try {
						const fromPath = library(
							await importer(pathToFileURL(resolve(found.directory, found.manifest.exports["."])).href),
						);
						if (fromPath) return fromPath;
					} catch {
						// A matching install whose entry point failed to load is unavailable.
					}
				}
			}
		}
		if (mismatch !== undefined && options.strictVersion)
			throw new Error(`graph needs sightread ${expected} (found ${mismatch}); npm i -g sightread@${expected}`);
		return undefined;
	};
	return options.cache === false || options.strictVersion ? find() : (cached ??= find());
}

export const GRAPH_INSTALL_MESSAGE =
	"graph needs the sightread package; install it alongside shorthand-code (npm i -g sightread)";
const GRAPH_DISABLED_MESSAGE = "graph.query isn't available in this session.";

async function sourceHashes(value: unknown, repo: string): Promise<Record<string, string>> {
	const results = Array.isArray(value) ? value : [value];
	const files = new Set<string>();
	for (const result of results) {
		if (typeof result !== "object" || result === null) continue;
		const graph = result as { nodes?: { file?: string }[]; edges?: { at?: { file?: string } }[] };
		for (const node of graph.nodes ?? []) if (node.file) files.add(node.file);
		for (const edge of graph.edges ?? []) if (edge.at?.file) files.add(edge.at.file);
	}
	const hashes: Record<string, string> = {};
	await Promise.all(
		[...files].map(async (file) => {
			const absolute = resolve(repo, file);
			const fromRoot = relative(repo, absolute);
			if (isAbsolute(file) || fromRoot === ".." || fromRoot.startsWith("../")) return;
			try {
				hashes[file] = createHash("sha256")
					.update(await readFile(absolute))
					.digest("hex");
			} catch {
				// Missing sources already have no usable ranges.
			}
		}),
	);
	return hashes;
}

/** Open the socket before spawning the program; load sightread only on the first query. */
export async function openGraphProxy(
	directory: string,
	cwd: string,
	repo: string,
	options: { delayMs?: number; disabled?: boolean; resolve?: () => Promise<GraphLibrary | undefined> } = {},
): Promise<{ path: string; close(): Promise<void> }> {
	const socketPath = join(directory, "graph.sock");
	let graph: Awaited<ReturnType<GraphLibrary["openGraph"]>> | undefined;
	let opening: Promise<Awaited<ReturnType<GraphLibrary["openGraph"]>>> | undefined;
	let closed = false;
	const sockets = new Set<Socket>();
	const refused = new Set<Socket>();
	const server: Server = createServer((socket) => {
		if (sockets.size >= 16) {
			refused.add(socket);
			socket.on("error", () => undefined);
			socket.on("close", () => refused.delete(socket));
			socket.end(`${JSON.stringify({ error: "graph proxy allows at most 16 connections" })}\n`);
			return;
		}
		sockets.add(socket);
		socket.on("error", () => undefined);
		socket.on("close", () => sockets.delete(socket));
		const reply = (response: unknown) => {
			if (socket.destroyed) return;
			try {
				socket.write(`${JSON.stringify(response)}\n`);
			} catch {
				socket.destroy();
			}
		};
		let buffer = "";
		let chain = Promise.resolve();
		let rejecting = false;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			if (rejecting) return;
			buffer += chunk;
			for (;;) {
				const end = buffer.indexOf("\n");
				if (end < 0) {
					if (Buffer.byteLength(buffer, "utf8") > 1024 * 1024) {
						rejecting = true;
						buffer = "";
						socket.end(`${JSON.stringify({ error: "graph proxy request line exceeds 1 MiB" })}\n`);
					}
					break;
				}
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
					rejecting = true;
					buffer = "";
					socket.end(`${JSON.stringify({ error: "graph proxy request line exceeds 1 MiB" })}\n`);
					break;
				}
				chain = chain.then(async () => {
					try {
						const request = JSON.parse(line) as Record<string, unknown> | Record<string, unknown>[];
						const handle = await (opening ??= (async () => {
							if (options.disabled) throw new Error(GRAPH_DISABLED_MESSAGE);
							if (options.delayMs) await Bun.sleep(options.delayMs);
							return (options.resolve ?? (() => resolveSightread({ strictVersion: true })))();
						})().then(async (found) => {
							if (!found) throw new Error(GRAPH_INSTALL_MESSAGE);
							const opened = await found.openGraph({ cwd });
							if (closed) {
								void Promise.resolve()
									.then(() => opened.close())
									.catch(() => undefined);
								throw new Error("graph proxy is closed");
							}
							return (graph = opened);
						}));
						const value = await handle.query(request);
						reply({ value, sources: await sourceHashes(value, repo) });
					} catch (error) {
						reply({ error: error instanceof Error ? error.message : String(error) });
					}
				});
			}
		});
	});
	server.on("error", () => undefined);
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(socketPath, done);
	});
	return {
		path: socketPath,
		async close() {
			closed = true;
			for (const socket of [...sockets, ...refused]) socket.destroy();
			await new Promise<void>((done) => server.close(() => done()));
			await graph?.close();
		},
	};
}
