// Find every compiler-resolved use of a graph symbol in the project's real files.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { API, type Snapshot, SymbolFlags } from "typescript/unstable/async";
import {
	getTouchingPropertyName,
	isCallExpression,
	isConstructorDeclaration,
	isNewExpression,
	isPropertyAccessExpression,
	isSourceFile,
	SyntaxKind,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";
import { fromHandle, toHandle, type GraphNode, type GraphResult } from "./model.ts";
import type { PathMapper } from "./paths.ts";
import { projectFiles, type Project } from "./project.ts";
import {
	graphKind,
	indexDeclarations,
	inObjectLiteral,
	type DeclarationIndex,
	type DeclarationKind,
	type Declared,
} from "./naming.ts";

export interface ReferenceIndex {
	query(request: Record<string, unknown>, paths: PathMapper): Promise<GraphResult>;
	/**
	 * Where what `file` exports as `name` is declared, project-relative, when it re-exports it from elsewhere; or
	 * the module `name` is, for a namespace re-export such as `export * as Accordion from "./parts"`.
	 */
	reexport(file: string, name: string): Promise<{ file: string; name: string } | { namespace: string } | undefined>;
	close(): Promise<void>;
}

interface Container {
	handle: string;
	name: string;
	kind: string;
	start: number;
	end: number;
	exported?: true;
}

interface Found {
	file: string;
	line: number;
	col: number;
	endCol: number;
	endLine?: number;
	text: string;
	container?: Container;
	call?: { line: number; col: number; endLine: number; endCol: number; arguments: Range[] };
}

interface Range {
	line: number;
	col: number;
	endLine: number;
	endCol: number;
}

// The declaration whose own name `node` is, or whose `default` it is when the declaration has no name.
function declarationNamed(node: Node, index: DeclarationIndex): Declared | undefined {
	const parent = node.parent;
	if (!parent) return undefined;
	const name = (parent as { name?: Node }).name;
	return (name ? name === node : node.kind === SyntaxKind.DefaultKeyword) ? index.of(parent) : undefined;
}

// The declaration a handle names, by its full name or else the graph's, preferring one of its kind, since a type and
// a value can share a name. A name the graph gives several declarations names none of them.
function findDeclaration(index: DeclarationIndex, name: string, kind: string): Node | undefined {
	const of = (named: Declared[]) =>
		(named.find((declaration) => graphKind(declaration.kind) === graphKind(kind as DeclarationKind)) ?? named[0])?.node;
	return (
		of(index.declarations.filter((declaration) => declaration.name === name)) ??
		of(index.declarations.filter((declaration) => !declaration.unindexed && declaration.graphName === name))
	);
}

// The declarations the graph merges under one name, which a reference search has to be told apart.
const merged = (index: DeclarationIndex, name: string) =>
	index.declarations.filter((declaration) => declaration.unindexed === "shared" && declaration.graphName === name);

// The call or `new` a reference is the callee of, so a call split over lines can be shown whole.
function enclosingCall(reference: Node): Node | undefined {
	let callee = reference;
	if (callee.parent && isPropertyAccessExpression(callee.parent) && callee.parent.name === callee)
		callee = callee.parent;
	const call = callee.parent;
	return call && (isCallExpression(call) || isNewExpression(call)) && call.expression === callee ? call : undefined;
}

// The innermost declaration the graph has a node for that a reference sits in: a member, a function or a
// variable holding one, or a top-level declaration. Imports, re-exports and module-level statements have none.
function containerOf(
	reference: Node,
	source: SourceFile,
	index: DeclarationIndex,
	file: string,
): Container | undefined {
	for (let node = reference.parent; node && !isSourceFile(node); node = node.parent) {
		const declaration = index.of(node);
		if (!declaration || declaration.unindexed) continue;
		const line = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
		const { extent } = declaration;
		const graphName = declaration.graphName!;
		const kind = graphKind(declaration.kind);
		return {
			handle: toHandle(file, graphName, kind),
			name: graphName,
			kind,
			start: line(extent.getStart(source)),
			end: line(Math.max(extent.getStart(source), extent.end - 1)),
			...(declaration.exported ? { exported: true as const } : {}),
		};
	}
	return undefined;
}

/** Keep one TypeScript language service for a daemon's lifetime, brought up to date before each query. */
export function createReferenceIndex(project: Project): ReferenceIndex {
	const api = new API({ cwd: project.root });
	const stamps = new Map<string, string>();
	let snapshot: Snapshot | undefined;
	let sequence: Promise<unknown> = Promise.resolve();
	let closed = false;

	// Compare every project file's size and mtime with the last query's, and send TypeScript only what changed.
	const refresh = async (): Promise<Snapshot> => {
		if (closed) throw new Error("Reference index is closed");
		const files = await projectFiles(project, api);
		const current = new Map<string, string>();
		await Promise.all(
			[...files].map(async (file) => {
				const metadata = await stat(file).catch(() => undefined);
				if (metadata) current.set(file, `${metadata.mtimeMs}:${metadata.size}`);
			}),
		);
		const created = [...current.keys()].filter((file) => !stamps.has(file));
		const changed = [...current.keys()].filter((file) => stamps.has(file) && stamps.get(file) !== current.get(file));
		const deleted = [...stamps.keys()].filter((file) => !current.has(file));
		const previous = snapshot;
		if (previous && !created.length && !changed.length && !deleted.length) return previous;
		snapshot = previous
			? await api.updateSnapshot({
					openFiles: created,
					closeFiles: deleted,
					fileChanges: { changed, created, deleted },
				})
			: await api.updateSnapshot({ openProjects: [project.tsconfig], openFiles: created });
		// Record the files only once TypeScript has them, so a failed update is retried next time.
		stamps.clear();
		for (const [file, stamp] of current) stamps.set(file, stamp);
		if (previous) {
			api.clearSourceFileCache();
			await previous.dispose();
		}
		return snapshot;
	};

	const serially = <T>(task: () => Promise<T>): Promise<T> => {
		const result = sequence.then(task);
		sequence = result.catch(() => undefined);
		return result;
	};

	// Every reference TypeScript resolves to the symbol `handle` names, with where it sits and the call it makes.
	const collect = async (handle: string, includeDeclaration: boolean, paths: PathMapper, current?: Snapshot) => {
		const ref = fromHandle(handle);
		if (!ref) throw new Error(`${handle} not found`);
		const active = current ?? (await refresh());
		// The graph covers files anywhere in the repository, sibling packages included, so references do too.
		const inRepository = (absolute: string) => {
			// Compare resolved paths: the project's may run through a symlink (`/var` on macOS), the repository's doesn't.
			let actual = absolute;
			try {
				actual = realpathSync(absolute);
			} catch {
				// A file that doesn't exist yet can't be referenced anyway; compare it as given.
			}
			const path = relative(paths.repository, actual);
			return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
		};
		const file = resolve(project.root, ref.file);
		const local = relative(project.root, file);
		if (!inRepository(file)) throw new Error(`${handle} not found`);
		const home = await active.getDefaultProjectForFile(file);
		const source = await home?.program.getSourceFile(file);
		// Each file is named once per query, however many of its references there are.
		const indexes = new Map<string, DeclarationIndex>();
		const indexOf = (sourceFile: SourceFile) => {
			let index = indexes.get(sourceFile.fileName);
			if (!index) indexes.set(sourceFile.fileName, (index = indexDeclarations(sourceFile)));
			return index;
		};
		const declaration = source && findDeclaration(indexOf(source), ref.name, ref.kind);
		const shared = source && !declaration ? merged(indexOf(source), ref.name) : [];
		if (shared.length)
			throw new Error(
				`${handle} is ${shared.length} declarations the graph merges; use one: ${shared.map((item) => toHandle(paths.toRepositoryPath(local.split(sep).join("/")), item.name, graphKind(item.kind))).join(", ")}`,
			);
		if (!home || !source || !declaration) throw new Error(`${handle} not found`);
		// Its overloads and merged declarations share its full name.
		const own = indexOf(source).of(declaration)!.name;
		const start = declaration.getStart(source);
		// Ask from the declaration's name, or for an anonymous default export its `default` keyword: its start is a
		// modifier such as `export`, which names nothing.
		const named =
			(declaration as { name?: Node }).name ??
			(declaration as { modifiers?: readonly Node[] }).modifiers?.find(
				(modifier) => modifier.kind === SyntaxKind.DefaultKeyword,
			);
		const asked = named?.getStart(source) ?? start;
		const subject = isConstructorDeclaration(declaration) ? declaration : getTouchingPropertyName(source, asked);
		const entries = await home.checker.getReferencedSymbolsForNode(subject, asked);
		const found: Found[] = [];
		const seen = new Set<string>();
		const lines = new Map<string, string[]>();
		const text = (origin: SourceFile) => {
			if (!lines.has(origin.fileName)) lines.set(origin.fileName, origin.text.split(/\r\n|\n|\r/));
			return lines.get(origin.fileName)!;
		};
		for (const entry of entries.flatMap((item) => item.references)) {
			const reference = await entry.resolve(home);
			// A constructor's own entry resolves to an empty placeholder at the start of its file, which is no occurrence.
			if (!reference || reference.end <= reference.pos) continue;
			const origin = reference.getSourceFile();
			const offset = reference.getStart(origin);
			// Another symbol's declaration is left out, except an object literal's member: writing it uses its type's.
			const declared = declarationNamed(reference, indexOf(origin));
			if (declared && (declared.name === own ? !includeDeclaration : !inObjectLiteral(reference.parent!))) continue;
			if (!inRepository(origin.fileName)) continue;
			const path = relative(project.root, origin.fileName);
			const key = `${origin.fileName}:${offset}:${reference.end}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const position = (at: number) => origin.getLineAndCharacterOfPosition(at);
			const range = (node: Node): Range => {
				const from = position(node.getStart(origin));
				const to = position(node.end);
				return { line: from.line + 1, col: from.character + 1, endLine: to.line + 1, endCol: to.character + 1 };
			};
			const { line, character } = position(offset);
			const call = enclosingCall(reference);
			const last = call ? position(call.end).line : line;
			const outputFile = paths.toRepositoryPath(path.split(sep).join("/"));
			const container = containerOf(reference, origin, indexOf(origin), outputFile);
			found.push({
				file: outputFile,
				line: line + 1,
				col: character + 1,
				endCol: position(reference.end).character + 1,
				...(last > line ? { endLine: last + 1 } : {}),
				text: text(origin)
					.slice(line, last + 1)
					.join("\n"),
				...(container ? { container } : {}),
				...(call
					? {
							call: {
								...range(call),
								arguments: [...((call as unknown as { arguments?: readonly Node[] }).arguments ?? [])].map(range),
							},
						}
					: {}),
			});
		}
		found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
		const declared = source.getLineAndCharacterOfPosition(start).line;
		return {
			name: ref.name,
			found,
			declaration: {
				file: paths.toRepositoryPath(local.split(sep).join("/")),
				line: declared + 1,
				text: text(source)[declared]?.trim() ?? "",
			},
		};
	};

	return {
		query: (request, paths) =>
			serially(async () => {
				if (typeof request.symbol !== "string")
					throw new Error(`request.symbol must be string (got ${JSON.stringify(request.symbol) ?? "undefined"})`);
				if (request.includeDeclaration !== undefined && typeof request.includeDeclaration !== "boolean")
					throw new Error(
						`request.includeDeclaration must be boolean (got ${JSON.stringify(request.includeDeclaration)})`,
					);
				const { name, found, declaration } = await collect(request.symbol, request.includeDeclaration === true, paths);
				const nodes: GraphNode[] = found.map(({ container, ...item }) => ({
					handle: `${item.file}#reference:${item.line}:${item.col}:${item.endCol}`,
					name,
					...item,
					...(container ? { in: container } : {}),
					ranges: null,
				}));
				return {
					type: "references",
					shown: nodes.length,
					nodes,
					edges: [],
					sections: { symbol: name, declaration },
				};
			}),
		reexport: (file, name) =>
			serially(async () => {
				const active = await refresh();
				const absolute = resolve(project.root, file);
				const home = await active.getDefaultProjectForFile(absolute);
				const source = await home?.program.getSourceFile(absolute);
				if (!home || !source) return undefined;
				const root = realpathSync(project.root);
				const where = async (symbol: Awaited<ReturnType<typeof home.checker.getAliasedSymbol>>) => {
					const node = symbol.declarations[0] && (await symbol.declarations[0].resolve());
					return node && relative(root, realpathSync(node.getSourceFile().fileName));
				};
				// Walk the name a part at a time: each part is an export of the module before it, and `export * as ns`
				// makes a part a module itself, as in `src/index.ts#Accordion.Root`.
				const parts = name.split(".");
				let module = await home.checker.getSymbolAtLocation(source);
				let used = 0;
				while (module) {
					const exported = await home.checker.getMemberInModuleExports(module, parts[used]!);
					if (!exported) return undefined;
					used++;
					// A re-export is an alias; follow it through barrels to the declaration.
					const target = exported.flags & SymbolFlags.Alias ? await home.checker.getAliasedSymbol(exported) : exported;
					const isFile = target.declarations[0]?.kind === SyntaxKind.SourceFile;
					if (isFile && used < parts.length) {
						module = target;
						continue;
					}
					const declaring = await where(target);
					if (!declaring) return undefined;
					if (isFile) return { namespace: declaring };
					if (used === 1 && declaring === relative(root, realpathSync(absolute))) return undefined;
					return { file: declaring, name: [target.name, ...parts.slice(used)].join(".") };
				}
				return undefined;
			}),
		close: () =>
			serially(async () => {
				closed = true;
				await snapshot?.dispose();
				await api.close();
			}),
	};
}
