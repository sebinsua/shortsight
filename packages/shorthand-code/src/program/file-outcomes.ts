/** Per-file edit outcomes sent to the runner over a private inherited descriptor. */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type FileOutcomeEvent =
	| { type: "begin"; id: number; files: string[] }
	| { type: "end" | "fail"; id: number }
	| { type: "error"; files: string[] }
	| { type: "writers"; files: string[] | null };

const descriptor = process.env.PI_SHORTHAND_OUTCOMES_FD;
const root = process.env.PI_SHORTHAND_EXECUTION_ROOT;
export { root as executionRoot };
const forceInspectionFailure = process.env.PI_SHORTHAND_INSPECTION_FAILURE === "1";
// Subprocesses do not inherit descriptor 3 by default, so do not advertise it to them.
delete process.env.PI_SHORTHAND_OUTCOMES_FD;
delete process.env.PI_SHORTHAND_EXECUTION_ROOT;
delete process.env.PI_SHORTHAND_INSPECTION_FAILURE;
let nextId = 0;
const edited = new Set<string>();

export function wasEdited(file: string): boolean {
	return edited.has(resolve(file));
}

function content(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function send(event: FileOutcomeEvent): void {
	if (!descriptor) return;
	const bytes = Buffer.from(JSON.stringify(event) + "\n");
	let offset = 0;
	while (offset < bytes.length) offset += writeSync(Number(descriptor), bytes, offset);
}

function paths(files: readonly string[]): string[] {
	if (!root) return [];
	return [
		...new Set(
			files
				.filter((file) => typeof file === "string")
				.flatMap((file) => {
					const absolute = resolve(file);
					try {
						return [relative(root, absolute), relative(root, realpathSync(absolute))];
					} catch {
						return [relative(root, absolute)];
					}
				}),
		),
	].filter((file) => file !== ".." && !file.startsWith("../") && !isAbsolute(file));
}

/** An operation may touch several files (for example, moving a node between files). */
export function editingFiles<T>(files: readonly string[], edit: () => T): T {
	const originals = files.map((file) => [resolve(file), content(file)] as const);
	const id = nextId++;
	if (descriptor) send({ type: "begin", id, files: paths(files) });
	try {
		const result = edit();
		if (descriptor) send({ type: "end", id });
		return result;
	} catch (error) {
		if (descriptor) send({ type: "fail", id });
		throw error;
	} finally {
		for (const [file, before] of originals) if (content(file) !== before) edited.add(file);
	}
}

export function installFileOutcomeTracking(): void {
	if (!descriptor) return;
	process.on("uncaughtExceptionMonitor", (error) => {
		// Native filesystem errors identify their paths even when no editing helper was involved.
		const details = (typeof error === "object" && error !== null ? error : {}) as { path?: unknown; dest?: unknown };
		const files = [details.path, details.dest].filter((file): file is string => typeof file === "string");
		send({ type: "error", files: paths(files) });
	});
	process.on("exit", (code) => {
		if (code === 0) return;
		send({ type: "writers", files: inspectWriters() });
	});
}

/** Exit handlers run before descriptors close, so ordinary errors can be inspected too. */
function inspectWriters(): string[] | null {
	if (!root || forceInspectionFailure) return null;
	// bubblewrap replaces /dev, hiding the host's message-queue mount. Exempt that unrelated
	// mount from stat probes; otherwise lsof reports incomplete output for every Linux run. -w drops other
	// warnings, such as one about a file system lsof can't stat (a Time Machine network share).
	const args = ["-w", "-n", "-P", "-F", "an", ...(process.platform === "linux" ? ["-e", "/dev/mqueue"] : [])];
	const result = spawnSync("lsof", args, {
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error || result.status !== 0 || result.stderr) return null;
	return parseOpenWriters(result.stdout, root);
}

export function parseOpenWriters(output: string, directory: string): string[] {
	const files = new Set<string>();
	let access = "";
	for (const line of output.split("\n")) {
		if (line.startsWith("f")) access = "";
		if (line.startsWith("a")) access = line.slice(1);
		if (line.startsWith(`n${directory}/`) && (access === "w" || access === "u"))
			files.add(relative(directory, line.slice(1)));
	}
	return [...files];
}
