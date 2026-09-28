// Find or start a project daemon and exchange one JSON message per socket connection.
import { spawn } from "node:child_process";
import { open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { Project } from "../project.ts";
import type { RequestType } from "../upstream.ts";
import { withStartLock } from "./lock.ts";
import { serverPaths, stateParent, type ServerPaths } from "./paths.ts";
import { projectSignature } from "./signature.ts";

export interface ServerConnection {
	project: Project;
	pid: number;
	/** When the server process started, in epoch milliseconds, from `ping`. */
	startedAt: number;
	/** Rendered output, exactly what the CLI prints. */
	query(
		requests: Record<string, unknown>[],
		options: { mode?: "text" | "json" | "raw"; in?: string; color?: boolean; json?: boolean; cwd?: string },
	): Promise<string>;
	/** Upstream values, unchanged, one per request in input order. */
	values(requests: Record<string, unknown>[]): Promise<unknown[]>;
	requestTypes(): Promise<RequestType[]>;
	/** Stop this server, start a fresh one and return a connection to it. */
	restart(): Promise<ServerConnection>;
}

interface Ping {
	signature: string;
	pid: number;
	project: string;
	lastUsed: number;
	startedAt: number;
	active: number;
}

interface Response {
	value?: unknown;
	error?: string;
	full?: boolean;
}

export class ServerRequestError extends Error {
	constructor(
		message: string,
		readonly full: boolean,
	) {
		super(message);
	}
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const timeoutMessage = "server timed out; try sightread stop";
class SocketTimeoutError extends Error {}
class ServerStopError extends Error {}

function exchange(socketPath: string, message: object, timeout = 120_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let body = "";
		const timer = setTimeout(() => finish(new SocketTimeoutError(timeoutMessage)), timeout);
		function finish(error?: Error, value?: unknown) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		}
		socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
		socket.on("data", (chunk: Buffer) => {
			body += chunk.toString();
			const end = body.indexOf("\n");
			if (end < 0) return;
			try {
				const response = JSON.parse(body.slice(0, end)) as Response;
				if (typeof response.error === "string") finish(new ServerRequestError(response.error, response.full === true));
				else finish(undefined, response.value);
			} catch (error) {
				finish(error as Error);
			}
		});
		socket.on("error", (error) => finish(error));
		socket.on("end", () => finish(new Error("server connection closed")));
	});
}

async function ping(paths: ServerPaths): Promise<Ping | undefined> {
	try {
		const response = await exchange(paths.socket, { type: "ping" }, 1_000);
		if (!response || typeof response !== "object" || !("pid" in response)) return undefined;
		return response as Ping;
	} catch {
		return undefined;
	}
}

async function stopAt(paths: ServerPaths, quietOnly = false): Promise<void> {
	if (await ping(paths)) {
		try {
			if ((await exchange(paths.socket, { type: "stop", quietOnly }, 5_000)) === false) return;
		} catch (error) {
			if (error instanceof SocketTimeoutError) throw new ServerStopError(`server did not stop; see ${paths.log}`);
			/* It may have exited already. */
		}
		for (let index = 0; index < 50 && (await ping(paths)); index++) await pause(100);
		if (await ping(paths)) throw new ServerStopError(`server did not stop; see ${paths.log}`);
	}
	await unlink(paths.socket).catch(() => undefined);
	await unlink(paths.state).catch(() => undefined);
}

async function allStateDirectories(): Promise<string[]> {
	try {
		const entries = await readdir(stateParent(), { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => join(stateParent(), entry.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function pathFromDirectory(directory: string): Promise<ServerPaths | undefined> {
	try {
		const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as {
			project: string;
			tsconfig?: string;
		};
		const paths = serverPaths({
			root: state.project,
			tsconfig: state.tsconfig ?? join(state.project, "tsconfig.json"),
		});
		return paths.directory === directory ? paths : undefined;
	} catch {
		return undefined;
	}
}

const startTimeout = 30_000;

let announceStart: ((project: Project) => void) | undefined;
/** Say when a request has to start a server first, since that request takes much longer than the rest. */
export function onServerStart(announce: (project: Project) => void): void {
	announceStart = announce;
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function startingLockAlive(paths: ServerPaths): Promise<boolean> {
	try {
		const [pid, info] = await Promise.all([readFile(join(paths.lock, "pid"), "utf8"), stat(paths.lock)]);
		return Date.now() - info.mtimeMs < startTimeout && pidAlive(Number(pid));
	} catch {
		return false;
	}
}

// Each graph server holds a whole program in memory (400–900 MB on large repositories), so keep few running.
// Only quiet servers make room: agents in parallel worktrees never stop each other's servers or wait for a slot,
// and servers over the limit stop once they're quiet and another starts, or when they idle out.
async function evictQuiet(current: string): Promise<void> {
	const maximum = Math.max(1, Number(process.env.SIGHTREAD_MAX_SERVERS) || 2);
	const configured = Number(process.env.SIGHTREAD_QUIET_MS);
	const quiet = process.env.SIGHTREAD_QUIET_MS && Number.isFinite(configured) ? configured : 5 * 60_000;
	const servers: { paths: ServerPaths; lastUsed: number; active: number }[] = [];
	let reservations = 0;
	for (const directory of await allStateDirectories()) {
		if (directory === current) continue;
		const paths = await pathFromDirectory(directory);
		if (!paths) continue;
		if (await startingLockAlive(paths)) {
			reservations++;
			continue;
		}
		let state: { state?: string; pid?: number; startedAt?: number } | undefined;
		try {
			state = JSON.parse(await readFile(paths.state, "utf8")) as { state?: string; pid?: number; startedAt?: number };
			if (state.state === "starting") {
				if (
					typeof state.startedAt === "number" &&
					Date.now() - state.startedAt < startTimeout &&
					pidAlive(state.pid ?? 0)
				) {
					reservations++;
					continue;
				}
				await unlink(paths.state).catch(() => undefined);
				continue;
			}
		} catch {
			// A daemon may replace its reservation while we inspect it.
		}
		const live = await ping(paths);
		if (live) servers.push({ paths, lastUsed: live.lastUsed, active: live.active });
		else if (state?.startedAt && Date.now() - state.startedAt < startTimeout && pidAlive(state.pid ?? 0))
			reservations++;
	}
	const need = Math.max(0, servers.length + reservations - maximum + 1);
	const idle = servers.filter((server) => server.active === 0 && Date.now() - server.lastUsed >= quiet);
	for (const server of idle.toSorted((a, b) => a.lastUsed - b.lastUsed).slice(0, need))
		await stopAt(server.paths, true);
}

async function start(paths: ServerPaths, project: Project, signature: string): Promise<Ping> {
	announceStart?.(project);
	await withStartLock(join(paths.parent, "start.lock"), async () => {
		await evictQuiet(paths.directory);
		await writeFile(
			paths.state,
			JSON.stringify({
				state: "starting",
				project: project.root,
				tsconfig: project.tsconfig,
				pid: process.pid,
				startedAt: Date.now(),
				lastUsed: Date.now(),
				signature,
			}),
		);
	});
	await rm(paths.socket, { force: true });
	const log = await open(paths.log, "a");
	try {
		const child = spawn(
			process.execPath,
			[join(import.meta.dir, "../cli.ts"), "--daemon", project.root, project.tsconfig],
			{
				cwd: project.root,
				detached: true,
				stdio: ["ignore", log.fd, log.fd],
			},
		);
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("spawn", resolve);
		});
		child.unref();
	} finally {
		await log.close();
	}
	const attempts = process.env.SIGHTREAD_DAEMON_FAIL === "1" ? 5 : 300;
	for (let index = 0; index < attempts; index++) {
		const live = await ping(paths);
		if (live?.signature === signature) return live;
		await pause(100);
	}
	await unlink(paths.state).catch(() => undefined);
	throw new Error(`server did not start; see ${paths.log}`);
}

function connection(project: Project, live: Ping, paths: ServerPaths): ServerConnection {
	const retry = async <T>(message: object): Promise<T> => {
		try {
			return (await exchange(paths.socket, message)) as T;
		} catch (error) {
			if (error instanceof ServerRequestError || error instanceof SocketTimeoutError) throw error;
			await connect(project);
			return exchange(serverPaths(project).socket, message) as Promise<T>;
		}
	};
	return {
		project,
		pid: live.pid,
		startedAt: live.startedAt,
		query: (requests, options) => retry<string>({ type: "query", requests, ...options }),
		values: (requests) => retry<unknown[]>({ type: "values", requests }),
		requestTypes: () => retry<RequestType[]>({ type: "help" }),
		restart: async () => {
			await withStartLock(paths.lock, async () => {
				await stopAt(paths);
			});
			return connect(project);
		},
	};
}

/** Find a live server with the current signature, or start one. */
export async function connect(project: Project): Promise<ServerConnection> {
	const paths = serverPaths(project);
	const signature = await projectSignature(project);
	const existing = await ping(paths);
	if (existing?.signature === signature && existing.project === project.root)
		return connection(project, existing, paths);
	const live = await withStartLock(paths.lock, async () => {
		const locked = await ping(paths);
		if (locked?.signature === signature && locked.project === project.root) return locked;
		await stopAt(paths);
		return start(paths, project, signature);
	});
	return connection(project, live, paths);
}

export async function listServers(): Promise<Array<{ pid: number; project: string; lastUsed: number }>> {
	const result: Array<{ pid: number; project: string; lastUsed: number }> = [];
	for (const directory of await allStateDirectories()) {
		const paths = await pathFromDirectory(directory);
		if (!paths) continue;
		const live = await ping(paths);
		if (live) result.push({ pid: live.pid, project: live.project, lastUsed: live.lastUsed });
	}
	return result.toSorted((a, b) => a.project.localeCompare(b.project));
}

export async function stopServer(project: Project): Promise<void> {
	const paths = serverPaths(project);
	await withStartLock(paths.lock, () => stopAt(paths));
}

export async function stopAllServers(): Promise<void> {
	for (const directory of await allStateDirectories()) {
		const paths = await pathFromDirectory(directory);
		if (paths) await withStartLock(paths.lock, () => stopAt(paths));
	}
}
