import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse } from "@ast-grep/napi";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { editingFiles } from "../program/file-outcomes.ts";
import { notifyTypeScriptServer, recordTypeScriptFiles, withTypeScriptServer } from "./lsp-client.ts";
import { scriptLanguage } from "./placement.ts";
import {
	existingProjectFile,
	planWorkspaceEdit,
	projectPath,
	type Position,
	type AdjustEdit,
	type Range,
	type WorkspaceEdit,
} from "./workspace-edit.ts";

export interface RenameOptions<File = string> {
	file: File;
	symbol: string;
	to: string;
}

export interface ReferencesOptions<File = string> {
	file: File;
	symbol: string;
	includeDeclaration?: boolean;
}

export interface ReferenceLocation {
	uri: string;
	range: Range;
}

export interface RenameFileOptions<File = string> {
	from: File;
	to: File;
}

interface DocumentSymbol {
	name: string;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

interface SymbolInformation {
	name: string;
	containerName?: string;
	location: { range: Range };
}

export async function rename(root: string, options: RenameOptions): Promise<void> {
	validateRename(options);
	const file = existingProjectFile(root, options.file);
	const uri = pathToFileURL(file).href;
	await withTypeScriptServer(root, async (server) => {
		const symbols = await server.sendRequest<Array<DocumentSymbol | SymbolInformation> | null>(
			"textDocument/documentSymbol",
			{ textDocument: { uri } },
		);
		const position = symbolPosition(symbols ?? [], options.symbol, options.file, "refactor.rename");
		const edit = await server.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
			textDocument: { uri },
			position,
			newName: options.to,
		});
		const changes = planWorkspaceEdit(
			root,
			edit,
			keepShorthandPropertyNames(options.symbol.split(".").at(-1)!, file, position),
		);
		if (changes.size === 0) throw new Error(`TypeScript returned no edits for ${JSON.stringify(options.symbol)}`);
		editingFiles([...changes.keys()], () => {
			for (const [changedFile, source] of changes) writeFileSync(changedFile, source);
		});
		await filesChanged(server, [...changes.keys()]);
	});
}

/** Compiler-resolved reference spans, kept as LSP locations for the caller to turn into sg matches. */
export async function references(root: string, options: ReferencesOptions): Promise<ReferenceLocation[]> {
	if (!options || typeof options.file !== "string" || typeof options.symbol !== "string")
		throw new TypeError("refactor.references expects { file, symbol } strings");
	if (!options.file || !options.symbol) throw new Error("refactor.references file and symbol must not be empty");
	const file = existingProjectFile(root, options.file);
	const uri = pathToFileURL(file).href;
	return withTypeScriptServer(root, async (server) => {
		const symbols = await server.sendRequest<Array<DocumentSymbol | SymbolInformation> | null>(
			"textDocument/documentSymbol",
			{ textDocument: { uri } },
		);
		const position = symbolPosition(symbols ?? [], options.symbol, options.file, "refactor.references");
		return (
			(await server.sendRequest<ReferenceLocation[] | null>("textDocument/references", {
				textDocument: { uri },
				position,
				context: { includeDeclaration: options.includeDeclaration === true },
			})) ?? []
		);
	});
}

/**
 * The server renames without aliases, so imports and re-exports follow the new name (see lsp-client.ts). That
 * would also change the key of an object literal shorthand such as `{ parseUser }`, while reads of that property
 * keep the old key. Expand those to `parseUser: decodeUser` so only the referenced value changes. When the renamed
 * symbol is the property itself (`User.name`), it's the other way round: `{ name }` becomes `{ fullName: name }`.
 */
function keepShorthandPropertyNames(symbol: string, declarationFile: string, declaration: Position): AdjustEdit {
	const shorthands = new Map<string, Map<number, string>>();
	let renamingProperty: boolean | undefined;
	return (file, source, start, end, text) => {
		if (source.slice(start, end) !== symbol) return text;
		let kinds = shorthands.get(file);
		if (!kinds) {
			const lang = scriptLanguage(file);
			const nodes = lang
				? parse(lang, source)
						.root()
						.findAll({
							rule: {
								any: [{ kind: "shorthand_property_identifier" }, { kind: "shorthand_property_identifier_pattern" }],
							},
						})
				: [];
			kinds = new Map(nodes.map((node) => [node.range().start.index, String(node.kind())]));
			shorthands.set(file, kinds);
		}
		const kind = kinds.get(start);
		// In `const { parseUser } = api` the key names a property: it keeps its name when the renamed symbol is
		// this local binding, and follows the rename when it is the export being read.
		const renamingBinding =
			kind === "shorthand_property_identifier_pattern" &&
			file === declarationFile &&
			start === offsetOf(source, declaration);
		if (kind === "shorthand_property_identifier") {
			renamingProperty ??= declaresProperty(declarationFile, declaration);
			return renamingProperty ? `${text}: ${symbol}` : `${symbol}: ${text}`;
		}
		return renamingBinding ? `${symbol}: ${text}` : text;
	};
}

/** Whether the name at `position` declares a property (an interface or class member, say) rather than a value. */
function declaresProperty(file: string, position: Position): boolean {
	const lang = scriptLanguage(file);
	if (!lang) return false;
	const source = readFileSync(file, "utf8");
	const offset = offsetOf(source, position);
	return parse(lang, source)
		.root()
		.findAll({ rule: { any: [{ kind: "property_identifier" }, { kind: "private_property_identifier" }] } })
		.some((node) => node.range().start.index === offset);
}

function offsetOf(source: string, position: Position): number {
	const lines = source.split("\n");
	return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character;
}

export async function renameFile(root: string, options: RenameFileOptions): Promise<void> {
	validateRenameFile(options);
	const from = existingProjectFile(root, options.from);
	const to = projectPath(root, options.to);
	if (from === to) throw new Error("refactor.renameFile source and destination are the same file");
	if (lstatSync(to, { throwIfNoEntry: false }))
		throw new Error(`refactor.renameFile destination already exists: ${JSON.stringify(options.to)}`);

	await withTypeScriptServer(root, async (server) => {
		const files = [{ oldUri: pathToFileURL(from).href, newUri: pathToFileURL(to).href }];
		const edit = await server.sendRequest<WorkspaceEdit | null>("workspace/willRenameFiles", { files });
		const changes = planWorkspaceEdit(root, edit);
		editingFiles([...changes.keys(), from, to], () => {
			for (const [changedFile, source] of changes) writeFileSync(changedFile, source);
			mkdirSync(dirname(to), { recursive: true });
			renameSync(from, to);
		});
		await notifyTypeScriptServer(server, "workspace/didRenameFiles", { files });
		await filesChanged(
			server,
			[...changes.keys()].filter((file) => file !== from),
			[from],
			[to],
		);
	});
}

async function filesChanged(
	server: Parameters<typeof notifyTypeScriptServer>[0],
	changed: string[],
	deleted: string[] = [],
	created: string[] = [],
): Promise<void> {
	recordTypeScriptFiles(server, [...changed, ...deleted, ...created]);
	await notifyTypeScriptServer(server, "workspace/didChangeWatchedFiles", {
		changes: [
			...changed.map((file) => ({ uri: pathToFileURL(file).href, type: 2 })),
			...deleted.map((file) => ({ uri: pathToFileURL(file).href, type: 3 })),
			...created.map((file) => ({ uri: pathToFileURL(file).href, type: 1 })),
		],
	});
}

function validateRename(options: RenameOptions): void {
	if (
		!options ||
		typeof options.file !== "string" ||
		typeof options.symbol !== "string" ||
		typeof options.to !== "string"
	)
		throw new TypeError("refactor.rename expects { file, symbol, to } strings");
	if (!options.file || !options.symbol || !options.to)
		throw new Error("refactor.rename file, symbol and to must not be empty");
}

function validateRenameFile(options: RenameFileOptions): void {
	if (!options || typeof options.from !== "string" || typeof options.to !== "string")
		throw new TypeError("refactor.renameFile expects { from, to } strings");
	if (!options.from || !options.to) throw new Error("refactor.renameFile from and to must not be empty");
}

function symbolPosition(
	symbols: Array<DocumentSymbol | SymbolInformation>,
	name: string,
	file: string,
	helper: string,
): Position {
	const entries: { name: string; position: Position }[] = [];
	const visit = (items: Array<DocumentSymbol | SymbolInformation>, container = "") => {
		for (const item of items) {
			const parent = "containerName" in item ? item.containerName || container : container;
			const local = item.name === "constructor" ? "__constructor" : item.name;
			const qualified = parent ? `${parent}.${local}` : local;
			entries.push({
				name: qualified,
				position: "selectionRange" in item ? item.selectionRange.start : item.location.range.start,
			});
			if ("children" in item && item.children) visit(item.children, qualified);
		}
	};
	visit(symbols);
	const found = entries.filter((entry) =>
		name.includes(".") ? entry.name === name : entry.name.split(".").at(-1) === name,
	);
	if (found.length === 0)
		throw new Error(`${helper} found no declaration named ${JSON.stringify(name)} in ${JSON.stringify(file)}`);
	if (found.length > 1) {
		const names = [...new Set(found.map((entry) => entry.name))];
		if (names.length > 1)
			throw new Error(`${JSON.stringify(name)} is ambiguous in ${file}; use one of: ${names.join(", ")}`);
		throw new Error(
			`${helper} found more than one declaration named ${JSON.stringify(name)} in ${JSON.stringify(file)}`,
		);
	}
	return found[0]!.position;
}
