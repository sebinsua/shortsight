// Render the normalised graph as compact text for terminals and agents.
import { basename } from "node:path";
import { bold, dim, displayKind, groupedSymbols, unnamedTest } from "./layout.ts";
import { fromHandle, inheritRequest, requestFor, type GraphEdge, type GraphNode, type GraphResult } from "./model.ts";

const scalar = (value: unknown) => (typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));

function location(node: GraphNode): string {
	if (node.site)
		return `${node.file}:${node.site.start}${node.site.end === node.site.start ? "" : `-${node.site.end}`}`;
	return node.ranges?.length
		? `${node.file}:${node.ranges.map(({ start, end }) => `${start}-${end}`).join(",")}`
		: `${node.file}:range unavailable`;
}

// Trim the source line; in colour, dim it and keep the reference itself bright. A call over several lines
// continues below, keeping its indentation relative to the first line.
function referenceLines(node: GraphNode, color: boolean, pad: string): string[] {
	const [text = "", ...rest] = (node.text ?? "").split("\n");
	const trimmed = text.trim();
	const indent = text.length - text.trimStart().length;
	const margin = text.slice(0, indent);
	const continued = rest.map(
		(line) => `${pad}${dim(line.startsWith(margin) ? line.slice(indent).trimEnd() : line.trim(), color)}`,
	);
	if (!color || !node.col || !node.endCol) return [trimmed, ...continued];
	const start = Math.max(0, node.col - 1 - indent);
	const end = Math.min(trimmed.length, node.endCol - 1 - indent);
	const part = (value: string, style: typeof dim) => (value ? style(value, color) : "");
	return [
		`${part(trimmed.slice(0, start), dim)}${part(trimmed.slice(start, end), bold)}${part(trimmed.slice(end), dim)}`,
		...continued,
	];
}

// How far a trace goes, so "how widely is this used?" is answered by its first line.
function reach(result: GraphResult): string {
	const start = String(result.sections.start);
	const forward = result.sections.direction === "forward";
	const depth = new Map([[start, 0]]);
	for (let frontier = [start]; frontier.length;) {
		const next: string[] = [];
		for (const edge of result.edges) {
			const [near, far] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
			if (frontier.includes(near) && !depth.has(far)) {
				depth.set(far, depth.get(near)! + 1);
				next.push(far);
			}
		}
		frontier = next;
	}
	const reached = result.nodes.filter((node) => node.handle !== start);
	const files = new Set(reached.map((node) => node.file)).size;
	if (!files) return "";
	const levels = new Map<number, number>();
	for (const node of reached) {
		const level = depth.get(node.handle);
		if (level) levels.set(level, (levels.get(level) ?? 0) + 1);
	}
	const byDepth =
		levels.size > 1
			? `; ${[...levels]
					.toSorted(([a], [b]) => a - b)
					.map(([level, count]) => `${count} at depth ${level}`)
					.join(", ")}`
			: "";
	return ` in ${files} ${files === 1 ? "file" : "files"}${byDepth}`;
}

function summary(result: GraphResult, nodes: Map<string, GraphNode>): string {
	const { type, sections } = result;
	if (type === "overview") {
		const counts = sections.counts as { files?: number; nodes?: number; edges?: number } | undefined;
		return `overview: ${(counts?.files ?? 0).toLocaleString("en-US")} files, ${(counts?.nodes ?? 0).toLocaleString("en-US")} symbols, ${(counts?.edges ?? 0).toLocaleString("en-US")} relationships`;
	}
	const request = requestFor(result);
	let subject = "";
	if (type === "trace") {
		const start = nodes.get(String(sections.start));
		const from =
			start?.name ?? (typeof request?.from === "string" ? (fromHandle(request.from)?.name ?? request.from) : undefined);
		subject = `${sections.direction ? ` ${sections.direction}` : ""}${from ? ` from ${from}` : ""}`;
	} else if (typeof request?.query === "string") subject = ` for ${request.query}`;
	else if (Array.isArray(request?.reinterpretations))
		subject = ` for ${request.reinterpretations.map(scalar).join(", ")}`;
	const count = result.total === undefined ? `${result.shown} shown` : `${result.shown} of ${result.total} shown`;
	return `${type}${subject}${result.tsconfig && result.tsconfig !== "tsconfig.json" ? ` (${result.tsconfig})` : ""}: ${count}${type === "trace" ? reach(result) : ""}${result.raise ? ` (truncated; raise ${result.raise})` : ""}`;
}

function overviewText(result: GraphResult, nodes: Map<string, GraphNode>, color: boolean): string {
	const lines = [summary(result, nodes)];
	for (const [key, value] of Object.entries(result.sections)) {
		if (key === "layers" && Array.isArray(value) && value.length) {
			const layers = value as Array<{ dir: string; files: number; exported: number }>;
			const width = Math.max(...layers.map(({ dir }) => dir.length));
			const countWidth = Math.max(...layers.map(({ files }) => String(files).length));
			lines.push(
				"",
				key,
				...layers.map(
					({ dir, files, exported }) =>
						`  ${dir.padEnd(width)}  ${String(files).padStart(countWidth)} files  ${exported} exported`,
				),
			);
		}
		if ((key === "hotspots" || key === "publicApi") && Array.isArray(value) && value.length) {
			const ranked = value.filter((handle): handle is string => typeof handle === "string" && nodes.has(handle));
			const rankedNodes = ranked.map((handle) => nodes.get(handle)!);
			const nameWidth = Math.max(...rankedNodes.map((node) => node.name.length));
			const kindWidth = Math.max(...rankedNodes.map((node) => displayKind(node).length));
			const numberWidth = String(rankedNodes.length).length;
			const locationWidth = Math.max(...rankedNodes.map((node) => location(node).length));
			lines.push(
				"",
				key,
				...rankedNodes.map(
					(node, index) =>
						`  ${String(index + 1).padStart(numberWidth)}. ${bold(node.name, color)}${" ".repeat(nameWidth - node.name.length + 2)}${dim(displayKind(node).padEnd(kindWidth), color)}  ${key === "hotspots" ? `${bold(location(node), color)}${" ".repeat(locationWidth - location(node).length)}  fan-in ${node.fanIn ?? 0}, fan-out ${node.fanOut ?? 0}` : bold(location(node), color)}`,
				),
			);
		}
	}
	return lines.join("\n");
}

function edgeLines(edges: GraphEdge[], nodes: Map<string, GraphNode>, color: boolean): string[] {
	const names = edges.map((edge) => {
		const from = nodes.get(edge.from)?.name ?? edge.from;
		const to = nodes.get(edge.to)?.name ?? edge.to;
		return `${from} → ${to}`;
	});
	const width = Math.max(0, ...names.map((name) => name.length));
	const paths = edges.map((edge) => edge.at?.file).filter((file): file is string => !!file);
	const baseCounts = new Map<string, number>();
	for (const file of new Set(paths)) baseCounts.set(basename(file), (baseCounts.get(basename(file)) ?? 0) + 1);
	return edges.map((edge, index) => {
		const at = edge.at
			? ` at ${baseCounts.get(basename(edge.at.file)) === 1 ? basename(edge.at.file) : edge.at.file}:${edge.at.line}`
			: "";
		return `  ${bold(names[index], color)}${" ".repeat(width - names[index].length + 2)}${dim(edge.kind + at, color)}`;
	});
}

/** Render one model with one mention of each symbol's location. */
export function renderText(result: GraphResult, options: { color: boolean }): string {
	if (result.note)
		return `${renderText(inheritRequest(result, { ...result, note: undefined }), options)}\n\nnote: ${result.note}`;
	const nodes = new Map(result.nodes.map((node) => [node.handle, node]));
	if (result.type === "overview") return overviewText(result, nodes, options.color);
	if (result.type === "references") {
		const symbol = String(result.sections.symbol ?? "");
		const declared = result.sections.declaration as { file: string; line: number; text?: string } | undefined;
		const files = new Set(result.nodes.map((node) => node.file));
		const lines = [
			`references to ${symbol}: ${result.nodes.length} in ${files.size} ${files.size === 1 ? "file" : "files"}`,
			...(declared
				? [`declared at ${declared.file}:${declared.line}${declared.text ? `  ${declared.text}` : ""}`]
				: []),
		];
		for (const file of files) {
			const references = result.nodes.filter((node) => node.file === file);
			const width = Math.max(...references.map((node) => `${node.line}:${node.col}`.length));
			lines.push("", bold(file, options.color));
			for (const node of references) {
				const label = node.in ? `in ${node.in.name}  ` : "";
				const container = label ? `${dim(label.trimEnd(), options.color)}  ` : "";
				const [first, ...rest] = referenceLines(node, options.color, " ".repeat(width + 4 + label.length));
				lines.push(
					`  ${dim(`${node.line}:${node.col}`.padStart(width), options.color)}  ${container}${first}`,
					...rest,
				);
			}
		}
		return lines.join("\n");
	}
	const baseCounts = new Map<string, number>();
	for (const file of new Set(result.nodes.map((node) => node.file)))
		baseCounts.set(basename(file), (baseCounts.get(basename(file)) ?? 0) + 1);
	const lines = [summary(result, nodes)];
	const rankedKey = result.type === "lookup" ? "hits" : result.type === "tour" ? "entrypoints" : undefined;
	const ranked =
		rankedKey && Array.isArray(result.sections[rankedKey]) ? (result.sections[rankedKey] as unknown[]) : [];
	const rankedHandles = new Set(ranked.filter((item): item is string => typeof item === "string" && nodes.has(item)));
	const pushSection = (section: string[]) => {
		if (section.length) lines.push("", ...section);
	};
	if (rankedKey && ranked.length) {
		const rows = [rankedKey];
		const rankedNodes = [...rankedHandles].map((handle) => nodes.get(handle)!);
		const nameWidth = Math.max(...rankedNodes.map((node) => node.name.length));
		const kindWidth = Math.max(...rankedNodes.map((node) => displayKind(node).length));
		for (const handle of rankedHandles) {
			const node = nodes.get(handle)!;
			rows.push(
				`  ${node.exact ? "= " : "  "}${bold(node.name, options.color)}${" ".repeat(nameWidth - node.name.length + 2)}${dim(displayKind(node).padEnd(kindWidth), options.color)}  ${bold(location(node), options.color)}`.trimEnd(),
			);
		}
		pushSection(rows);
	}
	const grouped = result.nodes.filter((node) => !rankedHandles.has(node.handle));
	const seenEdges = new Set<number>();
	// A trace's links go on the row of the symbol they start from, since a call's file is that symbol's file. A
	// path keeps its links in order, below.
	const folded = new Map<string, Map<string, string[]>>();
	if (result.type === "trace" && requestFor(result)?.to === undefined && Array.isArray(result.sections.hops))
		for (const index of result.sections.hops) {
			const edge = typeof index === "number" ? result.edges[index] : undefined;
			const from = edge && nodes.get(edge.from);
			if (!edge || !from || from.site || (edge.at && edge.at.file !== from.file)) continue;
			const byKind = folded.get(edge.from) ?? new Map<string, string[]>();
			const target = `${nodes.get(edge.to)?.name ?? edge.to}${edge.at ? dim(` :${edge.at.line}`, options.color) : ""}`;
			byKind.set(edge.kind, [...(byKind.get(edge.kind) ?? []), target]);
			folded.set(edge.from, byKind);
			seenEdges.add(index);
		}
	if (grouped.length)
		pushSection(
			groupedSymbols(grouped, options.color, (node) =>
				[...(folded.get(node.handle) ?? [])]
					.map(([kind, targets]) => `${dim(kind, options.color)} ${targets.join(", ")}`)
					.join("; "),
			),
		);
	const skip = new Set(
		["query", "reinterpretations", "start", "direction", rankedKey, "reached", "nodes", "total"].filter(
			(item): item is string => !!item,
		),
	);
	const compactFlow = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(compactFlow);
		if (value === null || typeof value !== "object") return value;
		const item = value as Record<string, unknown>;
		const targets = new Set(
			Array.isArray(item.steps)
				? item.steps.flatMap((step) => (typeof step === "number" && result.edges[step] ? [result.edges[step].to] : []))
				: [],
		);
		return Object.fromEntries(
			Object.entries(item).flatMap(([key, nested]) => {
				if (key === "reached" && Array.isArray(nested)) {
					const extra = nested.filter((handle) => !targets.has(handle));
					return extra.length
						? [
								[
									key,
									extra
										.map((handle) =>
											typeof handle === "string" && nodes.has(handle) ? nodes.get(handle)!.name : scalar(handle),
										)
										.join(", "),
								],
							]
						: [];
				}
				return [[key, compactFlow(nested)]];
			}),
		);
	};
	const describe = (value: unknown, depth: number, key?: string): string[] => {
		const pad = "  ".repeat(depth);
		if (typeof value === "string" && nodes.has(value))
			return [
				`${pad}${key ? `${key}: ` : ""}${bold(unnamedTest(nodes.get(value)!) ? `${baseCounts.get(basename(nodes.get(value)!.file)) === 1 ? basename(nodes.get(value)!.file) : nodes.get(value)!.file}:${nodes.get(value)!.site!.start}` : nodes.get(value)!.name, options.color)}`,
			];
		if (Array.isArray(value)) {
			if (value.length && value.every((item) => typeof item === "number" && result.edges[item])) {
				const indices = value.filter((item): item is number => typeof item === "number" && !seenEdges.has(item));
				indices.forEach((index) => seenEdges.add(index));
				return indices.length
					? [
							...(key ? [`${pad}${key}`] : []),
							...edgeLines(
								indices.map((index) => result.edges[index]),
								nodes,
								options.color,
							).map((line) => `${pad}${line}`),
						]
					: [];
			}
			const stepIndices =
				key === "steps"
					? value.filter(
							(item): item is number => typeof item === "number" && !!result.edges[item] && !seenEdges.has(item),
						)
					: [];
			const stepLines = edgeLines(
				stepIndices.map((index) => result.edges[index]),
				nodes,
				options.color,
			);
			let stepIndex = 0;
			const entries = value.flatMap((item) => {
				if (typeof item === "number" && key === "steps" && result.edges[item]) {
					if (seenEdges.has(item)) return [];
					seenEdges.add(item);
					return [`${pad}${stepLines[stepIndex++]}`];
				}
				return describe(item, depth + 1);
			});
			return entries.length ? [...(key ? [`${pad}${key}`] : []), ...entries] : [];
		}
		if (value !== null && typeof value === "object") {
			const entries = Object.entries(value).flatMap(([child, nested]) =>
				describe(nested, depth + (key ? 1 : 0), child),
			);
			return entries.length ? [...(key ? [`${pad}${key}`] : []), ...entries] : [];
		}
		return [`${pad}${key ? `${key}: ` : ""}${scalar(value)}`];
	};
	const mentioned = new Set<unknown>();
	const collect = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(collect);
		else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
		else mentioned.add(value);
	};
	for (const [key, original] of Object.entries(result.sections)) {
		if (skip.has(key)) continue;
		const value = key === "primaryFlow" ? compactFlow(original) : original;
		if (
			key === "answerAnchors" &&
			Array.isArray(value) &&
			value.every((item) => typeof item === "string" && nodes.has(item))
		)
			continue;
		if (Array.isArray(value) && value.length && value.every((item) => mentioned.has(item))) continue;
		if (Array.isArray(value) && value.length && value.every((item) => typeof item === "number" && result.edges[item])) {
			const indices = value.filter((item): item is number => typeof item === "number" && !seenEdges.has(item));
			indices.forEach((index) => seenEdges.add(index));
			if (indices.length)
				pushSection([
					key,
					...edgeLines(
						indices.map((index) => result.edges[index]),
						nodes,
						options.color,
					),
				]);
		} else pushSection(describe(value, 0, key));
		collect(value);
	}
	if (lines.length === 1) lines.push("", "(none)");
	return lines.join("\n");
}
