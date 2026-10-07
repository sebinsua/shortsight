import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface TextEdit {
	range: Range;
	newText: string;
}

export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: Array<{ textDocument: { uri: string }; edits: TextEdit[] } | { kind: string }>;
}

export function existingProjectFile(root: string, file: string): string {
	const absolute = projectPath(root, file);
	if (!statSync(absolute).isFile()) throw new Error(`not a file: ${JSON.stringify(file)}`);
	return absolute;
}

/** Resolve an existing or future path without allowing symlink escapes from the repository. */
export function projectPath(root: string, file: string): string {
	const repository = realpathSync(root);
	let ancestor = resolve(repository, file);
	const missing: string[] = [];
	while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
		const parent = dirname(ancestor);
		if (parent === ancestor) throw new Error(`cannot resolve path: ${JSON.stringify(file)}`);
		missing.unshift(basename(ancestor));
		ancestor = parent;
	}
	const absolute = resolve(realpathSync(ancestor), ...missing);
	const local = relative(repository, absolute);
	if (local === ".." || local.startsWith("../") || isAbsolute(local))
		throw new Error(`path is outside the repository: ${JSON.stringify(file)}`);
	return absolute;
}

/** Replacement text for one edit, given its file, source and UTF-16 offsets. */
export type AdjustEdit = (file: string, source: string, start: number, end: number, text: string) => string;

/** Validate every edit and construct all new contents before any file is written. */
export function planWorkspaceEdit(root: string, edit: WorkspaceEdit | null, adjust?: AdjustEdit): Map<string, string> {
	const byUri = new Map<string, TextEdit[]>();
	for (const [uri, edits] of Object.entries(edit?.changes ?? {})) append(byUri, uri, edits);
	for (const change of edit?.documentChanges ?? []) {
		if ("kind" in change) throw new Error(`TypeScript returned an unsupported ${change.kind} operation`);
		append(byUri, change.textDocument.uri, change.edits);
	}

	return new Map(
		[...byUri].map(([uri, edits]) => {
			const url = new URL(uri);
			if (url.protocol !== "file:")
				throw new Error(`TypeScript returned an edit for unsupported URI ${JSON.stringify(uri)}`);
			const file = existingProjectFile(root, fileURLToPath(url));
			const source = readFileSync(file, "utf8");
			return [file, applyTextEdits(source, edits, file, adjust)];
		}),
	);
}

function append(byUri: Map<string, TextEdit[]>, uri: string, edits: TextEdit[]): void {
	byUri.set(uri, [...(byUri.get(uri) ?? []), ...edits]);
}

function applyTextEdits(source: string, edits: TextEdit[], file: string, adjust?: AdjustEdit): string {
	const ranges = edits
		.map((edit) => {
			const start = offsetAt(source, edit.range.start, file);
			const end = offsetAt(source, edit.range.end, file);
			return { start, end, text: adjust ? adjust(file, source, start, end, edit.newText) : edit.newText };
		})
		.toSorted((a, b) => b.start - a.start || b.end - a.end);
	for (const range of ranges)
		if (range.end < range.start) throw new Error(`TypeScript returned a reversed edit for ${JSON.stringify(file)}`);
	for (let index = 1; index < ranges.length; index++)
		if (ranges[index].end > ranges[index - 1].start || ranges[index].start === ranges[index - 1].start)
			throw new Error(`TypeScript returned overlapping edits for ${JSON.stringify(file)}`);
	let output = source;
	for (const edit of ranges) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	return output;
}

function offsetAt(source: string, position: Position, file: string): number {
	if (
		!Number.isSafeInteger(position.line) ||
		!Number.isSafeInteger(position.character) ||
		position.line < 0 ||
		position.character < 0
	)
		throw new Error(`TypeScript returned an invalid edit position for ${JSON.stringify(file)}`);
	let offset = 0;
	for (let line = 0; line < position.line; line++) {
		const newline = source.indexOf("\n", offset);
		if (newline < 0) throw new Error(`TypeScript returned an edit past the end of ${JSON.stringify(file)}`);
		offset = newline + 1;
	}
	const newline = source.indexOf("\n", offset);
	const lineEnd = newline < 0 ? source.length : source[newline - 1] === "\r" ? newline - 1 : newline;
	if (offset + position.character > lineEnd)
		throw new Error(`TypeScript returned an edit past the end of a line in ${JSON.stringify(file)}`);
	return offset + position.character;
}
