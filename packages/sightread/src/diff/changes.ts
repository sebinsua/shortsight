// Match changed source lines to the smallest syntax declarations in both versions.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphNode } from "../model.ts";
import { graphKind } from "../naming.ts";
import { handleFor, indexedDeclarations, type Declaration, type DeclarationParser } from "../ranges.ts";
import type { GitChanges, GitFile } from "./git.ts";
import { isTypeScript } from "./git.ts";

export interface ChangedSymbol {
	node: GraphNode & {
		status: "edited" | "added" | "deleted" | "moved";
		baseRanges?: { start: number; end: number }[];
		oldPath?: string;
	};
	codeStarts: number[];
	file: GitFile;
}

export interface MatchedChanges {
	changed: ChangedSymbol[];
	notes: string[];
	files: Map<string, GitFile>;
	current: Map<string, Declaration[]>;
}

const key = (item: Declaration) => `${item.name}:${item.kind}`;
const smallest = (items: Declaration[], line: number) =>
	items
		.filter(({ start, end }) => start <= line && line <= end)
		.toSorted((a, b) => a.end - a.start - (b.end - b.start))[0];
const ranges = (items: Declaration[]) => items.map(({ start, end }) => ({ start, end }));

/** Attribute changed hunks and lost declarations without graph edges. */
export async function matchChanges(
	git: GitChanges,
	projectRoot: string,
	parser: DeclarationParser,
): Promise<MatchedChanges> {
	const changed: ChangedSymbol[] = [];
	const notes: string[] = [];
	const files = new Map<string, GitFile>();
	const current = new Map<string, Declaration[]>();
	let nonTs = 0;
	let outside = 0;
	for (const file of git.files) {
		const local = git.projectPath(file.path);
		if (local.outside) {
			if (outside++ < 10) notes.push(`${file.path}: outside project`);
			continue;
		}
		if (!isTypeScript(file.path)) {
			if (nonTs++ < 10) notes.push(`${file.path}: not TypeScript`);
			continue;
		}
		const localPath = local.path!;
		files.set(localPath, file);
		if (file.oldPath) notes.push(`${file.oldPath} → ${file.path}: file rename`);
		const source = file.status === "deleted" ? undefined : await readFile(join(projectRoot, localPath), "utf8");
		const old =
			file.status === "untracked" || file.status === "added"
				? undefined
				: await git.baseText(file.oldPath ?? file.path);
		const now = source === undefined ? [] : indexedDeclarations(await parser.parse(localPath, source));
		const before = old === undefined ? [] : indexedDeclarations(await parser.parse(file.oldPath ?? file.path, old));
		current.set(localPath, now);
		const selected = new Set<string>();
		if (file.oldPath) now.filter((item) => !item.name.includes(".")).forEach((item) => selected.add(key(item)));
		let outsideDeclaration = false;
		if (file.status === "untracked" || file.status === "added") now.forEach((item) => selected.add(key(item)));
		else {
			for (const hunk of file.hunks) {
				let matched = false;
				if (hunk.newCount) {
					for (let line = hunk.newStart; line < hunk.newStart + hunk.newCount; line++) {
						const item = smallest(now, line);
						if (item) {
							selected.add(key(item));
							matched = true;
						}
					}
				} else {
					const item = smallest(now, Math.max(1, hunk.newStart));
					if (
						item &&
						before.some(
							(prior) => key(prior) === key(item) && prior.start <= hunk.oldStart && hunk.oldStart <= prior.end,
						)
					) {
						selected.add(key(item));
						matched = true;
					}
				}
				if (!matched && !before.some((prior) => prior.start <= hunk.oldStart && hunk.oldStart <= prior.end))
					outsideDeclaration = true;
			}
		}
		if (outsideDeclaration) notes.push(`${file.path}: imports changed`);
		const present = new Set(now.map(key));
		const deletedKeys = new Set(before.filter((item) => !present.has(key(item))).map(key));
		for (const itemKey of new Set([...selected, ...deletedKeys])) {
			const members = now.filter((item) => key(item) === itemKey);
			const oldMembers = before.filter((item) => key(item) === itemKey);
			const first = members[0] ?? oldMembers[0];
			if (!first) continue;
			const status =
				members.length === 0 ? "deleted" : oldMembers.length === 0 ? "added" : file.oldPath ? "moved" : "edited";
			const node: ChangedSymbol["node"] = {
				handle: handleFor(localPath, first),
				name: first.name,
				kind: graphKind(first.kind),
				file: localPath,
				ranges: ranges(members.length ? members : oldMembers),
				status,
				...(status === "moved" ? { oldPath: file.oldPath } : {}),
				...(status === "deleted" ? { baseRanges: ranges(oldMembers) } : {}),
			};
			changed.push({ node, codeStarts: members.map(({ codeStart }) => codeStart), file });
		}
	}
	if (nonTs > 10) notes.push(`... ${nonTs - 10} more non-TS files`);
	if (outside > 10) notes.push(`... ${outside - 10} more outside-project files`);
	const containers = changed.filter(
		({ node }) => (node.kind === "class" || node.kind === "interface") && node.status !== "edited",
	);
	return {
		changed: changed.filter(
			({ node }) =>
				!containers.some(
					({ node: parent }) =>
						parent.file === node.file && parent.status === node.status && node.name.startsWith(`${parent.name}.`),
				),
		),
		notes,
		files,
		current,
	};
}
