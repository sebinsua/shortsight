// Parse syntax ranges for graph symbols without loading the target project.
import { readFile, realpath, stat } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { API } from "typescript/unstable/async";
import {
	SyntaxKind,
	isClassDeclaration,
	isConstructorDeclaration,
	isEnumDeclaration,
	isExportAssignment,
	isExportDeclaration,
	isFunctionDeclaration,
	isGetAccessorDeclaration,
	isIdentifier,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isNamedExports,
	isPropertyDeclaration,
	isPropertySignatureDeclaration,
	isSetAccessorDeclaration,
	isTypeAliasDeclaration,
	isVariableStatement,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";
import type { FileSystem } from "typescript/unstable/fs";

export type DeclarationKind = "function" | "class" | "method" | "property" | "variable" | "interface" | "type" | "enum";

export interface Declaration {
	name: string;
	kind: DeclarationKind;
	start: number;
	end: number;
	codeStart: number;
	/** A top-level declaration the module exports, by an `export` modifier or its own export list. */
	exported?: true;
}

/** Use the graph's kind for a parsed declaration. */
export function graphKind(kind: DeclarationKind): DeclarationKind {
	return kind === "property" ? "variable" : kind;
}

export function handleFor(file: string, declaration: Declaration): string {
	return `${file}#${declaration.name}:${graphKind(declaration.kind)}`;
}

/** A function-local variable is parsed for ranges but is not a graph symbol. */
export function indexedDeclarations(items: Declaration[]): Declaration[] {
	const functions = new Set(items.filter((item) => item.kind === "function").map((item) => item.name));
	return items.filter((item) => ![...functions].some((name) => item.name.startsWith(`${name}.`)));
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

const isDefault = (node: Node) => hasModifier(node, SyntaxKind.DefaultKeyword);

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

export function hasModifier(node: Node, kind: SyntaxKind): boolean {
	return (
		"modifiers" in node &&
		Array.isArray(node.modifiers) &&
		node.modifiers.some((modifier: Node) => modifier.kind === kind)
	);
}

/** Names a module exports through its own `export { a, b as c }` or `export default a`. */
export function listedExports(sourceFile: SourceFile): Set<string> {
	const listed = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (
			isExportDeclaration(statement) &&
			!statement.moduleSpecifier &&
			statement.exportClause &&
			isNamedExports(statement.exportClause)
		)
			for (const element of statement.exportClause.elements) listed.add((element.propertyName ?? element.name).text);
		else if (isExportAssignment(statement) && isIdentifier(statement.expression)) listed.add(statement.expression.text);
	}
	return listed;
}

function collectDeclarations(sourceFile: SourceFile): Declaration[] {
	const declarations: Declaration[] = [];
	const line = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
	const listed = listedExports(sourceFile);
	const add = (name: string, kind: DeclarationKind, node: Node, topLevel = false) => {
		declarations.push({
			name,
			kind,
			start: line(documentedStart(sourceFile, node)),
			end: line(Math.max(node.getStart(sourceFile), node.end - 1)),
			codeStart: line(node.getStart(sourceFile)),
			...(topLevel && (hasModifier(node, SyntaxKind.ExportKeyword) || listed.has(name))
				? { exported: true as const }
				: {}),
		});
	};
	const addVariables = (statement: Node, prefix = "") => {
		if (!isVariableStatement(statement)) return;
		for (const variable of statement.declarationList.declarations) {
			if (isIdentifier(variable.name)) add(`${prefix}${variable.name.text}`, "variable", statement, prefix === "");
		}
	};
	for (const statement of sourceFile.statements) {
		if (isFunctionDeclaration(statement) && (statement.name || isDefault(statement))) {
			const name = statement.name?.text ?? "default";
			add(name, "function", statement, true);
			for (const inner of statement.body?.statements ?? []) addVariables(inner, `${name}.`);
		} else if (isClassDeclaration(statement) && (statement.name || isDefault(statement))) {
			const name = statement.name?.text ?? "default";
			add(name, "class", statement, true);
			for (const member of statement.members) {
				if (isConstructorDeclaration(member)) add(`${name}.__constructor`, "method", member);
				else if (isMethodDeclaration(member) || isGetAccessorDeclaration(member) || isSetAccessorDeclaration(member))
					add(`${name}.${member.name.getText(sourceFile)}`, "method", member);
				else if (isPropertyDeclaration(member)) add(`${name}.${member.name.getText(sourceFile)}`, "property", member);
			}
		} else if (isInterfaceDeclaration(statement)) {
			const name = statement.name.text;
			add(name, "interface", statement, true);
			for (const member of statement.members) {
				if (isMethodSignatureDeclaration(member)) add(`${name}.${member.name.getText(sourceFile)}`, "method", member);
				else if (isPropertySignatureDeclaration(member))
					add(`${name}.${member.name.getText(sourceFile)}`, "property", member);
			}
		} else if (isTypeAliasDeclaration(statement)) add(statement.name.text, "type", statement, true);
		else if (isEnumDeclaration(statement)) add(statement.name.text, "enum", statement, true);
		else addVariables(statement);
	}
	return declarations;
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
export function createRangeIndex(root: string, options: { maxFiles?: number } = {}): RangeIndex {
	const absoluteRoot = resolve(root);
	const cache = new Map<string, { mtimeMs: number; size: number; declarations: Declaration[] }>();
	const inFlight = new Map<string, Promise<Declaration[] | undefined>>();
	const maxFiles = Math.max(0, options.maxFiles ?? 64);
	let parser: DeclarationParser | undefined;
	let closed = false;
	const insideRoot = (file: string) => {
		const path = relative(absoluteRoot, file);
		return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
	};
	const readDeclarations = async (absolute: string, file: string): Promise<Declaration[] | undefined> => {
		try {
			const actualRoot = await realpath(absoluteRoot);
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
		if (closed || isAbsolute(file) || file.includes("\\") || file.split("/").includes("..")) return undefined;
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
				declaration.name === ref.name &&
				(declaration.kind === ref.kind ||
					(ref.kind === "property" && declaration.kind === "variable") ||
					(ref.kind === "variable" && declaration.kind === "property")),
		);
	}
}
