import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { NfsObserver, XdrReader } from "../src/macos/nfs-observer.ts";
import { TransactionJournal } from "../src/transaction/transaction-journal.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function words(...values: number[]): Buffer {
	const buffer = Buffer.alloc(values.length * 4);
	values.forEach((value, i) => buffer.writeUInt32BE(value, i * 4));
	return buffer;
}
function opaque(value: Buffer | string): Buffer {
	const bytes = Buffer.from(value);
	return Buffer.concat([words(bytes.length), bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
}
function call(procedure: number, args: Buffer = Buffer.alloc(0), program = 100003): Buffer {
	return Buffer.concat([words(1, 0, 2, program, 3, procedure, 0, 0, 0, 0), args]);
}
function reply(body: Buffer = Buffer.alloc(0)): Buffer {
	return Buffer.concat([words(1, 1, 0, 0, 0, 0), body]);
}
const rootHandle = Buffer.from("root");
const inputHandle = Buffer.from("input");
const child = (name: string) => Buffer.concat([opaque(rootHandle), opaque(name)]);

async function fixture(files: Record<string, string> = {}) {
	const root = await fs.mkdtemp(path.join(tmpdir(), "shorthand-nfs-observer-"));
	roots.push(root);
	await Bun.write(path.join(root, "input"), "original\n");
	for (const [file, text] of Object.entries(files)) await Bun.write(path.join(root, file), text);
	const journal = new TransactionJournal(root);
	const observer = new NfsObserver(journal);
	const mounted = await observer.before(call(1, opaque("/"), 100005));
	await mounted(reply(Buffer.concat([words(0), opaque(rootHandle), words(0)])));
	return { root, journal, observer };
}

async function lookup(observer: NfsObserver, name: string, handle: Buffer) {
	const after = await observer.before(call(3, child(name)));
	await after(reply(Buffer.concat([words(0), opaque(handle), words(0, 0)])));
}

test("NFS captures content before forwarding a read and detects later input changes", async () => {
	const { root, journal, observer } = await fixture();
	await lookup(observer, "input", inputHandle);
	await observer.before(call(6, Buffer.concat([opaque(inputHandle), words(0, 0, 4096)])));
	const original = await journal.original("input");
	expect(original?.type === "file" && Buffer.from(original.contents).toString()).toBe("original\n");
	await Bun.write(path.join(root, "input"), "changed\n");
	await journal.seal();
	expect(await journal.conflicts()).toContain("input");
});

test("write-only truncation retains its original without a read request", async () => {
	const { journal, observer } = await fixture();
	await lookup(observer, "input", inputHandle);
	await observer.before(call(2, opaque(inputHandle)));
	expect((await journal.original("input"))?.type).toBe("file");
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
});

test("negative lookup is observed even when the server returns NOENT", async () => {
	const { root, journal, observer } = await fixture();
	const after = await observer.before(call(3, child("missing")));
	await after(reply(words(2, 0)));
	await Bun.write(path.join(root, "missing"), "new");
	await journal.seal();
	expect(await journal.conflicts()).toContain("missing");
});

test("create maps a new handle while its baseline remains absent", async () => {
	const { journal, observer } = await fixture();
	const created = await observer.before(call(8, child("new")));
	const handle = Buffer.from("new-handle");
	await created(reply(Buffer.concat([words(0, 1), opaque(handle), words(0, 0, 0)])));
	await observer.before(call(7, opaque(handle)));
	expect(await journal.original("new")).toBeNull();
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
});

test("rename captures both originals and relocates known handles", async () => {
	const { journal, observer } = await fixture();
	await lookup(observer, "input", inputHandle);
	const renamed = await observer.before(call(14, Buffer.concat([child("input"), child("renamed")])));
	await renamed(reply(words(0)));
	await observer.before(call(6, opaque(inputHandle)));
	expect((await journal.original("input"))?.type).toBe("file");
	expect(await journal.original("renamed")).toBeNull();
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
});

test("READDIRPLUS captures cached child attributes and learns returned handles", async () => {
	const { root, journal, observer } = await fixture();
	const listed = await observer.before(call(17, opaque(rootHandle)));
	await listed(
		reply(
			Buffer.concat([
				words(0, 0, 0, 0, 1, 0, 10),
				opaque("input"),
				words(0, 1, 0, 1),
				opaque(inputHandle),
				words(0, 1),
			]),
		),
	);
	await observer.before(call(1, opaque(inputHandle)));
	await Bun.write(path.join(root, "input"), "metadata changed length");
	await journal.seal();
	expect(await journal.conflicts()).toContain("input");
});

test("repeated NFS reads and writes retain file contents only once", async () => {
	const { journal, observer } = await fixture();
	await lookup(observer, "input", inputHandle);
	for (let i = 0; i < 20; i++) await observer.before(call(i % 2 ? 6 : 7, opaque(inputHandle)));
	expect(journal.contentCaptureCount).toBe(1);
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
});

test("directory rename records originals for every destination descendant", async () => {
	for (const existing of [false, true]) {
		const { root } = await fixture();
		await fs.mkdir(path.join(root, "source", "nested"), { recursive: true });
		await Bun.write(path.join(root, "source", "nested", "child"), "before");
		if (existing) await fs.mkdir(path.join(root, "destination"));
		// The fixture mount observed root metadata before these additions. Start a fresh
		// observer/journal to model the completed source tree at transaction start.
		const fresh = new TransactionJournal(root);
		const observed = new NfsObserver(fresh);
		const mounted = await observed.before(call(1, opaque("/"), 100005));
		await mounted(reply(Buffer.concat([words(0), opaque(rootHandle), words(0)])));
		const renamed = await observed.before(call(14, Buffer.concat([child("source"), child("destination")])));
		await renamed(reply(words(0)));
		expect(await fresh.original("destination/nested/child")).toBeNull();
		expect((await fresh.original("source/nested/child"))?.type).toBe("file");
		await fresh.seal();
		// AgentFS would lose the directory's files, so a rename of one from before the run is refused.
		await expect(fresh.conflicts()).rejects.toThrow('Not applied: renaming the directory "source"');
	}
});

test("unknown handles, procedures and malformed records permanently reject", async () => {
	for (const request of [call(6, opaque("unknown")), call(99), Buffer.from([0, 1])]) {
		const { journal, observer } = await fixture();
		await expect(observer.before(request)).rejects.toThrow();
		await expect(journal.seal()).rejects.toThrow();
	}
});

test("mismatched RPC replies permanently reject", async () => {
	const { journal, observer } = await fixture();
	const after = await observer.before(call(0));
	const wrong = reply();
	wrong.writeUInt32BE(2);
	await expect(after(wrong)).rejects.toThrow("unmatched");
	await expect(journal.seal()).rejects.toThrow();
});

test("macOS v1 mount teardown is accepted without accepting v1 file handles", async () => {
	const { observer, journal } = await fixture();
	const unmount = call(3, opaque("/"), 100005);
	unmount.writeUInt32BE(1, 16);
	const after = await observer.before(unmount);
	await after(reply());
	await journal.seal();
	expect(await journal.conflicts()).toEqual([]);
	const other = await fixture();
	const mount = call(1, opaque("/"), 100005);
	mount.writeUInt32BE(1, 16);
	await expect(other.observer.before(mount)).rejects.toThrow("unsupported RPC");
});

test("XDR rejects truncated padding, oversized values and invalid booleans", () => {
	expect(() => new XdrReader(Buffer.concat([words(1), Buffer.from("x")])).opaque()).toThrow("truncated");
	expect(() => new XdrReader(words(1024)).opaque(64)).toThrow("oversized");
	expect(() => new XdrReader(words(2)).bool()).toThrow("boolean");
});

/** A READDIRPLUS reply body listing names, each with a handle, followed by EOF. */
function listing(names: string[], eof = true): Buffer {
	return Buffer.concat([
		words(0, 0, 0, 0),
		...names.flatMap((name, i) => [words(1, 0, i + 10), opaque(name), words(0, i + 1, 0, 1), opaque(`h-${name}`)]),
		words(0, eof ? 1 : 0),
	]);
}

/** Names in a READDIRPLUS reply, checking that the entry list and EOF marker are intact. */
function listedNames(message: Buffer): string[] {
	const reader = new XdrReader(message);
	reader.take(24); // RPC reply header with an empty verifier
	expect(reader.u32()).toBe(0);
	reader.postAttributes();
	reader.take(8);
	const names: string[] = [];
	while (reader.bool()) {
		reader.take(8);
		names.push(reader.opaque(255).toString());
		reader.take(8);
		reader.postAttributes();
		if (reader.bool()) reader.opaque(64);
	}
	reader.bool();
	expect(reader.position).toBe(message.length);
	return names;
}

async function create(observer: NfsObserver, name: string) {
	const created = await observer.before(call(8, child(name)));
	await created(reply(Buffer.concat([words(0, 1), opaque(`h-${name}`), words(0, 0, 0)])));
}

test("directory listings leave out AppleDouble files created beside files the run touched", async () => {
	const { observer } = await fixture({ "._kept": "a real file in the repository", kept: "kept\n" });
	await lookup(observer, "input", inputHandle);
	await lookup(observer, "kept", Buffer.from("kept-handle"));
	await create(observer, "._input");
	await create(observer, "._kept");
	await create(observer, "._notes");

	for (const procedure of [16, 17]) {
		const listed = await observer.before(call(procedure, opaque(rootHandle)));
		const names = ["input", "._input", "kept", "._kept", "._notes"];
		const body =
			procedure === 17
				? listing(names)
				: Buffer.concat([
						words(0, 0, 0, 0),
						...names.flatMap((name, i) => [words(1, 0, i + 10), opaque(name), words(0, i + 1)]),
						words(0, 1),
					]);
		const rewritten = await listed(reply(body));
		expect(rewritten).toBeInstanceOf(Buffer);
		if (procedure === 17) expect(listedNames(rewritten as Buffer)).toEqual(["input", "kept", "._kept", "._notes"]);
		else expect((rewritten as Buffer).toString()).not.toContain("._input");
	}
});

test("a listing without hidden files is forwarded unchanged", async () => {
	const { observer } = await fixture();
	const listed = await observer.before(call(17, opaque(rootHandle)));
	expect(await listed(reply(listing(["input"])))).toBeUndefined();
});

test("a page that is not the last keeps its final entry so the client can continue", async () => {
	const { observer } = await fixture({ kept: "kept\n" });
	await lookup(observer, "input", inputHandle);
	await lookup(observer, "kept", Buffer.from("kept-handle"));
	await create(observer, "._input");
	await create(observer, "._kept");

	const page = await observer.before(call(17, opaque(rootHandle)));
	const rewritten = await page(reply(listing(["._input", "input", "._kept"], false)));
	expect(listedNames(rewritten as Buffer)).toEqual(["input", "._kept"]);
	const last = await observer.before(call(17, opaque(rootHandle)));
	expect(listedNames((await last(reply(listing(["kept", "._kept"])))) as Buffer)).toEqual(["kept"]);
});

test("hidden AppleDouble files stay hidden after their directory is renamed", async () => {
	const { observer } = await fixture({ "dir/file": "file\n" });
	const dirHandle = Buffer.from("dir-handle");
	await lookup(observer, "dir", dirHandle);
	const inDir = (name: string) => Buffer.concat([opaque(dirHandle), opaque(name)]);
	const found = await observer.before(call(3, inDir("file")));
	await found(reply(Buffer.concat([words(0), opaque("file-handle"), words(0, 0)])));
	const created = await observer.before(call(8, inDir("._file")));
	await created(reply(Buffer.concat([words(0, 1), opaque("sidecar-handle"), words(0, 0, 0)])));

	const renamed = await observer.before(call(14, Buffer.concat([child("dir"), child("moved")])));
	await renamed(reply(words(0)));
	const listed = await observer.before(call(17, opaque(dirHandle)));
	expect(listedNames((await listed(reply(listing(["file", "._file"])))) as Buffer)).toEqual(["file"]);
});
