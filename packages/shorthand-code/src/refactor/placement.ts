/** Syntax placement for file-backed JS/TS matches. All offsets refer to one source snapshot. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { editingFiles } from "../program/file-outcomes.ts";
import { analyzeMove, type MoveAnalysis } from "./move-analysis.ts";
import { declaredNames, planImports, topLevelDeclaration } from "./move-imports.ts";

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
	const source = existed ? readFileSync(filename, "utf8") : "";
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
	if (!sources.has(saved.file))
		sources.set(saved.file, existsSync(saved.file) ? readFileSync(saved.file, "utf8") : null);
	const source = sources.get(saved.file);
	if ((source !== null) !== saved.existed || (saved.existed && source !== saved.source)) {
		throw new Error(`Stale match in ${match.file}; ${staleAdvice}`);
	}
	return saved;
}

function snapshot(match: Match): Snapshot {
	const saved = getMatchSnapshot(match);
	if (!languages[saved.file.split(".").pop()!]) throw new Error("Placement currently supports JS/TS only");
	return saved;
}

function container(node: SgNode): boolean {
	return node.kind() === "program" || node.kind() === "statement_block";
}

function statement(node: SgNode) {
	const parent = node.parent();
	if (
		!parent ||
		!container(parent) ||
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

/**
 * Where a statement's doc comment starts, so it moves and goes with the statement rather than ending up on the
 * next one. That's the nearest JSDoc-style block comment above it, with any comments in between, when each starts its own line
 * and no blank line separates them. Other comments stay where they are.
 */
function leadingCommentsStart(node: SgNode, source: string): number {
	let start = node.range().start.index;
	let docStart: number | undefined;
	for (let previous = node.prev(); previous?.kind() === "comment"; previous = previous.prev()) {
		const { start: from, end: to } = previous.range();
		const ownLine = !source.slice(source.lastIndexOf("\n", from.index - 1) + 1, from.index).trim();
		if (!ownLine || !/^[\t ]*(\r?\n)?[\t ]*$/.test(source.slice(to.index, start))) break;
		start = from.index;
		if (previous.text().startsWith("/**")) {
			docStart = start;
			break;
		}
	}
	return docStart ?? node.range().start.index;
}

/** Removes a statement with its doc comment, and the line break after it when it has whole lines to itself. */
function removal(saved: Snapshot): Edit {
	statement(saved.node);
	const { end } = saved.node.range();
	const { source } = saved;
	const start = leadingCommentsStart(saved.node, source);
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
		offset = key === "before" ? start.index : end.index;
	} else {
		if (!container(node))
			throw new Error("startOf/endOf requires a file root or statement block; select the body explicitly");
		const children = node.children().filter((child) => child.isNamed());
		if (node.kind() === "program") {
			// A shebang must remain the first line of a file.
			const first = children[0];
			const shebangEnd = first?.kind() === "hash_bang_line" ? source.indexOf("\n", first.range().end.index) : -1;
			offset =
				key === "startOf"
					? first?.kind() === "hash_bang_line"
						? shebangEnd < 0
							? source.length
							: shebangEnd + 1
						: 0
					: source.length;
			indent = "";
		} else {
			offset = key === "startOf" ? start.index + 1 : end.index - 1;
			const first = children[0];
			indent =
				first && first.range().start.line > start.line ? indentAt(source, first.range().start.index) : `${indent}\t`;
		}
	}
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	// Never reindent interior lines: whitespace inside template literals can be significant.
	const prefix = source.slice(0, offset);
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
		if (container(node)) containers.set(nodeKey(node), node);
		pending.push(...node.children());
	}
	const parents = new Map(edits.map((edit) => [nodeKey(edit.parent), edit.parent]));
	for (const [parentKey, parent] of parents) {
		const parentRange = parent.range();
		const next =
			parent.kind() === "program"
				? root
				: containers.get(
						`${parent.kind()}:${mapped(parentRange.start.index, "start")}:${mapped(parentRange.end.index, "end")}`,
					);
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
		if (hasSyntaxError(root)) {
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
	const source = readFileSync(from, "utf8");
	const node = topLevelDeclaration(parse(lang, source).root(), symbol, from);
	const analysis = await analyzeMove({
		root: files.root,
		file: from,
		node,
		names: declaredNames(node),
		files: files.scripts(),
	});
	const match = remember({ file: from, text: node.text(), node }, source);
	return editingFiles([from, to], () => moveNodes(match, { endOf: file(to) }, undefined, { ...files, analysis }));
}

function moveNodes(
	match: Match,
	destination: Destination,
	transform?: (text: string) => string,
	files?: MoveFiles & { analysis: MoveAnalysis },
): void {
	const source = snapshot(match);
	const deletion = removal(source);
	// A doc comment travels with the declaration; a transform sees only the declaration itself.
	const comments = source.source.slice(
		leadingCommentsStart(source.node, source.source),
		source.node.range().start.index,
	);
	const declaration = transform ? transform(source.node.text()) : source.node.text();
	// A transform's result is checked as it is: joining a non-string to the comment would hide what it returned.
	const text = comments && typeof declaration === "string" ? comments + declaration : declaration;
	const target = placement(text, destination);
	// A transform is arbitrary user code: recheck both snapshots before any writes.
	snapshot(match);
	snapshot(target.match);
	if (source.file === target.saved.file) {
		const range = target.saved.node.range();
		const overlaps =
			target.key === "before" || target.key === "after"
				? deletion.start < range.end.index && range.start.index < deletion.end
				: target.edit.start > deletion.start && target.edit.start < deletion.end;
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
		if (plan?.exportMoved) placed.text = placed.text.replace(text, `${comments}export ${declaration}`);
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
