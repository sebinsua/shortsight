import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { parse } from "@ast-grep/napi";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { editingFiles } from "../program/file-outcomes.ts";
import { notifyTypeScriptServer, recordTypeScriptFiles, withTypeScriptServer } from "./lsp-client.ts";
import { relativeCandidates, resolveModule } from "./move-imports.ts";
import { scriptLanguage, withoutComments } from "./placement.ts";
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
		const position = symbolPosition(
			symbols ?? [],
			options.symbol,
			options.file,
			"refactor.rename",
			readFileSync(file, "utf8"),
		);
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
		const position = symbolPosition(
			symbols ?? [],
			options.symbol,
			options.file,
			"refactor.references",
			readFileSync(file, "utf8"),
		);
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
 * keep the old key. Expand those to `parseUser: decodeUser` so only the referenced value changes.
 */
function keepShorthandPropertyNames(symbol: string, declarationFile: string, declaration: Position): AdjustEdit {
	const shorthands = new Map<string, Map<number, string>>();
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
		return kind === "shorthand_property_identifier" || renamingBinding ? `${symbol}: ${text}` : text;
	};
}

function offsetOf(source: string, position: Position): number {
	const lines = source.split("\n");
	// TypeScript counts characters after a byte order mark; the source and ast-grep's offsets include it.
	const bom = source.startsWith("\uFEFF") && position.line === 0 ? 1 : 0;
	return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character + bom;
}

/**
 * Moves a file by writing it anew and removing the old one. A rename within one directory, such as `a.ts` to
 * `a.tsx`, isn't recorded correctly by the macOS workspace (AgentFS), and the run can't be applied.
 */
function moveFile(from: string, to: string): void {
	const stats = lstatSync(from);
	if (stats.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
	else {
		writeFileSync(to, readFileSync(from));
		chmodSync(to, stats.mode & 0o7777);
	}
	unlinkSync(from);
}

/** Whether `specifier` in `file` will resolve to `destination` once `target` has moved there. */
function stillLeadsTo(file: string, specifier: string, target: string, destination: string): boolean {
	for (const candidate of relativeCandidates(file, specifier)) {
		if (candidate === resolve(destination)) return true;
		if (candidate !== resolve(target) && existsSync(candidate) && statSync(candidate).isFile()) return false;
	}
	return false;
}

/** Whether a relative specifier leads somewhere from `file`: a file as written, or a module TypeScript-style. */
function leadsSomewhere(file: string, specifier: string): boolean {
	return existsSync(resolve(dirname(file), specifier)) || resolveModule(file, specifier) !== undefined;
}

/**
 * Relative paths in a moved file that worked from where it was and don't from where it goes: static and side-effect
 * imports of assets, `import()`, `require()` and `new URL()`. Ones TypeScript already updated work from both.
 */
function repointMovedPaths(text: string, from: string, to: string): string {
	if (dirname(from) === dirname(to)) return text;
	return text.replace(
		/(\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)(["'])(\.\.?\/[^"'\n]*)\2/g,
		(whole, before: string, quote: string, specifier: string) => {
			if (!leadsSomewhere(from, specifier) || leadsSomewhere(to, specifier)) return whole;
			let path = relative(dirname(to), resolve(dirname(from), specifier)).replaceAll("\\", "/");
			if (!path.startsWith(".")) path = `./${path}`;
			return `${before}${quote}${path}${quote}`;
		},
	);
}

/**
 * Git-visible scripts with a relative import, export, require or import() of `target` that won't still lead to it
 * once it's at `destination`: TypeScript rightly leaves `./a` alone when `a.ts` becomes `a.tsx` or `a/index.ts`.
 */
function relativeImporters(root: string, target: string, destination: string, edited: Map<string, string>): string[] {
	const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		encoding: "utf8",
	});
	if (listed.status !== 0) return [];
	const real = realpathSync(target);
	const specifier = /(?:\bfrom|\bimport|\brequire\(|\bimport\()\s*["'](\.{1,2}\/[^"']*)["']/g;
	return listed.stdout
		.split("\0")
		.filter((file) => /\.[cm]?[jt]sx?$/.test(file))
		.map((file) => resolve(root, file))
		.filter((file) => {
			if (file === target || !existsSync(file)) return false;
			// As TypeScript would leave it: an edited importer can still have a path it didn't update, such as a
			// `require()` beside an updated import.
			const text = withoutComments(file, edited.get(file) ?? readFileSync(file, "utf8"));
			return [...text.matchAll(specifier)].some(
				(match) => resolveModule(file, match[1]!) === real && !stillLeadsTo(file, match[1]!, target, destination),
			);
		});
}

export async function renameFile(root: string, options: RenameFileOptions): Promise<void> {
	validateRenameFile(options);
	const from = existingProjectFile(root, options.from);
	const to = projectPath(root, options.to);
	if (from === to) throw new Error("refactor.renameFile source and destination are the same file");
	if (lstatSync(to, { throwIfNoEntry: false }))
		throw new Error(`refactor.renameFile destination already exists: ${JSON.stringify(options.to)}`);
	if (!/\.(?:[cm]?[jt]sx?|json)$/.test(to))
		throw new Error(
			`refactor.renameFile destination needs a module extension, such as .ts: ${JSON.stringify(options.to)}`,
		);
	// The TypeScript server only renames modules; given a stylesheet or a document, it stops.
	if (!/\.(?:[cm]?[jt]sx?|json)$/.test(from))
		throw new Error(
			`refactor.renameFile moves JavaScript and TypeScript modules; move ${JSON.stringify(options.from)} with Bun and update the paths to it with sg.rewrite`,
		);

	await withTypeScriptServer(root, async (server) => {
		const files = [{ oldUri: pathToFileURL(from).href, newUri: pathToFileURL(to).href }];
		const edit = await server.sendRequest<WorkspaceEdit | null>("workspace/willRenameFiles", { files });
		const changes = planWorkspaceEdit(root, edit);
		// The moved file's relative paths TypeScript doesn't resolve, such as CSS or a `new URL("./logo.svg")`.
		const moved = changes.get(from) ?? readFileSync(from, "utf8");
		const repointed = repointMovedPaths(moved, from, to);
		if (repointed !== moved) changes.set(from, repointed);
		// The server can return no edits at all, as when a file augments this one with `declare module`. Check its
		// answer against the files that import this one by a relative path, rather than leave them broken.
		const missed = relativeImporters(root, from, to, changes);
		if (missed.length)
			throw new Error(
				`refactor.renameFile: TypeScript didn't update the import of ${JSON.stringify(options.from)} in ${missed.map((file) => JSON.stringify(relative(root, file))).join(", ")}, so nothing was renamed. It doesn't update \`require()\` calls, and a \`declare module\` augmentation of the file stops it; update those paths with sg.rewrite and move the file with Bun.`,
			);
		editingFiles([...changes.keys(), from, to], () => {
			for (const [changedFile, source] of changes) writeFileSync(changedFile, source);
			mkdirSync(dirname(to), { recursive: true });
			moveFile(from, to);
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
	// The new name alone: `to: "Session.renew"` would be written out as is.
	const privateName = options.symbol.split(".").at(-1)!.startsWith("#");
	if (
		!(
			privateName
				? /^#[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u
				: /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u
		).test(options.to)
	)
		throw new Error(
			`refactor.rename: ${JSON.stringify(options.to)} isn't a name; give the new name alone${options.to.includes(".") ? `, such as ${JSON.stringify(options.to.split(".").at(-1))}` : ""}`,
		);
}

function validateRenameFile(options: RenameFileOptions): void {
	if (!options || typeof options.from !== "string" || typeof options.to !== "string")
		throw new TypeError("refactor.renameFile expects { from, to } strings");
	if (!options.from || !options.to) throw new Error("refactor.renameFile from and to must not be empty");
}

const samePosition = (a: Position, b: Position) => a.line === b.line && a.character === b.character;

/**
 * The members of type aliases' object types, `User.name` for `type User = { name: string }`, including those of
 * intersections and unions: the server's document symbols leave them out.
 */
function typeAliasMembers(file: string, source: string): { name: string; position: Position }[] {
	const lang = scriptLanguage(file);
	if (!lang || !source) return [];
	const members: { name: string; position: Position }[] = [];
	for (const alias of parse(lang, source)
		.root()
		.findAll({ rule: { kind: "type_alias_declaration" } })) {
		const owner = alias.field("name")?.text();
		const value = alias.field("value");
		if (!owner || !value) continue;
		const objects =
			value.kind() === "object_type"
				? [value]
				: value.findAll({
						rule: { kind: "object_type", inside: { kind: "type_alias_declaration", stopBy: { kind: "object_type" } } },
					});
		for (const object of objects)
			for (const member of object.children()) {
				if (!["property_signature", "method_signature"].includes(String(member.kind()))) continue;
				const name = member.field("name");
				if (!name) continue;
				const { line, column } = name.range().start;
				members.push({ name: `${owner}.${name.text()}`, position: { line, character: column } });
			}
	}
	return members;
}

function symbolPosition(
	symbols: Array<DocumentSymbol | SymbolInformation>,
	name: string,
	file: string,
	helper: string,
	source = "",
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
	entries.push(
		...typeAliasMembers(file, source).filter(
			(member) => !entries.some((entry) => samePosition(entry.position, member.position)),
		),
	);
	const found = entries.filter((entry) =>
		name.includes(".") ? entry.name === name : entry.name.split(".").at(-1) === name,
	);
	if (found.length === 0)
		throw new Error(`${helper} found no declaration named ${JSON.stringify(name)} in ${JSON.stringify(file)}`);
	// A bare name means the top-level declaration when there is one, not also members and locals named like it:
	// otherwise `parseUser`, offered below as a choice, would be just as ambiguous.
	const topLevel = found.filter((entry) => entry.name === name);
	if (found.length > 1 && topLevel.length === 1) return topLevel[0]!.position;
	// A type and a value of one name (`type Status` with `const Status`) are one symbol to TypeScript.
	// The server gives a position at the name or, for some declarations, at the `export` before them.
	const kindAt = ({ line, character }: Position) => {
		const text = source.split("\n")[line] ?? "";
		return /\b(?:type|interface)\s+$/.test(text.slice(0, character)) ||
			/^(?:export\s+)?(?:declare\s+)?(?:type|interface)\b/.test(text.slice(character))
			? "type"
			: "value";
	};
	if (
		found.length === 2 &&
		new Set(found.map((entry) => entry.name)).size === 1 &&
		kindAt(found[0]!.position) !== kindAt(found[1]!.position)
	)
		return found[0]!.position;
	// A property's `get` and `set` accessors are one symbol to TypeScript, listed twice: either renames both.
	// The server gives an accessor's position at its `get` or `set` keyword; the name follows it.
	const lines = source.split("\n");
	const accessorName = ({ line, character }: Position): Position | undefined => {
		const keyword = /^(?:static\s+)?[gs]et\s+/.exec(lines[line]?.slice(character) ?? "");
		return keyword ? { line, character: character + keyword[0].length } : undefined;
	};
	if (
		found.length > 1 &&
		new Set(found.map((entry) => entry.name)).size === 1 &&
		found.every((entry) => accessorName(entry.position))
	)
		return accessorName(found[0]!.position)!;
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
