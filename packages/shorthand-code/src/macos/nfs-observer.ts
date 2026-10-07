/** NFSv3/RPC observation in front of AgentFS; storage and filesystem operations stay in AgentFS.
 * Wire layouts: RFC 1813 and RFC 5531. Unknown handles/protocols permanently invalidate the journal.
 */
import * as path from "node:path";
import {
	IncompleteObservationError,
	TransactionJournal,
	type Observation,
} from "../transaction/transaction-journal.ts";

export class XdrReader {
	private offset = 0;
	constructor(private readonly buffer: Buffer) {}
	get position(): number {
		return this.offset;
	}
	u32(): number {
		const value = this.take(4).readUInt32BE();
		return value;
	}
	take(length: number): Buffer {
		if (!Number.isSafeInteger(length) || length < 0 || length > this.buffer.length - this.offset) {
			throw new IncompleteObservationError("truncated XDR record");
		}
		const value = this.buffer.subarray(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}
	opaque(limit = 1024 * 1024): Buffer {
		const length = this.u32();
		if (length > limit) throw new IncompleteObservationError("oversized XDR value");
		const value = this.take(length);
		this.take((4 - (length % 4)) % 4);
		return value;
	}
	bool(): boolean {
		const value = this.u32();
		if (value > 1) throw new IncompleteObservationError("invalid XDR boolean");
		return value === 1;
	}
	postAttributes(): void {
		if (this.bool()) this.take(84);
	}
}

/** Resolves to a replacement reply when the observer rewrites one, as for hidden directory entries. */
type ReplyObserver = (reply: Buffer) => Promise<Buffer | void>;
type AfterReply = (response: XdrReader, reply: Buffer) => void | Buffer | Promise<void | Buffer>;
const nothing = () => {};

/**
 * macOS stores extended attributes of files on an NFSv3 mount in AppleDouble "._name" files beside them,
 * and it adds one (com.apple.provenance) to every file a program writes. Those files never reach the
 * repository, but a program listing a directory would see them, so listings leave out the ones created
 * during the run for a file it had already touched. Existing "._" files in the repository stay visible.
 */
const APPLE_DOUBLE = "._";

export class NfsObserver {
	private readonly handles = new Map<string, Set<string>>();
	private readonly appleDouble = new Set<string>();
	constructor(private readonly journal: TransactionJournal) {}

	/** The transport must serialize request + response pairs across all connections. */
	async before(message: Buffer): Promise<ReplyObserver> {
		try {
			return await this.prepare(message);
		} catch (error) {
			this.journal.invalidate(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	private async prepare(message: Buffer): Promise<ReplyObserver> {
		const request = new XdrReader(message);
		const xid = request.u32();
		if (request.u32() !== 0 || request.u32() !== 2) throw new IncompleteObservationError("unsupported RPC call");
		const program = request.u32();
		const version = request.u32();
		const procedure = request.u32();
		for (let i = 0; i < 2; i++) {
			const flavor = request.u32();
			if (flavor !== 0 && flavor !== 1) throw new IncompleteObservationError("unsupported RPC authentication");
			request.opaque(400);
		}
		let after: AfterReply = nothing;
		// macOS sends the v1 UMNT procedure even for an NFSv3 mount. Only the
		// no-handle lifecycle calls have the same interpretation across versions.
		if (program === 100005 && (version === 3 || (version === 1 && [0, 3, 4].includes(procedure)))) {
			if (procedure === 1) {
				const exportPath = request.opaque(1024).toString();
				if (exportPath !== "/") throw new IncompleteObservationError("unexpected NFS export");
				await this.journal.observe(".", "metadata");
				after = (response) => {
					if (response.u32() === 0) this.register(response.opaque(64), ["."]);
				};
			} else if (![0, 2, 3, 4, 5].includes(procedure)) {
				throw new IncompleteObservationError("unknown mount procedure");
			}
		} else if (program === 100003 && version === 3) {
			after = await this.nfs(procedure, request);
		} else {
			throw new IncompleteObservationError(`unsupported RPC program ${program}/${version}`);
		}
		return async (reply) => {
			try {
				const response = new XdrReader(reply);
				if (response.u32() !== xid || response.u32() !== 1 || response.u32() !== 0) {
					throw new IncompleteObservationError("unmatched or rejected RPC response");
				}
				response.u32(); // verifier flavor
				response.opaque(400);
				if (response.u32() !== 0) throw new IncompleteObservationError("RPC request was not executed");
				return (await after(response, reply)) ?? undefined;
			} catch (error) {
				this.journal.invalidate(error instanceof Error ? error.message : String(error));
				throw error;
			}
		};
	}

	private paths(handle: Buffer): string[] {
		const paths = this.handles.get(handle.toString("hex"));
		if (!paths?.size) throw new IncompleteObservationError("unknown NFS file handle");
		return [...paths];
	}

	private register(handle: Buffer, files: string[]): void {
		if (!handle.length) throw new IncompleteObservationError("empty NFS file handle");
		const key = handle.toString("hex");
		const current = this.handles.get(key) ?? new Set<string>();
		for (const file of files) current.add(file);
		this.handles.set(key, current);
	}

	private child(request: XdrReader): string[] {
		const parents = this.paths(request.opaque(64));
		const bytes = request.opaque(255);
		const name = bytes.toString("utf8");
		if (!name || !Buffer.from(name).equals(bytes) || name.includes("/") || name.includes("\0")) {
			throw new IncompleteObservationError("unsupported NFS path component");
		}
		return parents.map((parent) => {
			if (name === ".") return parent;
			if (name === "..") return path.posix.dirname(parent);
			return path.posix.join(parent, name);
		});
	}

	private async observe(files: string[], kind: Observation = "contents"): Promise<void> {
		for (const file of files) await this.journal.observe(file, kind);
	}

	private known(file: string): boolean {
		for (const paths of this.handles.values()) if (paths.has(file)) return true;
		return false;
	}

	/** A "._name" file created during the run beside a file the program had already touched. */
	private async recordAppleDouble(files: string[]): Promise<void> {
		for (const file of files) {
			const name = path.posix.basename(file);
			if (!name.startsWith(APPLE_DOUBLE) || name.length === APPLE_DOUBLE.length) continue;
			const sibling = path.posix.join(path.posix.dirname(file), name.slice(APPLE_DOUBLE.length));
			if (this.known(sibling) && (await this.journal.originalKind(file)) === "absent") this.appleDouble.add(file);
		}
	}

	private async nfs(procedure: number, request: XdrReader): Promise<AfterReply> {
		if (procedure === 0) return nothing;
		if ([1, 2, 4, 5, 6, 7, 18, 19, 20, 21].includes(procedure)) {
			const files = this.paths(request.opaque(64));
			await this.observe(files, [2, 5, 6, 7].includes(procedure) ? "contents" : "metadata");
			return nothing;
		}
		if ([3, 8, 9, 10, 11, 12, 13].includes(procedure)) {
			const files = this.child(request);
			if (procedure === 13) {
				for (const file of files) await this.journal.observeTree(file);
			} else await this.observe(files, procedure === 3 ? "metadata" : "contents");
			if ([12, 13].includes(procedure)) return nothing;
			return async (response) => {
				if (response.u32() !== 0) return;
				if (procedure === 3 || response.bool()) this.register(response.opaque(64), files);
				if (procedure === 8) await this.recordAppleDouble(files);
			};
		}
		if (procedure === 14) {
			const from = this.child(request);
			const to = this.child(request);
			if (from.length !== 1 || to.length !== 1) throw new IncompleteObservationError("ambiguous directory rename");
			await this.journal.observeRename(from[0], to[0]);
			// AgentFS renames a directory from before the run without its contents: applying that would delete them.
			if ((await this.journal.originalKind(from[0])) === "directory")
				this.journal.refuse(
					`renaming the directory ${JSON.stringify(from[0])} isn't supported on macOS, since its files would be lost; move them one at a time instead`,
				);
			return (response) => {
				if (response.u32() !== 0) return;
				const moved = (old: string) => old === from[0] || old.startsWith(`${from[0]}/`);
				for (const old of [...this.appleDouble].filter(moved)) {
					this.appleDouble.delete(old);
					this.appleDouble.add(to[0] + old.slice(from[0].length));
				}
				for (const aliases of this.handles.values()) {
					// Snapshot before mutating: newly inserted aliases must not be visited again.
					const previousAliases = [...aliases];
					for (const old of previousAliases) {
						if (old === from[0] || old.startsWith(`${from[0]}/`)) {
							aliases.delete(old);
							aliases.add(to[0] + old.slice(from[0].length));
						}
					}
				}
			};
		}
		if (procedure === 15) {
			const handle = request.opaque(64);
			const from = this.paths(handle);
			const to = this.child(request);
			await this.observe([...from, ...to]);
			return (response) => {
				if (response.u32() === 0) this.register(handle, to);
			};
		}
		if (procedure === 16 || procedure === 17) {
			const directories = this.paths(request.opaque(64));
			for (const directory of directories) await this.journal.observeDirectory(directory, procedure === 17);
			return (response, reply) => {
				if (response.u32() !== 0) return;
				response.postAttributes();
				response.take(8); // cookie verifier
				// Keep the reply up to the first entry, then every entry that is not hidden.
				const kept: Buffer[] = [reply.subarray(0, response.position)];
				let hidden = false;
				let last: Buffer | undefined;
				for (let start = response.position; response.bool(); start = response.position) {
					response.take(8); // fileid
					const bytes = response.opaque(255);
					const name = bytes.toString("utf8");
					if (!name || !Buffer.from(name).equals(bytes) || name.includes("/") || name.includes("\0")) {
						throw new IncompleteObservationError("invalid directory response component");
					}
					response.take(8); // cookie
					if (procedure === 17) {
						response.postAttributes();
						if (response.bool()) {
							const files = directories.map((dir) =>
								name === "." ? dir : name === ".." ? path.posix.dirname(dir) : path.posix.join(dir, name),
							);
							this.register(response.opaque(64), files);
						}
					}
					const entry = reply.subarray(start, response.position);
					const listed = directories.map((dir) => path.posix.join(dir, name));
					if (listed.some((file) => this.appleDouble.has(file))) {
						hidden = true;
						last = entry;
					} else {
						kept.push(entry);
						last = undefined;
					}
				}
				const end = response.position - 4; // the "no more entries" marker
				const eof = response.bool();
				// The client continues a listing from the cookie of the last entry it received, so a page that is
				// not the last one keeps its final entry even when that entry would be hidden.
				if (last && !eof) kept.push(last);
				return hidden ? Buffer.concat([...kept, reply.subarray(end)]) : undefined;
			};
		}
		throw new IncompleteObservationError(`unknown NFS procedure ${procedure}`);
	}
}
