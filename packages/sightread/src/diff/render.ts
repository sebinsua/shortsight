// Render the stable diff result as aligned text or a single JSON object.
import { bold, dim, range } from "../layout.ts";
import { fromHandle, type GraphNode } from "../model.ts";
import type { GitFile } from "./git.ts";

export interface DiffResult {
	base: string;
	baseRef?: string;
	project: string;
	tsconfig?: string;
	totalChanged?: number;
	changed: Array<
		GraphNode & {
			status: "edited" | "added" | "deleted" | "moved";
			baseRanges?: { start: number; end: number }[];
			oldPath?: string;
		}
	>;
	callers: GraphNode[];
	chains: Array<{ handles: string[]; hops: Array<{ from: string; to: string; kind: string }>; byName?: true }>;
	tests: Array<GraphNode & { byName?: true }>;
	notes: string[];
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const listed = (items: string[], limit: number) =>
	`${items.slice(0, limit).join(", ")}${items.length > limit ? `, … (${items.length - limit} more)` : ""}`;

/** Coalesce repeated diagnostics and keep note kinds in reading order. */
export function formatDiffNotes(notes: string[]): string[] {
	const groups: string[][] = Array.from({ length: 8 }, () => []);
	const truncated: string[] = [];
	const nonTs: string[] = [];
	const imports: string[] = [];
	const outside: string[] = [];
	let extraNonTs = 0;
	let extraOutside = 0;
	for (const note of notes) {
		const truncation = note.match(/^(.+): impact truncated at \d+ callers; reverse trace used$/);
		if (note.startsWith("no default branch found")) groups[0].unshift(note);
		else if (truncation) truncated.push(truncation[1]);
		else if (note.endsWith(": not TypeScript")) nonTs.push(note.slice(0, -": not TypeScript".length));
		else if (/^\.\.\. \d+ more non-TS files$/.test(note)) extraNonTs += Number(note.match(/\d+/)?.[0]);
		else if (note.endsWith(": imports changed")) imports.push(note.slice(0, -": imports changed".length));
		else if (note.includes("(cap 30)")) groups[0].push(note);
		else if (note.includes(": not indexed:")) groups[2].push(note);
		else if (note.includes("deleted/renamed away")) groups[3].push(note);
		else if (note.endsWith(": file rename")) groups[4].push(note);
		else if (note.endsWith(": outside project")) outside.push(note.slice(0, -": outside project".length));
		else if (/^\.\.\. \d+ more outside-project files$/.test(note)) extraOutside += Number(note.match(/\d+/)?.[0]);
		else groups[5].push(note);
	}
	if (truncated.length)
		groups[1].push(
			`impact truncated for ${plural(truncated.length, "symbol")} (${listed(truncated, 5).replace(/, … \(\d+ more\)$/, ", …")}); reverse trace used`,
		);
	if (imports.length > 3) groups[5].push(`${imports.length} imports changed: ${listed(imports.toSorted(), 3)}`);
	else groups[5].push(...imports.toSorted().map((path) => `${path}: imports changed`));
	if (nonTs.length || extraNonTs) {
		const count = nonTs.length + extraNonTs;
		const names = nonTs.slice(0, 3).join(", ");
		groups[6].push(
			`${count} non-TypeScript ${count === 1 ? "file" : "files"} changed: ${names}${count > 3 ? `, … (${count - 3} more)` : ""}`,
		);
	}
	if (outside.length || extraOutside) {
		const count = outside.length + extraOutside;
		const names = outside.slice(0, 3).join(", ");
		groups[7].push(
			`${count} ${count === 1 ? "file" : "files"} changed outside the project: ${names}${count > 3 ? `, … (${count - 3} more)` : ""}`,
		);
	}
	return groups.flat();
}

const relation: Record<string, string> = {
	calls: "called by",
	accesses: "accessed by",
	instantiates: "instantiated by",
	type_ref: "used as a type by",
	doc_ref: "linked from the docs of",
	extends: "extended by",
	implements: "implemented by",
	overrides: "overridden by",
	dispatches: "dispatched to by",
	renders: "rendered by",
	by_name: "named in",
};
const maxChildren = 8;

// Join sorted line numbers into runs: 10-18, 22-28, 32.
function lineRuns(lines: number[]): string {
	const runs: Array<{ start: number; end: number }> = [];
	for (const line of [...new Set(lines)].toSorted((a, b) => a - b)) {
		const last = runs.at(-1);
		if (last && line <= last.end + 1) last.end = line;
		else runs.push({ start: line, end: line });
	}
	return runs.map(({ start, end }) => (start === end ? `${start}` : `${start}-${end}`)).join(", ");
}

// Draw what reaches each changed declaration as a tree. A caller is expanded the first time it
// appears and marked "shown above" after that, so shared callers are drawn once.
function impactTrees(
	value: DiffResult,
	files: Map<string, GitFile>,
	color: boolean,
): { rows: string[]; shown: Set<string> } {
	const nodes = new Map([...value.changed, ...value.callers].map((node) => [node.handle, node]));
	const callersOf = new Map<string, Map<string, string>>();
	for (const { handles, hops } of value.chains)
		for (let index = 1; index < handles.length; index++) {
			const target = handles[index];
			const callers = callersOf.get(target) ?? new Map<string, string>();
			if (!callers.has(handles[index - 1])) callers.set(handles[index - 1], hops[index - 1]?.kind ?? "calls");
			callersOf.set(target, callers);
		}
	const shown = new Set<string>();
	const describe = (handle: string) => {
		const node = nodes.get(handle);
		const ref = fromHandle(handle);
		const file = node?.file ?? ref?.file ?? handle;
		const where = node && (node.site || node.ranges?.length) ? `${file}:${range(node).replaceAll(", ", ",")}` : file;
		return `${where}  ${bold(node?.name ?? ref?.name ?? handle, color)}`;
	};
	const rows: string[] = [];
	const branch = (handle: string, prefix: string) => {
		const callers = [...(callersOf.get(handle) ?? [])];
		const visible = callers.slice(0, maxChildren);
		visible.forEach(([caller, kind], index) => {
			const last = index === visible.length - 1 && callers.length <= maxChildren;
			const repeat = shown.has(caller);
			shown.add(caller);
			rows.push(
				`${prefix}${dim(last ? "└─ " : "├─ ", color)}${dim(relation[kind] ?? `${kind} by`, color)} ${describe(caller)}${repeat ? dim("  (shown above)", color) : ""}`,
			);
			if (!repeat) branch(caller, `${prefix}${last ? "   " : dim("│  ", color)}`);
		});
		if (callers.length > maxChildren)
			rows.push(
				`${prefix}${dim("└─ ", color)}${dim(`… ${plural(callers.length - maxChildren, "more caller")}`, color)}`,
			);
	};
	for (const file of new Set(value.changed.map((node) => node.file))) {
		const info = files.get(file);
		const label =
			info?.status === "untracked" || info?.status === "added"
				? "  (new file)"
				: info?.status === "deleted"
					? "  (deleted file)"
					: info?.oldPath
						? `  (renamed from ${info.oldPath})`
						: "";
		rows.push("", `${bold(file, color)}${label}`);
		const changed = value.changed.filter((node) => node.file === file);
		const width = Math.max(...changed.map((node) => range(node).length));
		for (const node of changed) {
			const status =
				node.status === "deleted"
					? "deleted (base lines)"
					: node.status === "moved"
						? `moved (from ${node.oldPath})`
						: node.status;
			rows.push(`  ${dim(range(node).padStart(width), color)}  ${bold(node.name, color)}  ${status}`);
			shown.add(node.handle);
			if (callersOf.has(node.handle)) branch(node.handle, "  ");
			else if (node.status !== "added") rows.push(`  ${dim("└─ no callers", color)}`);
		}
	}
	return { rows, shown };
}

function otherCallerRows(callers: DiffResult["callers"], shown: Set<string>, color: boolean): string[] {
	const files = new Map<string, DiffResult["callers"]>();
	for (const caller of callers) {
		if (shown.has(caller.handle)) continue;
		const group = files.get(caller.file) ?? [];
		group.push(caller);
		files.set(caller.file, group);
	}
	return [...files].flatMap(([file, nodes]) => [
		bold(file, color),
		...nodes.map((node) => `  ${dim(range(node), color)}  ${bold(node.name, color)}`),
	]);
}

// Each test file, then one row per name it uses, with the lines.
function testRows(value: DiffResult, color: boolean): string[] {
	const files = new Map<string, Map<string, { name: string; lines: number[]; byName: boolean }>>();
	for (const node of value.tests) {
		const names = files.get(node.file) ?? new Map<string, { name: string; lines: number[]; byName: boolean }>();
		const key = JSON.stringify([node.name, !!node.byName]);
		const group = names.get(key) ?? { name: node.name, lines: [], byName: !!node.byName };
		if (node.site) group.lines.push(node.site.start);
		names.set(key, group);
		files.set(node.file, names);
	}
	return [...files].flatMap(([file, names]) => [
		bold(file, color),
		...[...names.values()].map(
			({ name, lines, byName }) =>
				`  ${bold(name, color)}${lines.length ? ` on ${lines.length === 1 ? "line" : "lines"} ${lineRuns(lines)}` : ""}${byName ? dim("  (by name)", color) : ""}`,
		),
	]);
}

/** Show counts, then each change with what reaches it, the tests that use it, and bounded notes. */
export function renderDiffText(value: DiffResult, files: Map<string, GitFile>, color: boolean): string {
	const testCount = new Set(value.tests.map(({ file }) => file)).size;
	const total = value.totalChanged ?? value.changed.length;
	const what =
		total === 1 && value.changed.length === 1
			? `${value.changed[0].name} ${value.changed[0].status}`
			: `${total} changed${value.totalChanged === undefined ? "" : ` (${value.changed.length} analysed)`}`;
	const lines = [
		`diff against ${value.baseRef ? `${value.baseRef} (${value.base.slice(0, 12)})` : value.base.slice(0, 12)}${value.project === "." ? "" : ` in ${value.project}`}${value.tsconfig && value.tsconfig !== "tsconfig.json" ? ` using ${value.tsconfig}` : ""}: ${what} · used by ${value.callers.length} · tested by ${plural(testCount, "file")}`,
	];
	const section = (title: string, rows: string[]) => {
		if (rows.length) lines.push("", title, ...rows);
	};
	const trees = impactTrees(value, files, color);
	lines.push(...trees.rows);
	section("other callers", otherCallerRows(value.callers, trees.shown, color));
	section("tests", testRows(value, color));
	section(
		"notes",
		formatDiffNotes(value.notes)
			.slice(0, 40)
			.map((note) => `  ${note}`),
	);
	if (lines.length === 1) lines.push("", "(no changes)");
	return lines.join("\n");
}
