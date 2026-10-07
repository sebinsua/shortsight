import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { parse, type SgNode } from "@ast-grep/napi";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { editingFiles } from "../program/file-outcomes.ts";
import { notifyTypeScriptServer, recordTypeScriptFiles, withTypeScriptServer } from "./lsp-client.ts";
import { exportsName, resolveModule } from "./move-imports.ts";
import { scriptLanguage } from "./placement.ts";
import {
	existingProjectFile,
	planWorkspaceEdit,
	projectPath,
	type Position,
	type AdjustEdit,
	type Range,
	type TextEdit,
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
		// `export const { auth } = NextAuth()` declares a variable that reads a property, and the server renames them as
		// one: everywhere the property is named would change too. Renaming the variable leaves the property alone.
		const binding = declaresShorthandBinding(file, position);
		if (binding) dropPropertyEdits(edit);
		const renamingProperty = !binding && declaresProperty(file, position);
		if (!renamingProperty) refuseBarrelCollision(root, file, options.symbol, options.to);
		if (renamingProperty) refuseMemberCollision(file, position, options.symbol, options.to);
		refuseCapturedRename(edit, options.symbol, options.to, renamingProperty);
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
		if (kind !== "shorthand_property_identifier" && kind !== "shorthand_property_identifier_pattern") return text;
		renamingProperty ??= declaresProperty(declarationFile, declaration);
		// In `{ name }` the key names a property and the value a variable. Renaming the property keeps the
		// variable, `{ fullName: name }`, and renaming the variable keeps the key, `{ name: displayName }`.
		if (kind === "shorthand_property_identifier") return renamingProperty ? `${text}: ${symbol}` : `${symbol}: ${text}`;
		// A pattern, as in `const { name } = user` or `({ name } = parsed)`. When the property is renamed, the
		// server renames the variable and its uses too, so `{ fullName }` stays consistent. A variable of this
		// file keeps the key; a pattern elsewhere is reading the export being renamed, as in
		// `const { parseUser } = api`, and follows the rename.
		return !renamingProperty && file === declarationFile ? `${symbol}: ${text}` : text;
	};
}

const SCOPES = new Set([
	"program",
	"statement_block",
	"function_declaration",
	"function_expression",
	"arrow_function",
	"method_definition",
	"generator_function_declaration",
	"class_declaration",
	"abstract_class_declaration",
	"class_body",
	"interface_declaration",
	"type_alias_declaration",
	"for_statement",
	"for_in_statement",
	"catch_clause",
	"module",
	"internal_module",
	// Type signatures: their parameter names declare nothing anywhere else.
	"method_signature",
	"abstract_method_signature",
	"function_signature",
	"function_type",
	"constructor_type",
	"call_signature",
	"construct_signature",
]);

/** Declarations whose own name belongs to the scope around them, not to the scope they make. */
const NAMED_FROM_OUTSIDE = new Set([
	"function_declaration",
	"generator_function_declaration",
	"function_signature",
	"class_declaration",
	"abstract_class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"internal_module",
	"module",
]);

type Space = "value" | "type";
const BOTH: Space[] = ["value", "type"];

const at = (node: SgNode | null | undefined, other: SgNode) =>
	node?.range().start.index === other.range().start.index && node.kind() === other.kind();

/**
 * What an identifier declares in its scope, a value, a type or both, or nothing when it doesn't declare: a variable,
 * function, class, enum, interface, type alias, type parameter, namespace, parameter, loop variable or import.
 */
function declaredSpaces(node: SgNode): Space[] {
	const parent = node.parent();
	if (!parent) return [];
	const named = (field: SgNode | null) => at(field, node);
	switch (String(parent.kind())) {
		case "variable_declarator":
		case "function_declaration":
		case "generator_function_declaration":
		case "function_signature":
			return named(parent.field("name")) ? ["value"] : [];
		case "class_declaration":
		case "abstract_class_declaration":
		case "enum_declaration":
		case "internal_module":
		case "module":
			return named(parent.field("name")) ? BOTH : [];
		case "interface_declaration":
		case "type_alias_declaration":
		case "type_parameter":
			return named(parent.field("name")) ? ["type"] : [];
		case "required_parameter":
		case "optional_parameter":
			return named(parent.field("pattern")) ? ["value"] : [];
		case "arrow_function":
		case "catch_clause":
			return named(parent.field("parameter")) ? ["value"] : [];
		case "for_in_statement":
		case "assignment_pattern":
		case "object_assignment_pattern":
			return named(parent.field("left")) ? ["value"] : [];
		case "pair_pattern":
			return named(parent.field("value")) ? ["value"] : [];
		case "array_pattern":
		case "rest_pattern":
			return node.kind() === "identifier" ? ["value"] : [];
		case "object_pattern":
			return node.kind() === "shorthand_property_identifier_pattern" ? ["value"] : [];
		case "namespace_import":
		case "import_clause":
			return node.kind() === "identifier" ? BOTH : [];
		case "import_specifier":
			return named(parent.field("alias") ?? parent.field("name")) ? BOTH : [];
		default:
			return [];
	}
}

/** Whether a scope itself, not a scope nested inside it, declares `name` in one of `spaces`. */
function scopeDeclares(scope: SgNode, name: string, spaces: Space[]): boolean {
	const exactly = `^${name.replace(/\$/g, "\\$")}$`;
	return scope
		.findAll({
			rule: {
				any: ["identifier", "type_identifier", "shorthand_property_identifier_pattern"].map((kind) => ({
					kind,
					regex: exactly,
				})),
			},
		})
		.some((node) => {
			if (!declaredSpaces(node).some((space) => spaces.includes(space))) return false;
			let owner = node.parent();
			if (owner && NAMED_FROM_OUTSIDE.has(String(owner.kind()))) owner = owner.parent();
			while (owner && !SCOPES.has(String(owner.kind()))) owner = owner.parent();
			return at(owner, scope);
		});
}

/**
 * Which names a renamed place would bind or refer to, or none for places nothing can capture: a member's name
 * (`A.parse`), the original name in `import { parse as p }`, a re-export's specifier, and, when a property is
 * renamed, an object literal's shorthand (it keeps its value: `{ fullName: name }`).
 */
function capturable(node: SgNode, renamingProperty: boolean): Space[] {
	const parent = node.parent();
	const kind = String(node.kind());
	if (kind === "property_identifier" || kind === "private_property_identifier") return [];
	if (kind === "shorthand_property_identifier") return renamingProperty ? [] : ["value"];
	if (parent && ["import_specifier", "export_specifier"].includes(String(parent.kind()))) {
		if (parent.field("alias") && at(parent.field("name"), node)) return [];
		const statement = parent.parent()?.parent();
		if (parent.kind() === "export_specifier" && statement?.kind() === "export_statement" && statement.field("source"))
			return [];
		return BOTH;
	}
	return kind === "type_identifier" ? ["type"] : ["value"];
}

/**
 * Refuses a rename whose new name something already declares in a scope around one of the renamed places, which
 * would either collide with it or, silently, make those places refer to the other declaration. Types and values
 * are apart: a type named like a value doesn't capture it.
 */
function refuseCapturedRename(edit: WorkspaceEdit | null, symbol: string, to: string, renamingProperty: boolean): void {
	const locations = [
		...Object.entries(edit?.changes ?? {}).map(([uri, edits]) => ({ uri, edits })),
		...(edit?.documentChanges ?? []).flatMap((change) =>
			"kind" in change ? [] : [{ uri: change.textDocument.uri, edits: change.edits }],
		),
	];
	const kinds = [
		"identifier",
		"type_identifier",
		"shorthand_property_identifier",
		"shorthand_property_identifier_pattern",
		"property_identifier",
		"private_property_identifier",
	];
	for (const { uri, edits } of locations) {
		const file = fileURLToPath(uri);
		const lang = scriptLanguage(file);
		if (!lang) continue;
		const source = readFileSync(file, "utf8");
		const byOffset = new Map(
			parse(lang, source)
				.root()
				.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })
				.map((node) => [node.range().start.index, node]),
		);
		for (const { range } of edits) {
			const offset = offsetOf(source, range.start);
			const node = byOffset.get(offset);
			const spaces = node ? capturable(node, renamingProperty) : [];
			if (!spaces.length) continue;
			for (let scope = node!.parent(); scope; scope = scope.parent()) {
				if (!SCOPES.has(String(scope.kind())) || !scopeDeclares(scope, to, spaces)) continue;
				const line = source.slice(0, offset).split("\n").length;
				throw new Error(
					`refactor.rename: ${to} is already declared where ${JSON.stringify(symbol)} is used, at ${relative(process.cwd(), file)}:${line}, so renaming it there would change what it refers to. Pick another name, or rename that ${to} first.`,
				);
			}
		}
	}
}

const MEMBER_LISTS = new Set(["interface_body", "object_type", "class_body", "object", "enum_body"]);

/** Refuses renaming a member to the name of another member of the same interface, class, type or object. */
function refuseMemberCollision(file: string, position: Position, symbol: string, to: string): void {
	const lang = scriptLanguage(file);
	if (!lang) return;
	const source = readFileSync(file, "utf8");
	const offset = offsetOf(source, position);
	const root = parse(lang, source).root();
	const declared = root
		.findAll({
			rule: {
				any: ["property_identifier", "private_property_identifier", "required_parameter", "optional_parameter"].map(
					(kind) => ({ kind }),
				),
			},
		})
		.find((node) => node.range().start.index === offset);
	let list = declared?.parent() ?? null;
	while (list && !MEMBER_LISTS.has(String(list.kind()))) list = list.parent();
	if (!list) return;
	const names = list
		.children()
		.flatMap((member) => [member.field("name"), member.field("key"), member.field("property")])
		.filter((name): name is SgNode => name !== null)
		.map((name) => name.text());
	if (names.includes(to))
		throw new Error(
			`refactor.rename: ${JSON.stringify(symbol)} would become a second member named ${to}; pick another name, or rename that ${to} first.`,
		);
}

/** Whether the name at `position` is a shorthand in a destructuring declaration, `const { auth } = …`. */
function declaresShorthandBinding(file: string, position: Position): boolean {
	const lang = scriptLanguage(file);
	if (!lang) return false;
	const source = readFileSync(file, "utf8");
	const offset = offsetOf(source, position);
	return parse(lang, source)
		.root()
		.findAll({ rule: { kind: "shorthand_property_identifier_pattern" } })
		.some((node) => node.range().start.index === offset);
}

/** Leaves out the edits that land on property names: a member access, a key, or a type's member. */
function dropPropertyEdits(edit: WorkspaceEdit | null): void {
	const kept = (uri: string, edits: TextEdit[]) => {
		const file = fileURLToPath(uri);
		const lang = scriptLanguage(file);
		if (!lang) return edits;
		const source = readFileSync(file, "utf8");
		const properties = new Set(
			parse(lang, source)
				.root()
				.findAll({ rule: { any: [{ kind: "property_identifier" }, { kind: "private_property_identifier" }] } })
				.map((node) => node.range().start.index),
		);
		return edits.filter(({ range }) => !properties.has(offsetOf(source, range.start)));
	};
	for (const [uri, edits] of Object.entries(edit?.changes ?? {})) edit!.changes![uri] = kept(uri, edits);
	for (const change of edit?.documentChanges ?? [])
		if (!("kind" in change)) change.edits = kept(change.textDocument.uri, change.edits);
}

/** A constructor parameter that also declares a property: `public name: string`, `readonly id: number`. */
function parameterProperty(node: SgNode | null): boolean {
	return (
		node !== null &&
		["required_parameter", "optional_parameter"].includes(String(node.kind())) &&
		node.children().some((child) => ["accessibility_modifier", "readonly"].includes(String(child.kind())))
	);
}

/**
 * Whether the name at `position` declares a property (an interface or class member, say) rather than a value.
 * A constructor parameter with an accessibility modifier or `readonly`, `constructor(public name: string)`,
 * declares both, and is renamed as the property.
 */
function declaresProperty(file: string, position: Position): boolean {
	const lang = scriptLanguage(file);
	if (!lang) return false;
	const source = readFileSync(file, "utf8");
	const offset = offsetOf(source, position);
	const kinds = [
		"property_identifier",
		"private_property_identifier",
		"identifier",
		"required_parameter",
		"optional_parameter",
	];
	return parse(lang, source)
		.root()
		.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })
		.some((node) => {
			if (node.range().start.index !== offset) return false;
			const kind = String(node.kind());
			if (kind === "property_identifier" || kind === "private_property_identifier") return true;
			// The server gives a parameter property's position as the start of the parameter, at its modifier.
			return parameterProperty(kind === "identifier" ? node.parent() : node);
		});
}

function offsetOf(source: string, position: Position): number {
	const lines = source.split("\n");
	// TypeScript counts characters after a byte order mark; the source and ast-grep's offsets include it.
	const bom = source.startsWith("\uFEFF") && position.line === 0 ? 1 : 0;
	return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character + bom;
}

/**
 * Refuses a rename that a barrel would turn into a different symbol: one that re-exports the renamed declaration's
 * file (`export * from "./date"`) and already exports the new name, itself or through its other `export *` modules,
 * would make its importers of the new name ambiguous, or silently resolve them to the other one.
 */
function refuseBarrelCollision(root: string, file: string, symbol: string, to: string): void {
	const source = readFileSync(file, "utf8");
	const name = symbol.split(".").at(-1)!;
	if (symbol.includes(".") || !exportsName(source, name)) return;
	const real = realpathSync(file);
	const reexport = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["'](\.{1,2}\/[^"']*)["']/g;
	for (const barrel of scriptFiles(root)) {
		if (barrel === file) continue;
		const text = readFileSync(barrel, "utf8");
		const modules = [...text.matchAll(reexport)].map((match) => ({
			star: match[0].includes("*"),
			path: resolveModule(barrel, match[1]!),
		}));
		if (!modules.some((module) => module.path === real)) continue;
		// The barrel's own exports, without the re-export of the renamed file, which it would follow.
		const own = text.replace(reexport, (whole, specifier: string) =>
			resolveModule(barrel, specifier) === real ? "" : whole,
		);
		const other = modules.find(
			(module) =>
				module.star && module.path && module.path !== real && exportsName(readFileSync(module.path, "utf8"), to),
		);
		if (exportsName(own, to) || other)
			throw new Error(
				`refactor.rename: ${relative(root, barrel)} re-exports ${relative(root, file)} and already exports ${to}${other ? ` from ${relative(root, other.path!)}` : ""}, so its importers of ${to} would change meaning. Pick another name.`,
			);
	}
}

/** Git-visible JS and TS files. */
function scriptFiles(root: string): string[] {
	const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		encoding: "utf8",
	});
	if (listed.status !== 0) return [];
	return listed.stdout
		.split("\0")
		.filter((path) => /\.[cm]?[jt]sx?$/.test(path))
		.map((path) => resolve(root, path))
		.filter((path) => existsSync(path));
}

/** Git-visible scripts with a relative import, export, require or import() of `target`. */
function relativeImporters(root: string, target: string): string[] {
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
			const text = readFileSync(file, "utf8");
			return [...text.matchAll(specifier)].some((match) => resolveModule(file, match[1]!) === real);
		});
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
		// The server can return no edits at all, as when a file augments this one with `declare module`. Check its
		// answer against the files that import this one by a relative path, rather than leave them broken.
		const missed = relativeImporters(root, from).filter((file) => !changes.has(file));
		if (missed.length)
			throw new Error(
				`refactor.renameFile: TypeScript didn't update the import of ${JSON.stringify(options.from)} in ${missed.map((file) => JSON.stringify(relative(root, file))).join(", ")}, so nothing was renamed. A \`declare module\` augmentation of the file can cause this; update those imports with sg.rewrite and move the file with Bun.`,
			);
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
