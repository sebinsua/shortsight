/** Syntax placement for file-backed JS/TS matches. All offsets refer to one source snapshot. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { editingFiles } from "../program/file-outcomes.ts";
import { analyzeMove, type MoveAnalysis } from "./move-analysis.ts";
import { declaredNames, planImports, repointRelativePaths, topLevelDeclaration } from "./move-imports.ts";

export interface Match {
	file: string;
	text: string;
	node: SgNode;
}

const fileTarget = Symbol("shorthand.file");
export interface FileTarget extends Match {
	readonly [fileTarget]: true;
}

export function isFileTarget(value: unknown): value is FileTarget {
	return typeof value === "object" && value !== null && fileTarget in value && snapshots.has(value as unknown as Match);
}

export type Destination =
	| { before: Match; after?: never; startOf?: never; endOf?: never }
	| { after: Match; before?: never; startOf?: never; endOf?: never }
	| { startOf: Match; before?: never; after?: never; endOf?: never }
	| { endOf: Match; before?: never; after?: never; startOf?: never };

interface Snapshot {
	file: string;
	displayFile: string;
	source: string;
	existed: boolean;
	node: SgNode;
}

const snapshots = new WeakMap<Match, Snapshot>();
const languages: Record<string, Lang> = {
	ts: Lang.TypeScript,
	mts: Lang.TypeScript,
	cts: Lang.TypeScript,
	tsx: Lang.Tsx,
	jsx: Lang.Tsx,
	js: Lang.JavaScript,
	mjs: Lang.JavaScript,
	cjs: Lang.JavaScript,
};

/** The ast-grep language for a JS/TS filename, by extension. */
// ignoreBOM keeps a byte order mark in the text, as readFileSync does, rather than dropping it.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Thrown for a file that isn't valid UTF-8: decoding and writing it back would replace those bytes. */
export class NotUtf8Error extends Error {}

/** A file's text, refusing files that aren't UTF-8, such as Latin-1 sources, so they aren't corrupted. */
export function readUtf8(path: string): string {
	try {
		return utf8.decode(readFileSync(path));
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		throw new NotUtf8Error(
			`${JSON.stringify(path)} isn't valid UTF-8, and editing it here would corrupt it; change it another way`,
		);
	}
}

/** A script's text with its comments blanked out (same offsets), so a commented-out import isn't read as one. */
export function withoutComments(path: string, text: string): string {
	const lang = scriptLanguage(path);
	if (!lang) return text;
	let output = text;
	for (const comment of parse(lang, text)
		.root()
		.findAll({ rule: { kind: "comment" } })) {
		const { start, end } = comment.range();
		output =
			output.slice(0, start.index) +
			text.slice(start.index, end.index).replace(/[^\n]/g, " ") +
			output.slice(end.index);
	}
	return output;
}

export function scriptLanguage(filename: string): Lang | undefined {
	return languages[filename.split(".").pop()!];
}

export function remember<T extends Match>(match: T, source: string, existed = true, sourceFile = match.file): T {
	const filename = existed ? realpathSync(sourceFile) : resolve(sourceFile);
	snapshots.set(match, { file: filename, displayFile: match.file, source, existed, node: match.node });
	return match;
}

/** A file root, including a not-yet-created file. Merely selecting it performs no writes. */
export function file(filename: string): FileTarget {
	const lang = scriptLanguage(filename);
	if (!lang) throw new Error("sg.file requires a JS/TS filename");
	const existed = existsSync(filename);
	const source = existed ? readUtf8(filename) : "";
	return remember(
		{ file: filename, text: source, node: parse(lang, source).root(), [fileTarget]: true as const },
		source,
		existed,
	);
}

export function getMatchSnapshot(
	match: Match,
	sources = new Map<string, string | null>(),
	staleAdvice = "match the file again after editing it",
): Snapshot {
	const saved = snapshots.get(match);
	if (!saved) throw new Error("Expected a file-backed match from sg.find, sg.one, or sg.file");
	if (match.node !== saved.node || match.file !== saved.displayFile)
		throw new Error("File-backed match identity was changed; select it again");
	if (!sources.has(saved.file)) sources.set(saved.file, existsSync(saved.file) ? readUtf8(saved.file) : null);
	const source = sources.get(saved.file);
	if ((source !== null) !== saved.existed || (saved.existed && source !== saved.source)) {
		throw new Error(`Stale match in ${match.file}; ${staleAdvice}`);
	}
	return saved;
}

function snapshot(match: Match): Snapshot {
	const saved = getMatchSnapshot(match);
	if (!languages[saved.file.split(".").pop()!]) throw new Error("Placement currently supports JS/TS only");
	return { ...saved, node: wholeStatement(saved.node) };
}

/**
 * An expression that is all of its statement stands for that statement: without semicolons, `save(a)` matches the
 * call, and a pattern `save(a);` matches nothing, so placement would otherwise have no way to select it. Likewise a
 * declaration stands for the `export` statement around it.
 */
function wholeStatement(node: SgNode): SgNode {
	const parent = node.parent();
	// `function obsolete() {}` matches inside `export function obsolete() {}`: the statement is the export.
	if (parent?.kind() === "export_statement" && parent.field("declaration") && at(parent.field("declaration")!, node))
		return parent;
	if (parent?.kind() !== "expression_statement" || !holdsStatements(parent.parent() ?? parent)) return node;
	const named = parent.namedChildren().filter((child) => child.kind() !== "comment");
	return named.length === 1 && at(named[0]!, node) ? parent : node;
}

const at = (a: SgNode, b: SgNode) =>
	a.range().start.index === b.range().start.index && a.range().end.index === b.range().end.index;

function container(node: SgNode): boolean {
	return node.kind() === "program" || node.kind() === "statement_block";
}

/** What holds statements: a container, or a `case`/`default` clause, which has no braces to place inside. */
function holdsStatements(node: SgNode): boolean {
	return container(node) || node.kind() === "switch_case" || node.kind() === "switch_default";
}

function statement(node: SgNode) {
	const parent = node.parent();
	if (
		!parent ||
		!holdsStatements(parent) ||
		node.kind() === "comment" ||
		node.kind() === "hash_bang_line" ||
		!node.isNamed()
	) {
		throw new Error("Select a whole statement or declaration in a file root or statement block");
	}
}

function indentAt(source: string, offset: number): string {
	return source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset).match(/^[\t ]*/)?.[0] ?? "";
}

interface Edit {
	parent: SgNode;
	start: number;
	end: number;
	text: string;
}

/** Directives about the next line only: `ignore start`, `ignore file` and the like apply to a region or file. */
const DIRECTIVE =
	/^\/[/*]\s*(?:@ts-(?:expect-error|ignore)\b|(?:eslint|oxlint)-disable-next-line\b|prettier-ignore\b|biome-ignore\b|deno-lint-ignore(?!-file)\b|(?:istanbul|c8|v8) ignore (?:next|if|else)\b)/;

/** Comments that act on the whole file, so must stay at its top: TypeScript, Flow and JSX pragmas, file-wide lint. */
export const PRAGMA =
	/^\/[/*]\s*(?:@ts-nocheck|@ts-check|@flow|@jsx|@jsxImportSource|@jsxRuntime|eslint-disable(?!-next-line)|biome-ignore-all|prettier-ignore-file)\b/;

/** A file's header comment, such as a licence, which belongs to the file rather than to its first statement. */
export const HEADER = /@license|@preserve|@copyright|@file(?:overview)?\b|SPDX-License-Identifier|\bCopyright\b/i;

/** Statements a doc comment describes: declarations, exported or not. */
const DOCUMENTED = new Set([
	"export_statement",
	"function_declaration",
	"generator_function_declaration",
	"class_declaration",
	"abstract_class_declaration",
	"lexical_declaration",
	"variable_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"internal_module",
	"module",
	"ambient_declaration",
]);

/**
 * Where the comments that belong to a statement start, so they go with it rather than ending up on the next one.
 * Each must start its own line with no blank line before what follows. When `all`, as for a move, that's every
 * such comment; otherwise directives about the next line and up to the nearest JSDoc-style block comment, with
 * any comments in between, and other comments stay where they are.
 */
function leadingCommentsStart(node: SgNode, source: string, all = false): number {
	let start = node.range().start.index;
	let belongs: number | undefined;
	for (let previous = node.prev(); previous?.kind() === "comment"; previous = previous.prev()) {
		const { start: from, end: to } = previous.range();
		const ownLine = !source.slice(source.lastIndexOf("\n", from.index - 1) + 1, from.index).trim();
		if (!ownLine || !/^[\t ]*(\r?\n)?[\t ]*$/.test(source.slice(to.index, start))) break;
		// The file's header, such as a licence, stays with the file, as does everything above it.
		if (HEADER.test(previous.text())) break;
		start = from.index;
		// A directive about the next line, such as `// @ts-expect-error`, would apply to another statement if left.
		if (all || DIRECTIVE.test(previous.text())) belongs = start;
		else if (previous.text().startsWith("/**")) {
			if (DOCUMENTED.has(String(node.kind()))) belongs = start;
			break;
		}
	}
	return belongs ?? node.range().start.index;
}

/** Where a statement ends, including a comment that follows it on the same line: `const a = 1; // the answer`. */
function trailingCommentEnd(node: SgNode, source: string): number {
	const end = node.range().end.index;
	const next = node.next();
	if (next?.kind() !== "comment") return end;
	const between = source.slice(end, next.range().start.index);
	return /^[\t ]*$/.test(between) && !next.text().includes("\n") ? next.range().end.index : end;
}

/**
 * Removes a statement with its doc comment (or, when `allComments`, every comment directly above it and any
 * comment after it on its last line), and the line break after it
 * when it has whole lines to itself.
 */
function removal(saved: Snapshot, allComments = false): Edit {
	statement(saved.node);
	const { source } = saved;
	const end = { index: allComments ? trailingCommentEnd(saved.node, source) : saved.node.range().end.index };
	const start = leadingCommentsStart(saved.node, source, allComments);
	const lineStart = source.lastIndexOf("\n", start - 1) + 1;
	const newline = source.startsWith("\r\n", end.index) ? 2 : source.startsWith("\n", end.index) ? 1 : 0;
	const wholeLines = !source.slice(lineStart, start).trim() && newline > 0;
	return wholeLines
		? { parent: saved.node.parent()!, start: lineStart, end: end.index + newline, text: "" }
		: { parent: saved.node.parent()!, start, end: end.index, text: "" };
}

function placement(text: string, destination: Destination) {
	if (typeof text !== "string" || !text.trim()) throw new Error("Insertion text must be a non-empty string");
	const keys = Object.keys(destination);
	if (keys.length !== 1 || !["before", "after", "startOf", "endOf"].includes(keys[0])) {
		throw new Error("Destination must contain exactly one of before, after, startOf, endOf");
	}
	const key = keys[0] as keyof Destination;
	const match = destination[key]!;
	const saved = snapshot(match);
	const { node, source } = saved;
	const { start, end } = node.range();
	let offset: number;
	let indent = indentAt(source, start.index);
	if (key === "before" || key === "after") {
		statement(node);
		// Around the statement's comments: before its doc comment, after a comment on its last line.
		offset = key === "before" ? leadingCommentsStart(node, source) : trailingCommentEnd(node, source);
		indent = indentAt(source, offset);
	} else {
		if (!container(node))
			throw new Error("startOf/endOf requires a file root or statement block; select the body explicitly");
		const children = node.children().filter((child) => child.isNamed());
		if (node.kind() === "program") {
			// A shebang must remain the first line of a file, and directives such as "use client" or "use strict"
			// must stay first after it, or they stop being directives.
			// Comments can come before a directive (`// Copyright` then `"use client"`), and pragmas such as
			// `// @ts-nocheck` or a licence header must stay at the top too.
			const prologue = [];
			for (const child of children) {
				const directive = child.kind() === "expression_statement" && child.namedChildren()[0]?.kind() === "string";
				const pragma = child.kind() === "comment" && (HEADER.test(child.text()) || PRAGMA.test(child.text()));
				if (child.kind() === "hash_bang_line" || directive || pragma) prologue.push(child);
				else if (child.kind() !== "comment") break;
			}
			const last = prologue.at(-1);
			const lineEnd = last ? source.indexOf("\n", last.range().end.index) : -1;
			// After a byte order mark, which must stay the file's first character.
			const fileStart = source.startsWith("\uFEFF") ? 1 : 0;
			offset = key === "startOf" ? (last ? (lineEnd < 0 ? source.length : lineEnd + 1) : fileStart) : source.length;
			indent = "";
		} else {
			// Inside the braces: a comment after the `}` (`} // end`) is parsed as part of the block.
			const closing = node.children().findLast((child) => child.kind() === "}");
			offset = key === "startOf" ? start.index + 1 : (closing?.range().start.index ?? end.index - 1);
			const first = children[0];
			indent =
				first && first.range().start.line > start.line ? indentAt(source, first.range().start.index) : `${indent}\t`;
		}
	}
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	// Never reindent interior lines: whitespace inside template literals can be significant.
	// A byte order mark isn't text on the line: placing right after it is placing at the start of the file.
	const prefix = source.slice(0, offset).replace(/^\uFEFF/, "");
	const suffix = source.slice(offset);
	const currentIndent = prefix.slice(prefix.lastIndexOf("\n") + 1);
	const leading =
		/^[\t ]*$/.test(currentIndent) && indent.startsWith(currentIndent)
			? indent.slice(currentIndent.length)
			: `${prefix.length ? newline : ""}${indent}`;
	const trailingIndent = key === "startOf" && node.kind() === "statement_block" ? indent : indentAt(source, offset);
	const trailing =
		suffix.startsWith("\n") || suffix.startsWith("\r\n") ? "" : `${newline}${suffix.length ? trailingIndent : ""}`;
	return {
		saved,
		match,
		key,
		edit: {
			parent: key === "before" || key === "after" ? node.parent()! : node,
			start: offset,
			end: offset,
			text: `${leading}${text.trim()}${trailing}`,
		},
	};
}

function nodeKey(node: SgNode): string {
	const { start, end } = node.range();
	return `${node.kind()}:${start.index}:${end.index}`;
}

/** Preserve surviving siblings and require inserted text to form complete children of its container. */
function validateBoundaries(saved: Snapshot, edits: Edit[], root: SgNode) {
	const fail = () => {
		throw new Error(`Placement would join or change statement boundaries in ${saved.file}; use explicit semicolons`);
	};
	// At an insertion, existing starts move right and existing ends stay left.
	const mapped = (offset: number, side: "start" | "end") =>
		offset +
		edits.reduce((delta, edit) => {
			const before =
				edit.start === edit.end
					? edit.start < offset || (edit.start === offset && side === "start")
					: edit.end <= offset;
			return delta + (before ? edit.text.length - (edit.end - edit.start) : 0);
		}, 0);
	const containers = new Map<string, SgNode>();
	const pending = [root];
	while (pending.length) {
		const node = pending.pop()!;
		if (holdsStatements(node)) containers.set(nodeKey(node), node);
		pending.push(...node.children());
	}
	const parents = new Map(edits.map((edit) => [nodeKey(edit.parent), edit.parent]));
	for (const [parentKey, parent] of parents) {
		const parentRange = parent.range();
		// A case clause has no closing brace: removing its last statement moves its end too, so find it by its start.
		const clause = parent.kind() === "switch_case" || parent.kind() === "switch_default";
		const parentStart = mapped(parentRange.start.index, "start");
		const next =
			parent.kind() === "program"
				? root
				: clause
					? [...containers.values()].find(
							(candidate) => candidate.kind() === parent.kind() && candidate.range().start.index === parentStart,
						)
					: containers.get(`${parent.kind()}:${parentStart}:${mapped(parentRange.end.index, "end")}`);
		if (!next) return fail();
		const remaining = new Map(next.namedChildren().map((node) => [nodeKey(node), node]));
		for (const child of parent.namedChildren()) {
			const { start, end } = child.range();
			if (edits.some((edit) => edit.start < edit.end && edit.start <= start.index && edit.end >= end.index)) continue;
			const childKey = `${child.kind()}:${mapped(start.index, "start")}:${mapped(end.index, "end")}`;
			const survivor = remaining.get(childKey);
			if (!survivor) return fail();
			const changedInside = edits.some((edit) => edit.start < end.index && edit.end > start.index);
			if (!changedInside && survivor.text() !== child.text()) return fail();
			remaining.delete(childKey);
		}
		for (const edit of edits.filter((candidate) => candidate.text && nodeKey(candidate.parent) === parentKey)) {
			// Insertions precede a deletion at the same position (moving the first statement to startOf).
			const insertionStart = mapped(edit.start, "end");
			const insertionEnd = insertionStart + edit.text.length;
			let cursor = insertionStart;
			for (const [childKey, child] of remaining) {
				const { start, end } = child.range();
				if (start.index < insertionStart || end.index > insertionEnd) continue;
				if (edit.text.slice(cursor - insertionStart, start.index - insertionStart).trim()) return fail();
				cursor = end.index;
				remaining.delete(childKey);
			}
			if (edit.text.slice(cursor - insertionStart).trim()) return fail();
		}
		if (remaining.size) return fail();
	}
}

function hasSyntaxError(node: SgNode): boolean {
	return syntaxErrorAt(node) !== undefined;
}

/** The first ERROR node, or node the parser had to invent (an empty one), in this tree. */
export function syntaxErrorAt(node: SgNode): SgNode | undefined {
	if (node.kind() === "ERROR") return node;
	for (const child of node.children()) {
		const { start, end } = child.range();
		const error = start.index === end.index ? child : syntaxErrorAt(child);
		if (error) return error;
	}
	return undefined;
}

function apply(plans: { saved: Snapshot; edits: Edit[] }[]) {
	const outputs = plans.map(({ saved, edits }) => {
		const ordered = edits.toSorted((a, b) => a.start - b.start || a.end - b.end);
		for (let index = 1; index < ordered.length; index++) {
			if (ordered[index].start < ordered[index - 1].end) {
				throw new Error(`Cannot apply overlapping edits in ${saved.file}`);
			}
		}
		let output = saved.source;
		for (const edit of edits.toSorted((a, b) => b.start - a.start || b.end - a.end)) {
			output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
		}
		const lang = languages[saved.file.split(".").pop()!];
		const root = parse(lang, output).root();
		// Only errors the placement introduces: the grammar can't parse some valid TypeScript (`export type * from`),
		// and a file that already has such a gap mustn't make every placement in it fail.
		if (hasSyntaxError(root) && !hasSyntaxError(parse(lang, saved.source).root())) {
			throw new Error(`Placement would produce invalid syntax in ${saved.file}`);
		}
		validateBoundaries(saved, edits, root);
		return { saved, output };
	});
	for (const { saved, output } of outputs) {
		mkdirSync(dirname(saved.file), { recursive: true });
		writeFileSync(saved.file, output);
	}
}

export function insert(text: string, destination: Destination): void {
	return editingFiles(destinationFiles(destination), () => insertNodes(text, destination));
}

function destinationFiles(destination: Destination): string[] {
	return Object.values(destination).flatMap((match) => (typeof match?.file === "string" ? [match.file] : []));
}

function insertNodes(text: string, destination: Destination): void {
	const { saved, edit } = placement(text, destination);
	apply([{ saved, edits: [edit] }]);
}

export function move(match: Match, destination: Destination, transform?: (text: string) => string): void {
	return editingFiles([match.file, ...destinationFiles(destination)], () => moveNodes(match, destination, transform));
}

/** What refactor.move needs from the repository besides the moved declaration. */
export interface MoveFiles {
	root: string;
	/** Every JS/TS file Git sees. */
	scripts: () => string[];
	/** Files that may load modules dynamically, with import() or require(). */
	loadingModules: () => string[];
	/** Files that may re-export a module wholesale, with `export *`. */
	reexportingAll: () => string[];
}

/**
 * Moves the top-level declaration of `symbol` in `from` to the end of `to`, updating imports: the target
 * imports what the declaration uses, the source imports it back if still needed, and files importing it
 * from the source import it from the target. TypeScript's checker decides what the declaration uses and who
 * refers to it.
 */
export async function moveDeclaration(from: string, symbol: string, to: string, files: MoveFiles): Promise<void> {
	const lang = scriptLanguage(from);
	if (!lang || !scriptLanguage(to)) throw new Error("refactor.move requires JS/TS files");
	const source = readUtf8(from);
	const node = topLevelDeclaration(parse(lang, source).root(), symbol, from);
	const analysis = await analyzeMove({
		root: files.root,
		file: from,
		node,
		names: declaredNames(node),
		files: files.scripts(),
	});
	const match = remember({ file: from, text: node.text(), node }, source);
	return editingFiles([from, to], () =>
		moveNodes(
			match,
			destinationIn(to, declaredNames(node), analysis.dependencies),
			(text) => repointRelativePaths(text, from, to),
			{
				...files,
				analysis,
			},
		),
	);
}

const FUNCTION_BODIES = new Set([
	"function_declaration",
	"function_expression",
	"arrow_function",
	"method_definition",
	"generator_function_declaration",
	"generator_function",
]);

/**
 * Where a moved declaration goes in `to`. Code that runs while the module loads (`export const doubled = LIMIT * 2`,
 * `class Child extends Base`, `{ LIMIT }`) needs it declared first, and it needs the target's declarations it uses
 * declared before it. So it goes before the first statement that uses it, unless that is before the last declaration
 * it depends on and only uses it inside a function, when it goes after that; otherwise at the end.
 */
function destinationIn(to: string, names: string[], dependencies: Set<string>): Destination {
	const lang = scriptLanguage(to);
	if (!lang || !existsSync(to)) return { endOf: file(to) };
	const source = readUtf8(to);
	const wanted = new Set(names);
	const statements = parse(lang, source)
		.root()
		.children()
		.filter(
			(candidate) =>
				candidate.isNamed() &&
				!["import_statement", "comment", "hash_bang_line"].includes(String(candidate.kind())) &&
				!(candidate.kind() === "export_statement" && candidate.field("source")),
		);
	const uses = (candidate: SgNode) =>
		candidate
			.findAll({
				rule: { any: ["identifier", "type_identifier", "shorthand_property_identifier"].map((kind) => ({ kind })) },
			})
			.filter((node) => wanted.has(node.text()));
	const firstUse = statements.findIndex((candidate) => uses(candidate).length > 0);
	const lastDependency = statements.findLastIndex((candidate) =>
		declaredNames(candidate).some((name) => dependencies.has(name)),
	);
	const place = (index: number, key: "before" | "after"): Destination => {
		const chosen = statements[index]!;
		const target = remember({ file: to, text: chosen.text(), node: chosen }, source);
		return key === "before" ? { before: target } : { after: target };
	};
	if (firstUse < 0) return lastDependency < 0 ? { endOf: file(to) } : place(lastDependency, "after");
	if (firstUse > lastDependency) return place(firstUse, "before");
	const loading = uses(statements[firstUse]!).some((node) => {
		for (let parent = node.parent(); parent; parent = parent.parent())
			if (FUNCTION_BODIES.has(String(parent.kind()))) return false;
		return true;
	});
	if (loading)
		throw new Error(
			`refactor.move: ${names.join(", ")} would have to come before ${statements[firstUse]!.text().split("\n")[0]} in ${relative(process.cwd(), to)}, which uses it as the file loads, and after a declaration there it depends on`,
		);
	return place(lastDependency, "after");
}

function moveNodes(
	match: Match,
	destination: Destination,
	transform?: (text: string) => string,
	files?: MoveFiles & { analysis: MoveAnalysis },
): void {
	const source = snapshot(match);
	// Comments directly above travel with the declaration; a transform sees only the declaration itself.
	const deletion = removal(source, true);
	const comments = source.source.slice(
		leadingCommentsStart(source.node, source.source, true),
		source.node.range().start.index,
	);
	const trailing = source.source.slice(source.node.range().end.index, trailingCommentEnd(source.node, source.source));
	const declaration = transform ? transform(source.node.text()) : source.node.text();
	// A transform's result is checked as it is: joining a non-string to the comments would hide what it returned.
	const text =
		(comments || trailing) && typeof declaration === "string" ? comments + declaration + trailing : declaration;
	const target = placement(text, destination);
	// A transform is arbitrary user code: recheck both snapshots before any writes.
	snapshot(match);
	snapshot(target.match);
	if (source.file === target.saved.file) {
		const range = target.saved.node.range();
		// Overlapping when the code goes inside what it's moved out of, or next to something inside it (or itself).
		// A nested statement can still move out, before or after what contains it.
		const overlaps =
			(target.edit.start > deletion.start && target.edit.start < deletion.end) ||
			(target.key !== "startOf" &&
				target.key !== "endOf" &&
				range.start.index >= deletion.start &&
				range.end.index <= deletion.end);
		if (overlaps) {
			throw new Error("Cannot move overlapping source and destination nodes");
		}
		apply([{ saved: source, edits: [deletion, target.edit] }]);
	} else {
		const sourceRoot = source.node.getRoot().root();
		const targetRoot = target.saved.node.getRoot().root();
		const plan =
			files && source.node.parent()?.kind() === "program" && target.edit.parent.kind() === "program"
				? planImports({
						sourceFile: source.file,
						node: source.node,
						targetFile: target.saved.file,
						targetRoot,
						analysis: files.analysis,
						filesLoadingModules: files.loadingModules,
						filesReexportingAll: files.reexportingAll,
					})
				: null;
		const placed = { ...target.edit };
		// The source still uses a declaration it did not export, so the target now has to export it.
		if (plan?.exportMoved) placed.text = placed.text.replace(text, () => `${comments}export ${declaration}${trailing}`);
		const targetEdits: Edit[] = [];
		for (const edit of plan?.target ?? []) {
			// Edits at the declaration's insertion point are combined with it: imports inserted there come
			// first, and a rewritten statement starting there follows it.
			if (placed.start === placed.end && edit.start === placed.start) {
				placed.text = edit.start === edit.end ? edit.text + placed.text : placed.text + edit.text;
				placed.end = edit.end;
			} else targetEdits.push({ ...edit, parent: targetRoot });
		}
		const importers = plan?.importers ?? [];
		editingFiles(
			importers.map((importer) => importer.file),
			() =>
				apply([
					{
						saved: source,
						edits: [deletion, ...(plan?.source ?? []).map((edit) => ({ ...edit, parent: sourceRoot }))],
					},
					{ saved: target.saved, edits: [placed, ...targetEdits] },
					...importers.map((importer) => ({
						saved: {
							file: importer.file,
							displayFile: importer.file,
							source: importer.source,
							existed: true,
							node: importer.root,
						},
						edits: importer.edits.map((edit) => ({ ...edit, parent: importer.root })),
					})),
				]),
		);
	}
}

export function remove(matches: Match | readonly Match[]): void {
	const selected = Array.isArray(matches) ? matches : [matches as Match];
	return editingFiles(
		selected.map((match) => match.file),
		() => removeNodes(matches),
	);
}

function removeNodes(matches: Match | readonly Match[]): void {
	const plans = new Map<string, { saved: Snapshot; edits: Edit[] }>();
	for (const match of Array.isArray(matches) ? matches : [matches as Match]) {
		const saved = snapshot(match);
		const plan = plans.get(saved.file) ?? { saved, edits: [] };
		plan.edits.push(removal(saved));
		plans.set(saved.file, plan);
	}
	apply([...plans.values()]);
}
