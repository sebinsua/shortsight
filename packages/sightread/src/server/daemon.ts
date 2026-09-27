// Hold the graph and range cache behind a Unix socket.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, writeFile, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join, relative, sep } from "node:path";
import { nestedProjects, projectFiles, type Project } from "../project.ts";
import { runQuery } from "../query.ts";
import { createRangeIndex } from "../ranges.ts";
import { createReferenceIndex } from "../references.ts";
import { RequestError, startGraphClient } from "../upstream.ts";
import { serverPaths } from "./paths.ts";
import { projectSignature } from "./signature.ts";

interface Message {
	type: "ping" | "stop" | "help" | "query" | "values";
	requests?: Record<string, unknown>[];
	json?: boolean;
	mode?: "text" | "json" | "raw";
	in?: string;
	color?: boolean;
	cwd?: string;
	quietOnly?: boolean;
}

function duration(name: string, fallback: number): number {
	const number = Number(process.env[name]);
	return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Run until stopped, idle, or the project disappears. */
export async function runDaemon(project: Project): Promise<void> {
	if (process.env.SIGHTREAD_DAEMON_FAIL === "1") throw new Error("test daemon startup failure");
	if (process.env.SIGHTREAD_DAEMON_START_DELAY_MS) await Bun.sleep(duration("SIGHTREAD_DAEMON_START_DELAY_MS", 0));
	const startedAt = Date.now();
	const paths = serverPaths(project);
	const signature = await projectSignature(project);
	const client = await startGraphClient(project, { stderr: 2, cacheDirectory: join(paths.directory, "ttsc-cache") });
	const ranges = createRangeIndex(project.root);
	const fileCount = projectFiles(project).then((files) => files.size);
	const references = createReferenceIndex(project);
	const nested = nestedProjects(project);
	let lastUsed = startedAt;
	let active = 0;
	let closing = false;
	let finishActive: (() => void) | undefined;
	const idle = duration("SIGHTREAD_IDLE_MS", 20 * 60_000);
	const check = Math.min(duration("SIGHTREAD_MISSING_MS", 30_000), idle);
	const server = createServer((socket) => {
		let input = "";
		socket.on("error", () => undefined);
		socket.on("data", (chunk: Buffer) => {
			input += chunk.toString();
			const end = input.indexOf("\n");
			if (end < 0) return;
			socket.removeAllListeners("data");
			const raw = input.slice(0, end);
			if (raw.includes('"type":"query"') && process.env.SIGHTREAD_DAEMON_SOCKET_ERROR_ON_RESET === "1")
				setTimeout(() => socket.emit("error", new Error("ECONNRESET")), 25);
			void handle(socket, raw);
		});
	});

	async function writeState(): Promise<void> {
		const temporary = `${paths.state}.${randomUUID()}`;
		await writeFile(
			temporary,
			JSON.stringify({
				project: project.root,
				tsconfig: project.tsconfig,
				pid: process.pid,
				lastUsed,
				startedAt,
				signature,
			}),
		);
		await rename(temporary, paths.state);
	}

	async function shutdown(): Promise<void> {
		if (closing) return;
		closing = true;
		clearInterval(interval);
		server.close();
		if (active > 0)
			await new Promise<void>((resolve) => {
				finishActive = resolve;
			});
		try {
			await client.close();
		} finally {
			await ranges.close();
			await references.close();
			await unlink(paths.socket).catch(() => undefined);
			await unlink(paths.state).catch(() => undefined);
		}
	}

	async function handle(socket: Socket, raw: string): Promise<void> {
		active++;
		let stop = false;
		try {
			const message = JSON.parse(raw) as Message;
			if (message.type !== "ping" && message.type !== "stop") {
				lastUsed = Date.now();
				await writeState();
			}
			let value: unknown;
			switch (message.type) {
				case "ping":
					value = { signature, pid: process.pid, project: project.root, lastUsed, startedAt, active: active - 1 };
					break;
				case "stop":
					value = message.quietOnly && active > 1 ? false : null;
					stop = value !== false;
					if (!stop) break;
					if (process.env.SIGHTREAD_DAEMON_STOP_DELAY_MS)
						await Bun.sleep(duration("SIGHTREAD_DAEMON_STOP_DELAY_MS", 0));
					break;
				case "help":
					value = [
						...client.requestTypes(),
						{
							type: "references",
							fields: [
								{ name: "symbol", required: true, description: "Symbol name or handle." },
								{
									name: "includeDeclaration",
									required: false,
									description: "Include the declaration itself (default: false).",
								},
							],
						},
					].toSorted((a, b) => a.type.localeCompare(b.type));
					break;
				case "query":
					if (process.env.SIGHTREAD_DAEMON_QUERY_DELAY_MS)
						await Bun.sleep(duration("SIGHTREAD_DAEMON_QUERY_DELAY_MS", 0));
					value = await runQuery(
						{
							client,
							ranges,
							references,
							root: project.root,
							tsconfig: relative(project.root, project.tsconfig).replaceAll(sep, "/"),
							projectFileCount: await fileCount,
							nestedProjects: nested
								.map((directory) => relative(message.cwd ?? project.root, directory).replaceAll(sep, "/"))
								.slice(0, 5),
						},
						message.requests ?? [],
						{
							mode: message.mode ?? (message.json ? "json" : "text"),
							in: message.in,
							color: message.color,
						},
					);
					break;
				case "values":
					value = (await client.batch(message.requests ?? [])).map((result) => result.value);
					break;
				default:
					throw new Error("unknown server message");
			}
			if (message.type !== "ping" && message.type !== "stop") {
				lastUsed = Date.now();
				await writeState();
			}
			if (!socket.destroyed) socket.end(`${JSON.stringify({ value })}\n`);
		} catch (error) {
			if (!socket.destroyed)
				socket.end(
					`${JSON.stringify({ error: error instanceof Error ? error.message : String(error), full: error instanceof RequestError })}\n`,
				);
		} finally {
			active--;
			if (active === 0) finishActive?.();
			if (stop) void shutdown();
		}
	}

	const interval = setInterval(() => {
		if (active === 0 && (!existsSync(project.root) || Date.now() - lastUsed >= idle)) void shutdown();
	}, check);
	server.on("error", (error) => {
		console.error(error);
		process.exitCode = 1;
	});
	try {
		await writeState();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(paths.socket, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		clearInterval(interval);
		await client.close();
		await ranges.close();
		await references.close();
		await unlink(paths.state).catch(() => undefined);
		throw error;
	}
}
