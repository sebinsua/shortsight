// Parse syntax ranges for graph symbols without loading the target project.
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { API } from "typescript/unstable/async";
import type { Node, SourceFile } from "typescript/unstable/ast";
import type { FileSystem } from "typescript/unstable/fs";
import { toHandle } from "./model.ts";
import { graphKind, indexDeclarations, type DeclarationKind, type Unindexed } from "./naming.ts";

export interface Declaration {
	/** Qualified by everything it's declared in, as `NS.helper`. */
	name: string;
	kind: DeclarationKind;
	start: number;
	end: number;
	codeStart: number;
	/** A top-level declaration the module exports, by an `export` modifier or its own export list. */
	exported?: true;
	/** Declared inside a function. */
	local?: true;
	/** The graph's name for it where that differs, as `helper` for a namespace member it doesn't export. */
	graphName?: string;
	/** Why the graph has no node of its own for it, when it has none. */
	unindexed?: Unindexed;
}

/** The graph's name for a declaration's node, if it has one. */
export function graphNameOf(declaration: Declaration): string | undefined {
	return declaration.unindexed ? undefined : (declaration.graphName ?? declaration.name);
}

/** The graph's handle for a declaration, or for one it has no node for, the same form with its full name. */
export function handleFor(file: string, declaration: Declaration): string {
	return toHandle(file, graphNameOf(declaration) ?? declaration.name, graphKind(declaration.kind));
}

/** The declarations a diff reports on its own: graph nodes, other than locals, which belong to their function. */
export function indexedDeclarations(items: Declaration[]): Declaration[] {
	return items.filter((item) => !item.local && !item.unindexed);
}

export interface SymbolRef {
	file: string;
	name: string;
	kind: string;
	line?: number;
}

export interface RangeIndex {
	declarations(file: string): Promise<Declaration[] | undefined>;
	rangesFor(ref: SymbolRef): Promise<Array<{ start: number; end: number }> | undefined>;
	exportedFor(ref: SymbolRef): Promise<boolean>;
	close(): Promise<void>;
}

export interface DeclarationParser {
	parse(fileName: string, text: string): Promise<Declaration[]>;
	close(): Promise<void>;
}

let nextVirtualRoot = 0;

/** One TypeScript API process reused across parses. Close it when done. */
export function createDeclarationParser(): DeclarationParser {
	const root = `/__sightread_ranges_${process.pid}_${++nextVirtualRoot}`;
	const config = `${root}/tsconfig.json`;
	const files = new Map<string, string>([[config, '{"compilerOptions":{"allowJs":true},"include":["*"]}']]);
	const fs: FileSystem = {
		readFile: (file) => files.get(file) ?? (file.startsWith(`${root}/`) ? null : undefined),
		fileExists: (file) => files.has(file),
		directoryExists: (directory) => directory === root || directory === "/",
		getAccessibleEntries: (directory) =>
			directory === root
				? { files: [...files.keys()].map((file) => file.slice(root.length + 1)), directories: [] }
				: undefined,
		realpath: (file) => file,
	};
	let api = new API({ cwd: root, fs });
	let configured = false;
	let exited = false;
	let watched: ChildProcess | undefined;
	let sequence: Promise<unknown> = Promise.resolve();
	let closed = false;
	let parsed = 0;
	let previous: string | undefined;

	const parse = (fileName: string, text: string): Promise<Declaration[]> => {
		const task = sequence.then(async () => {
			if (closed) throw new Error("Range index is closed");
			if (exited) {
				await api.close();
				api = new API({ cwd: root, fs });
				configured = false;
				watched = undefined;
				exited = false;
				throw new Error("TypeScript parser process exited");
			}
			// Each parse gets a new virtual file. TypeScript can keep serving an open file's first contents
			// after a change, so reusing one file per extension returned earlier files' declarations.
			const file = `${root}/source${++parsed}${extname(fileName) || ".ts"}`;
			const replaced = previous;
			if (replaced) files.delete(replaced);
			files.set(file, text);
			const snapshot = await api.updateSnapshot({
				...(configured ? {} : { openProjects: [config] }),
				openFiles: [file],
				...(replaced ? { closeFiles: [replaced] } : {}),
				fileChanges: { created: [file], ...(replaced ? { deleted: [replaced] } : {}) },
			});
			previous = file;
			const child = (api as unknown as { client: { process?: ChildProcess } }).client.process;
			if (child && child !== watched) {
				watched = child;
				child.once("exit", () => {
					exited = true;
				});
			}
			api.clearSourceFileCache();
			configured = true;
			try {
				const project = await snapshot.getDefaultProjectForFile(file);
				const sourceFile = await project?.program.getSourceFile(file);
				return sourceFile ? collectDeclarations(sourceFile) : [];
			} finally {
				await snapshot.dispose();
			}
		});
		sequence = task.catch(() => undefined);
		return task;
	};

	return {
		parse,
		async close() {
			closed = true;
			await sequence;
			await api.close();
		},
	};
}

// A declaration's own doc comments belong to it; a file's leading `@module` comment does not.
const fileDoc = /@(?:module|packageDocumentation|file|fileoverview)\b/;
function documentedStart(sourceFile: SourceFile, node: Node): number {
	const code = node.getStart(sourceFile);
	const documented = node.getStart(sourceFile, true);
	let start = documented;
	for (const block of sourceFile.text.slice(documented, code).matchAll(/\/\*\*[\s\S]*?\*\//g)) {
		if (!fileDoc.test(block[0])) break;
		const after = documented + block.index + block[0].length;
		const next = sourceFile.text.slice(after, code).search(/\S/);
		start = next === -1 ? code : after + next;
	}
	return start;
}

function collectDeclarations(sourceFile: SourceFile): Declaration[] {
	const line = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
	return indexDeclarations(sourceFile).declarations.map(
		({ name, kind, graphName, unindexed, local, exported, extent }) => ({
			name,
			kind,
			start: line(documentedStart(sourceFile, extent)),
			end: line(Math.max(extent.getStart(sourceFile), extent.end - 1)),
			codeStart: line(extent.getStart(sourceFile)),
			...(exported ? { exported: true as const } : {}),
			...(local ? { local: true as const } : {}),
			...(graphName === undefined || graphName === name ? {} : { graphName }),
			...(unindexed ? { unindexed } : {}),
		}),
	);
}

/** Parse source held in memory, using its extension to select TypeScript's script kind. */
export async function parseDeclarations(fileName: string, text: string): Promise<Declaration[]> {
	const parser = createDeclarationParser();
	try {
		return await parser.parse(fileName, text);
	} finally {
		await parser.close();
	}
}

/** Cache project files by disk metadata and reuse one TypeScript API process. */
/** Paths resolve from `root`; files must lie within `within` (default `root`), such as the repository. */
export function createRangeIndex(root: string, options: { maxFiles?: number; within?: string } = {}): RangeIndex {
	const absoluteRoot = resolve(root);
	// Express `within` in the same spelling as `root`, which may run through a symlink (`/var` on macOS).
	const absoluteWithin = options.within
		? resolve(absoluteRoot, relative(realpathSync(absoluteRoot), realpathSync(options.within)))
		: absoluteRoot;
	const cache = new Map<string, { mtimeMs: number; size: number; declarations: Declaration[] }>();
	const inFlight = new Map<string, Promise<Declaration[] | undefined>>();
	const maxFiles = Math.max(0, options.maxFiles ?? 64);
	let parser: DeclarationParser | undefined;
	let closed = false;
	const insideRoot = (file: string) => {
		const path = relative(absoluteWithin, file);
		return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
	};
	const readDeclarations = async (absolute: string, file: string): Promise<Declaration[] | undefined> => {
		try {
			const actualRoot = await realpath(absoluteWithin);
			const actualFile = await realpath(absolute);
			const path = relative(actualRoot, actualFile);
			if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
			const metadata = await stat(absolute);
			if (!metadata.isFile()) return undefined;
			const cached = cache.get(absolute);
			if (cached?.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) return cached.declarations;
			const text = await readFile(absolute, "utf8");
			parser ??= createDeclarationParser();
			const parsed = await parser.parse(file, text);
			cache.delete(absolute);
			if (maxFiles > 0) {
				cache.set(absolute, { mtimeMs: metadata.mtimeMs, size: metadata.size, declarations: parsed });
				if (cache.size > maxFiles) cache.delete(cache.keys().next().value!);
			}
			return parsed;
		} catch (error) {
			if (["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
				return undefined;
			console.error(`sightread parser: ${error instanceof Error ? error.message : String(error)}`);
			const failed = parser;
			parser = undefined;
			await failed?.close().catch(() => undefined);
			return undefined;
		}
	};
	const declarations = async (file: string): Promise<Declaration[] | undefined> => {
		// `..` is allowed: a sibling package's file resolves outside the project, and is checked to be within bounds.
		if (closed || isAbsolute(file) || file.includes("\\")) return undefined;
		const absolute = resolve(absoluteRoot, file);
		if (!insideRoot(absolute)) return undefined;
		const pending = inFlight.get(absolute);
		if (pending) return pending;
		const task = readDeclarations(absolute, file);
		inFlight.set(absolute, task);
		try {
			return await task;
		} finally {
			inFlight.delete(absolute);
		}
	};
	return {
		declarations,
		async rangesFor(ref) {
			const matches = await matching(ref);
			if (!matches.length) return undefined;
			const mergeable = ["function", "interface", "method", "enum"].includes(ref.kind);
			const onLine = ref.line === undefined ? [] : matches.filter((declaration) => declaration.codeStart === ref.line);
			return (mergeable || !onLine.length ? matches : onLine).map(({ start, end }) => ({ start, end }));
		},
		async exportedFor(ref) {
			return (await matching(ref)).some((declaration) => declaration.exported);
		},
		async close() {
			closed = true;
			await Promise.all(inFlight.values());
			await parser?.close();
			cache.clear();
		},
	};

	async function matching(ref: SymbolRef): Promise<Declaration[]> {
		const parsed = await declarations(ref.file);
		if (!parsed) return [];
		return parsed.filter(
			(declaration) =>
				(declaration.name === ref.name || graphNameOf(declaration) === ref.name) &&
				graphKind(declaration.kind) === graphKind(ref.kind as DeclarationKind),
		);
	}
}
