/** Host-side journal broker for the native Linux observer. */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { homedir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { TransactionJournal } from "../transaction/transaction-journal.ts";
import { diagnosticCounter, measure } from "../runner/diagnostics.ts";

type InvocationState = "expected" | "active" | "finished";

const FRAME_HEADER_SIZE = 9;
const MAX_FIELD_SIZE = 4096;
const MAX_FRAME_SIZE = FRAME_HEADER_SIZE + 2 * MAX_FIELD_SIZE;

function decodeFrame(buffer: Buffer): { kind: string; first: string; second: string } | undefined {
	if (buffer.length > MAX_FRAME_SIZE) throw new Error("Oversized observation request");
	if (buffer.length < FRAME_HEADER_SIZE) return undefined;
	const firstSize = buffer.readUInt32BE(1);
	const secondSize = buffer.readUInt32BE(5);
	if (firstSize > MAX_FIELD_SIZE || secondSize > MAX_FIELD_SIZE) throw new Error("Oversized observation path");
	const frameSize = FRAME_HEADER_SIZE + firstSize + secondSize;
	if (buffer.length < frameSize) return undefined;
	if (buffer.length !== frameSize) throw new Error("Unexpected observation framing");

	const firstBytes = buffer.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + firstSize);
	const secondBytes = buffer.subarray(FRAME_HEADER_SIZE + firstSize);
	const first = firstBytes.toString();
	const second = secondBytes.toString();
	if (!Buffer.from(first).equals(firstBytes) || !Buffer.from(second).equals(secondBytes))
		throw new Error("Non-UTF8 observation path");
	return { kind: String.fromCharCode(buffer[0]), first, second };
}

export async function openLinuxObservation(repo: string, temporary: string) {
	const helper = await measure("preparing native observer", observerHelper);
	const socketPath = path.join(temporary, "observer.sock");
	const invocations = new Map<string, InvocationState>();
	const journal = new TransactionJournal(repo);
	const connections = new Set<Socket>();
	const completedConnections = new Set<Socket>();
	const pending = new Set<Promise<void>>();
	let closing = false;
	const server = createServer((socket) => {
		connections.add(socket);
		const operation = (async () => {
			let authenticated = false;
			let token: string | undefined;
			let finished = false;
			let buffer: Buffer = Buffer.alloc(0);
			try {
				for await (const data of socket) {
					buffer = Buffer.concat([buffer, Buffer.from(data)]);
					const frame = decodeFrame(buffer);
					if (!frame) continue;
					if (finished) throw new Error("Unexpected observation framing");
					const { kind, first, second } = frame;
					buffer = Buffer.alloc(0);
					if (!authenticated) {
						if (closing || kind !== "H" || invocations.get(first) !== "expected" || second)
							throw new Error("Unauthenticated observer");
						authenticated = true;
						token = first;
						invocations.set(token, "active");
					} else if (kind === "F" && !first && !second) {
						finished = true;
						invocations.set(token!, "finished");
						completedConnections.add(socket);
					} else if (kind === "X") throw new Error(first);
					else if (kind === "R") await journal.observeRename(first, second);
					else if (second) throw new Error("Unexpected second observation path");
					else if (kind === "T") await journal.observeTree(first);
					else if (kind === "D") await journal.observeDirectory(first);
					else if (kind === "M") await journal.observe(first, "metadata");
					else if (kind === "C") await journal.observe(first, "contents");
					else throw new Error(`Unknown observation kind ${kind}`);
					socket.write(Buffer.from([1]));
				}
				if (!authenticated || !finished || buffer.length) throw new Error("Observer disconnected before completion");
			} catch (error) {
				journal.invalidate(error instanceof Error ? error.message : String(error));
				socket.destroy();
			} finally {
				connections.delete(socket);
				completedConnections.delete(socket);
			}
		})();
		pending.add(operation);
		void operation.finally(() => pending.delete(operation));
	});
	server.listen(socketPath);
	try {
		await once(server, "listening");
		await fs.chmod(socketPath, 0o600);
	} catch (error) {
		for (const socket of connections) socket.destroy();
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		throw error;
	}
	return {
		journal,
		wrap: (command: string[]) => {
			const secret = randomBytes(32).toString("hex");
			invocations.set(secret, "expected");
			return [helper, socketPath, secret, repo, ...command];
		},
		async finish() {
			closing = true;
			const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
			if ([...connections].some((socket) => !completedConnections.has(socket))) {
				journal.invalidate("Observer remained active after execution stopped");
			}
			for (const socket of connections) {
				if (completedConnections.has(socket)) socket.end();
				else socket.destroy();
			}
			await Promise.all([stopped, ...pending]);
			if (!invocations.size || [...invocations.values()].some((state) => state !== "finished"))
				journal.invalidate("Not every expected observer completed");
			diagnosticCounter("observed entries", journal.entryCount);
			diagnosticCounter("content captures", journal.contentCaptureCount);
			await journal.seal();
			return await measure("validating observed dependencies", () => journal.conflicts());
		},
	};
}

async function observerHelper(): Promise<string> {
	const source = path.join(import.meta.dir, "linux-observer.c");
	const digest = createHash("sha256")
		.update(await fs.readFile(source))
		.digest("hex")
		.slice(0, 16);
	const directory = path.join(homedir(), ".cache", "pi-shorthand", "native");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await fs.lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
		throw new Error("Unsafe native helper directory");
	await fs.chmod(directory, 0o700);
	const helper = path.join(directory, `linux-observer-${digest}`);
	try {
		const existing = await fs.lstat(helper);
		if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== info.uid || existing.mode & 0o022)
			throw new Error("Unsafe native observer helper");
		return helper;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const compiler = Bun.which("cc") ?? Bun.which("gcc");
	if (!compiler) throw new Error("shorthand needs a C compiler on Linux to build its cached observation helper.");
	const temporary = `${helper}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await $`${compiler} -O2 -Wall -Wextra ${source} -o ${temporary}`.quiet();
		await fs.chmod(temporary, 0o700);
		await fs.rename(temporary, helper);
	} finally {
		await fs.rm(temporary, { force: true });
	}
	return helper;
}
