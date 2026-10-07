/** On-demand source baselines shared by the platform observers. Never scans the whole tree. */
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FilesystemEntry } from "../runner/runner.ts";

export type Observation = "metadata" | "contents" | "directory";

interface Baseline {
	identity: string | null;
	kind: "absent" | "file" | "directory" | "symlink";
	entry?: FilesystemEntry;
	names?: string[];
	digest?: string;
}

/** How a refusal's message starts, so it survives crossing to and from the observation worker as text. */
export const REFUSED = "Not applied: ";

/** A run whose changes can't be applied correctly; reported as its message alone. */
export class RefusedRunError extends Error {}

export class IncompleteObservationError extends Error {
	constructor(message: string) {
		super(`Incomplete transaction observation: ${message}`);
		this.name = "IncompleteObservationError";
	}
}

/** Adapters must resolve aliases and observe their symlink components before calling this class. */
export class TransactionJournal {
	private readonly records = new Map<string, Baseline>();
	private readonly ancestors = new Map<string, string | null>();
	private failure: Error | undefined;
	private sealed = false;
	private queue: Promise<unknown> = Promise.resolve();
	private captures = 0;

	constructor(private readonly root: string) {
		if (!path.isAbsolute(root)) throw new Error("Transaction root must be absolute.");
	}

	get entryCount(): number {
		return this.records.size;
	}

	get contentCaptureCount(): number {
		return this.captures;
	}

	/** Capture both sides of every moved descendant, including absent destination descendants. */
	async observeRename(from: string, to: string): Promise<void> {
		await this.observeTree(to);
		await this.observeTree(from);
		const source = relativePath(from);
		// A private directory can contain newly created children absent from its
		// host before-image. Their earlier write observations still establish the
		// destination baselines needed when the whole staged tree is renamed.
		const observedBeforeRename = [...this.records.keys()];
		for (const file of observedBeforeRename) {
			if (file.startsWith(`${source}${path.sep}`)) {
				await this.observe(path.join(to, path.relative(source, file)), "contents");
			}
		}
	}

	/** Only for an explicitly affected subtree, e.g. a directory rename—not workspace setup. */
	async observeTree(file: string): Promise<void> {
		await this.observe(file, "contents");
		const relative = relativePath(file);
		if (this.records.get(relative)?.kind !== "directory") return;
		await this.observe(relative, "directory");
		for (const name of this.records.get(relative)!.names!) {
			await this.observeTree(path.join(relative, name));
		}
	}

	/** READDIRPLUS exposes child attributes without requiring a later getattr request. */
	async observeDirectory(file: string, childMetadata = false): Promise<void> {
		await this.observe(file, "directory");
		if (!childMetadata) return;
		const relative = relativePath(file);
		for (const name of this.records.get(relative)?.names ?? []) {
			await this.observe(path.join(relative, name), "metadata");
		}
	}

	/** Observation errors permanently invalidate the journal, even if callers catch them. */
	invalidate(reason: string): void {
		this.failure ??= new IncompleteObservationError(reason);
	}

	/**
	 * Something the program did can't be applied correctly. Observation carries on, so the program and its cleanup
	 * aren't disturbed, but validation refuses the transaction, so nothing is applied.
	 */
	refuse(reason: string): void {
		this.refusal ??= reason;
	}

	private refusal: string | undefined;

	observe(file: string, observation: Observation = "contents"): Promise<void> {
		const operation = this.queue.then(async () => {
			this.assertUsable();
			if (this.sealed) throw new IncompleteObservationError("access after the journal was sealed");
			const relative = relativePath(file);
			const parents = await this.parentIdentities(relative);
			const previous = this.records.get(relative);
			// A retained before-image is immutable. Recheck identity on repeated RPCs,
			// but do not reread a whole file for every chunk of an NFS read/write.
			const retained =
				previous &&
				(observation === "metadata" ||
					(observation === "contents" && (previous.digest !== undefined || previous.kind !== "file")) ||
					(observation === "directory" && previous.names !== undefined));
			const next = await readBaseline(path.join(this.root, relative), retained ? "metadata" : observation);
			if (!retained && next.kind === "file" && next.digest !== undefined) this.captures++;
			await this.checkParents(parents);
			if (previous && previous.identity !== next.identity) {
				throw new IncompleteObservationError(`source changed between observations of ${JSON.stringify(relative)}`);
			}
			if (previous?.digest && next.digest && previous.digest !== next.digest) {
				throw new IncompleteObservationError(`source content changed at ${JSON.stringify(relative)}`);
			}
			if (previous?.names && next.names && !sameNames(previous.names, next.names)) {
				throw new IncompleteObservationError(`source listing changed at ${JSON.stringify(relative)}`);
			}
			this.records.set(relative, {
				...previous,
				...next,
				entry: next.entry ?? previous?.entry,
				names: next.names ?? previous?.names,
				digest: next.digest ?? previous?.digest,
			});
		});
		this.queue = operation.catch((error: unknown) => {
			this.failure ??= error instanceof Error ? error : new Error(String(error));
		});
		return operation;
	}

	/** Call only after all programs, formatters, and dependency-producing discovery have stopped. */
	async seal(): Promise<void> {
		await this.queue;
		this.assertUsable();
		this.sealed = true;
	}

	/** Returns only an already-captured original; never invents a baseline after execution. */
	async originalKind(file: string): Promise<Baseline["kind"]> {
		await this.queue;
		this.assertUsable();
		const relative = relativePath(file);
		const baseline = this.records.get(relative);
		if (!baseline && this.ancestors.has(relative))
			return this.ancestors.get(relative) === null ? "absent" : "directory";
		if (!baseline) {
			this.invalidate(`no baseline recorded for ${JSON.stringify(file)}`);
			this.assertUsable();
		}
		return baseline!.kind;
	}

	async observedFiles(): Promise<string[]> {
		await this.queue;
		this.assertUsable();
		return [...this.records]
			.filter(([, entry]) => entry.kind === "file" || entry.kind === "symlink")
			.map(([file]) => file);
	}

	async originalFiles(file: string): Promise<string[]> {
		const kind = await this.originalKind(file);
		if (kind !== "directory") return [file];
		const names = this.records.get(relativePath(file))!.names;
		if (!names) {
			this.invalidate(`no original directory listing for ${JSON.stringify(file)}`);
			this.assertUsable();
		}
		const result: string[] = [];
		for (const name of names!) result.push(...(await this.originalFiles(path.join(file, name))));
		return result;
	}

	async original(file: string): Promise<FilesystemEntry | null> {
		await this.queue;
		this.assertUsable();
		const relative = relativePath(file);
		const baseline = this.records.get(relative);
		if (!baseline || (baseline.kind !== "absent" && !baseline.entry)) {
			this.invalidate(`no original entry recorded for ${JSON.stringify(relative)}`);
			this.assertUsable();
		}
		if (baseline!.kind === "absent") return null;
		const entry = baseline!.entry!;
		return entry.type === "file" ? { ...entry, contents: Uint8Array.from(entry.contents) } : { ...entry };
	}

	/** Validation is optimistic conflict detection, not an atomic multi-file read snapshot. */
	async conflicts(): Promise<string[]> {
		await this.queue;
		this.assertUsable();
		if (this.refusal) throw new RefusedRunError(REFUSED + this.refusal);
		if (!this.sealed) throw new IncompleteObservationError("validation before sealing");
		const conflicts = new Set<string>();
		for (const [file, expected] of this.ancestors) {
			const actual = await ancestorIdentity(path.join(this.root, file)).catch(() => undefined);
			if (actual !== expected) conflicts.add(file);
		}
		for (const [file, baseline] of this.records) {
			if ([...conflicts].some((ancestor) => ancestor === "." || file.startsWith(`${ancestor}${path.sep}`))) {
				conflicts.add(file);
				continue;
			}
			try {
				const current = await readBaseline(
					path.join(this.root, file),
					baseline.names ? "directory" : baseline.digest ? "contents" : "metadata",
				);
				if (
					current.identity !== baseline.identity ||
					current.digest !== baseline.digest ||
					(baseline.names && !sameNames(baseline.names, current.names ?? []))
				)
					conflicts.add(file);
			} catch {
				conflicts.add(file);
			}
		}
		return [...conflicts].toSorted();
	}

	private assertUsable(): void {
		if (this.failure) throw this.failure;
	}

	private async parentIdentities(file: string): Promise<Map<string, string | null>> {
		const parents = new Map<string, string | null>();
		let parent = path.dirname(file);
		for (;;) {
			const parentIdentity = await ancestorIdentity(path.join(this.root, parent));
			if (this.ancestors.has(parent) && this.ancestors.get(parent) !== parentIdentity) {
				throw new IncompleteObservationError(`source parent changed at ${JSON.stringify(parent)}`);
			}
			parents.set(parent, parentIdentity);
			if (parent === ".") break;
			parent = path.dirname(parent);
		}
		return parents;
	}

	private async checkParents(parents: Map<string, string | null>): Promise<void> {
		for (const [file, parentIdentity] of parents) {
			if ((await ancestorIdentity(path.join(this.root, file))) !== parentIdentity) {
				throw new IncompleteObservationError(`source parent changed during capture at ${JSON.stringify(file)}`);
			}
			this.ancestors.set(file, parentIdentity);
		}
	}
}

function relativePath(file: string): string {
	if (!file || file.includes("\0") || path.isAbsolute(file) || file.split(path.sep).includes("..")) {
		throw new IncompleteObservationError(`invalid repository-relative path ${JSON.stringify(file)}`);
	}
	return path.normalize(file);
}

function identity(stats: BigIntStats): string {
	return `${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

async function statOrMissing(file: string): Promise<BigIntStats | undefined> {
	try {
		return await fs.lstat(file, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function ancestorIdentity(file: string): Promise<string | null> {
	const stats = await statOrMissing(file);
	if (!stats) return null;
	if (!stats.isDirectory())
		throw new IncompleteObservationError(`unresolved or non-directory parent ${JSON.stringify(file)}`);
	// Child creation is not a conflict unless the program observed this directory's listing/metadata.
	return `${stats.dev}:${stats.ino}:${stats.mode}`;
}

function sameNames(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((name, i) => name === b[i]);
}

async function readBaseline(file: string, observation: Observation): Promise<Baseline> {
	const before = await statOrMissing(file);
	if (!before) return { kind: "absent", identity: null };
	const initial = identity(before);
	let baseline: Baseline;
	if (before.isSymbolicLink()) {
		const target = await fs.readlink(file);
		baseline = {
			kind: "symlink",
			identity: initial,
			entry: { type: "symlink", target },
			digest: createHash("sha256").update(target).digest("hex"),
		};
	} else if (before.isDirectory()) {
		baseline = { kind: "directory", identity: initial };
		if (observation === "directory") baseline.names = (await fs.readdir(file)).toSorted();
	} else if (before.isFile()) {
		baseline = { kind: "file", identity: initial };
		if (observation === "contents") {
			const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				if (identity(await handle.stat({ bigint: true })) !== initial) throw new Error("file replaced before capture");
				const contents = await handle.readFile();
				if (identity(await handle.stat({ bigint: true })) !== initial) throw new Error("file changed during capture");
				baseline.entry = { type: "file", contents, mode: Number(before.mode & 0o7777n) };
				baseline.digest = createHash("sha256").update(contents).digest("hex");
			} finally {
				await handle.close();
			}
		}
	} else {
		throw new IncompleteObservationError(`unsupported source entry at ${JSON.stringify(file)}`);
	}
	const after = await statOrMissing(file);
	if (!after || identity(after) !== initial)
		throw new IncompleteObservationError(`unstable source at ${JSON.stringify(file)}`);
	return baseline;
}
