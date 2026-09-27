// Find every compiler-resolved use of a graph symbol in the project's real files.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { API, type Snapshot } from "typescript/unstable/async";
import {
	getTouchingPropertyName,
	isCallExpression,
	isClassDeclaration,
	isConstructorDeclaration,
	isEnumDeclaration,
	isFunctionDeclaration,
	isGetAccessorDeclaration,
	isIdentifier,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isModuleBlock,
	isModuleDeclaration,
	isNewExpression,
	isPropertyAccessExpression,
	isPropertyDeclaration,
	isPropertySignatureDeclaration,
	isSetAccessorDeclaration,
	isSourceFile,
	isTypeAliasDeclaration,
	isVariableDeclaration,
	isVariableStatement,
	SyntaxKind,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";
import { fromHandle, type GraphNode, type GraphResult } from "./model.ts";
import type { PathMapper } from "./paths.ts";
import { projectFiles, type Project } from "./project.ts";
import { graphKind, hasModifier, listedExports } from "./ranges.ts";

export interface ReferenceIndex {
	query(request: Record<string, unknown>, paths: PathMapper): Promise<GraphResult>;
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

function declarationName(node: Node): string | undefined {
	if (!isIdentifier(node)) return undefined;
	const parent = node.parent;
	if (!parent || !("name" in parent) || parent.name !== node) return undefined;
	const named =
		isFunctionDeclaration(parent) ||
		isClassDeclaration(parent) ||
		isInterfaceDeclaration(parent) ||
		isTypeAliasDeclaration(parent) ||
		isEnumDeclaration(parent) ||
		isVariableDeclaration(parent) ||
		isMethodDeclaration(parent) ||
		isMethodSignatureDeclaration(parent) ||
		isPropertyDeclaration(parent) ||
		isPropertySignatureDeclaration(parent) ||
		isGetAccessorDeclaration(parent) ||
		isSetAccessorDeclaration(parent);
	if (!named) return undefined;
	let name = node.text;
	if (
		isMethodDeclaration(parent) ||
		isMethodSignatureDeclaration(parent) ||
		isPropertyDeclaration(parent) ||
		isPropertySignatureDeclaration(parent) ||
		isGetAccessorDeclaration(parent) ||
		isSetAccessorDeclaration(parent)
	) {
		const owner = parent.parent;
		if (isClassDeclaration(owner) || isInterfaceDeclaration(owner))
			name = `${owner.name?.text ?? "default"}.${node.text}`;
	}
	for (let ancestor = parent.parent; ancestor; ancestor = ancestor.parent)
		if (isModuleDeclaration(ancestor)) name = `${ancestor.name.getText()}.${name}`;
	return name;
}

function findDeclaration(source: SourceFile, name: string, kind: string): Node | undefined {
	let found: Node | undefined;
	const visit = (node: Node): void => {
		if (found) return;
		if (
			declarationName(node) === name ||
			(isConstructorDeclaration(node) &&
				isClassDeclaration(node.parent) &&
				`${node.parent.name?.text ?? "default"}.__constructor` === name) ||
			(name === "default" &&
				!(node as { name?: Node }).name &&
				hasModifier(node, SyntaxKind.DefaultKeyword) &&
				((kind === "function" && isFunctionDeclaration(node)) || (kind === "class" && isClassDeclaration(node))))
		) {
			found = node;
			return;
		}
		node.forEachChild(visit);
	};
	visit(source);
	return found;
}

// The call or `new` a reference is the callee of, so a call split over lines can be shown whole.
function enclosingCall(reference: Node): Node | undefined {
	let callee = reference;
	if (callee.parent && isPropertyAccessExpression(callee.parent) && callee.parent.name === callee)
		callee = callee.parent;
	const call = callee.parent;
	return call && (isCallExpression(call) || isNewExpression(call)) && call.expression === callee ? call : undefined;
}

// The declaration a reference sits in, named the way the graph names symbols: a class member, or else the
// top-level function, class, variable or type. Imports, re-exports and module-level statements have none.
function containerOf(reference: Node, source: SourceFile, file: string): Container | undefined {
	let member: Node | undefined;
	let namespaceMember: Node | undefined;
	const namespaces: string[] = [];
	let top: Node | undefined;
	for (let node = reference.parent; node; node = node.parent) {
		const owner = node.parent;
		if (!namespaceMember && owner && isModuleBlock(owner)) namespaceMember = node;
		if (isModuleDeclaration(node)) namespaces.unshift(node.name.getText(source));
		if (
			!member &&
			owner &&
			(isClassDeclaration(owner) || isInterfaceDeclaration(owner)) &&
			(isMethodDeclaration(node) ||
				isMethodSignatureDeclaration(node) ||
				isGetAccessorDeclaration(node) ||
				isSetAccessorDeclaration(node) ||
				isPropertyDeclaration(node) ||
				isPropertySignatureDeclaration(node) ||
				isConstructorDeclaration(node))
		)
			member = node;
		if (owner && isSourceFile(owner)) {
			top = node;
			break;
		}
	}
	if (!top) return undefined;
	const line = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
	const span = (node: Node) => ({
		start: line(node.getStart(source)),
		end: line(Math.max(node.getStart(source), node.end - 1)),
	});
	const exported = (name: string) =>
		hasModifier(top, SyntaxKind.ExportKeyword) || listedExports(source).has(name) ? { exported: true as const } : {};
	const named = (name: string, kind: string, node: Node, exports = true): Container => ({
		handle: `${file}#${name}:${kind}`,
		name,
		kind,
		...span(node),
		...(exports ? exported(name) : {}),
	});
	if (isFunctionDeclaration(top) && (top.name || hasModifier(top, SyntaxKind.DefaultKeyword)))
		return named(top.name?.text ?? "default", "function", top);
	if (isClassDeclaration(top) && (top.name || hasModifier(top, SyntaxKind.DefaultKeyword))) {
		if (!member) return named(top.name?.text ?? "default", "class", top);
		const name = isConstructorDeclaration(member)
			? "__constructor"
			: (member as unknown as { name: Node }).name.getText(source);
		return named(
			`${top.name?.text ?? "default"}.${name}`,
			graphKind(isPropertyDeclaration(member) ? "property" : "method"),
			member,
			false,
		);
	}
	if (isVariableStatement(top)) {
		const declaration = top.declarationList.declarations.find(
			(item) => item.pos <= reference.pos && reference.end <= item.end && isIdentifier(item.name),
		);
		return declaration && isIdentifier(declaration.name) ? named(declaration.name.text, "variable", top) : undefined;
	}
	if (isInterfaceDeclaration(top)) {
		if (!member) return named(top.name.text, "interface", top);
		const name = (member as unknown as { name: Node }).name.getText(source);
		return named(
			`${top.name.text}.${name}`,
			graphKind(isPropertySignatureDeclaration(member) ? "property" : "method"),
			member,
			false,
		);
	}
	if (isModuleDeclaration(top) && namespaceMember) {
		const name = namespaces.join(".");
		if (isFunctionDeclaration(namespaceMember) && namespaceMember.name)
			return named(`${name}.${namespaceMember.name.text}`, "function", namespaceMember, false);
	}
	if (isTypeAliasDeclaration(top)) return named(top.name.text, "type", top);
	if (isEnumDeclaration(top)) return named(top.name.text, "enum", top);
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
		const declaration = source && findDeclaration(source, ref.name, ref.kind);
		if (!home || !source || !declaration) throw new Error(`${handle} not found`);
		const start = declaration.getStart(source);
		const subject = isConstructorDeclaration(declaration) ? declaration : getTouchingPropertyName(source, start);
		const entries = await home.checker.getReferencedSymbolsForNode(subject, start);
		const found: Found[] = [];
		const seen = new Set<string>();
		const lines = new Map<string, string[]>();
		const text = (origin: SourceFile) => {
			if (!lines.has(origin.fileName)) lines.set(origin.fileName, origin.text.split(/\r\n|\n|\r/));
			return lines.get(origin.fileName)!;
		};
		for (const entry of entries.flatMap((item) => item.references)) {
			const reference = await entry.resolve(home);
			if (!reference) continue;
			const origin = reference.getSourceFile();
			const offset = reference.getStart(origin);
			const declaredName = declarationName(reference);
			if (declaredName && (!includeDeclaration || declaredName !== ref.name)) continue;
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
			const container = containerOf(reference, origin, outputFile);
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
		close: () =>
			serially(async () => {
				closed = true;
				await snapshot?.dispose();
				await api.close();
			}),
	};
}
