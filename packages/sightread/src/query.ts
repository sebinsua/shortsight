// Run graph batches and choose raw, model, or text output.
import { isAbsolute, normalize, relative, sep } from "node:path";
import { inheritRequest, normalizeResult, type GraphResult } from "./model.ts";
import { resolveNamesSettled } from "./names.ts";
import { createPaths } from "./paths.ts";
import type { RangeIndex } from "./ranges.ts";
import type { ReferenceIndex } from "./references.ts";
import { renderText } from "./render.ts";
import type { GraphClient } from "./upstream.ts";

export interface QueryContext {
	client: GraphClient;
	ranges: RangeIndex;
	references?: ReferenceIndex;
	root?: string;
	tsconfig?: string;
	projectFileCount?: number;
	nestedProjects?: string[];
}

export interface QueryOptions {
	mode?: "text" | "json" | "raw";
	in?: string;
	color?: boolean;
	json?: boolean;
}

function filterIn(result: GraphResult, directory: string): GraphResult {
	const prefix = normalize(directory).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").replace(/^\.$/, "");
	const keep = (file: string) => !prefix || file === prefix || file.startsWith(`${prefix}/`);
	const nodes = result.nodes.filter((node) => keep(node.file));
	const handles = new Set(nodes.map((node) => node.handle));
	const allHandles = new Set(result.nodes.map((node) => node.handle));
	const edges = result.edges.filter((edge) => handles.has(edge.from) && handles.has(edge.to));
	const indices = new Map<number, number>();
	result.edges.forEach((edge, index) => {
		const next = edges.indexOf(edge);
		if (next >= 0) indices.set(index, next);
	});
	const filter = (value: unknown, edgeList = false): unknown => {
		if (typeof value === "string" && allHandles.has(value)) return handles.has(value) ? value : undefined;
		if (Array.isArray(value)) {
			const entries = value.map((item) => filter(item, edgeList)).filter((item) => item !== undefined);
			return entries.length ? entries : undefined;
		}
		if (typeof value === "number" && edgeList) return indices.get(value);
		if (value && typeof value === "object") {
			const entries = Object.entries(value)
				.map(([key, item]) => [key, filter(item, key === "hops")] as const)
				.filter(([, item]) => item !== undefined);
			return entries.length ? Object.fromEntries(entries) : undefined;
		}
		return value;
	};
	const sections = Object.fromEntries(
		Object.entries(result.sections)
			.map(([key, value]) => [key, filter(value, key === "hops")])
			.filter(([, value]) => value !== undefined),
	);
	const primary = ["hits", "entrypoints", "nodes", "reached", "hops", "files", "tests"].find((key) =>
		Array.isArray(result.sections[key]),
	);
	return inheritRequest(result, {
		...result,
		nodes,
		edges,
		sections,
		shown:
			result.type === "references"
				? nodes.length
				: primary && Array.isArray(sections[primary])
					? sections[primary].length
					: 0,
	});
}

/** Run one request or a batch and return exactly what the CLI prints. */
// The graph returns at most this many symbols per trace, however many are asked for.
const GRAPH_TRACE_LIMIT = 32;
const WALK_LIMIT = 1000;

// A reverse trace the graph cut short is walked to the end through compiler references, so "what does this
// affect" has a complete answer. Other traces at the graph's limit say so, rather than advising a raise
// that can't happen.
async function completeTrace(
	context: QueryContext,
	request: Record<string, unknown>,
	model: GraphResult,
	paths: ReturnType<typeof createPaths> | undefined,
): Promise<void> {
	if (model.error || model.type !== "trace" || model.raise !== "trace.maxNodes") return;
	const asked = typeof request.maxNodes === "number" ? request.maxNodes : undefined;
	if (request.direction === "reverse" && request.to === undefined && asked !== undefined && asked <= GRAPH_TRACE_LIMIT)
		return;
	if (
		request.direction === "reverse" &&
		request.to === undefined &&
		context.references &&
		paths &&
		(asked === undefined || asked > GRAPH_TRACE_LIMIT)
	) {
		const start = String(model.sections.start);
		const limit = asked ?? WALK_LIMIT;
		const walked = await context.references.walk(
			start,
			{ maxNodes: limit, ...(typeof request.maxDepth === "number" ? { maxDepth: request.maxDepth } : {}) },
			paths,
		);
		model.nodes = [...model.nodes.filter((node) => node.handle === start), ...walked.nodes];
		model.edges = walked.edges;
		model.sections = {
			start,
			direction: "reverse",
			hops: walked.edges.map((_, index) => index),
			reached: walked.nodes.map((node) => node.handle),
		};
		model.shown = walked.nodes.length;
		delete model.raise;
		model.note = `${
			walked.truncated
				? `stopped at ${limit} symbols; trace from a narrower symbol`
				: `complete: past the graph's ${GRAPH_TRACE_LIMIT}-symbol limit, callers were followed through compiler references`
		}${walked.skipped ? `; ${walked.skipped} ${walked.skipped === 1 ? "symbol" : "symbols"} skipped` : ""}`;
	} else if ((asked !== undefined && asked >= GRAPH_TRACE_LIMIT) || model.shown >= GRAPH_TRACE_LIMIT) {
		delete model.raise;
		model.note = `truncated at the graph's ${GRAPH_TRACE_LIMIT}-symbol limit; trace again from the symbols at its edge`;
	}
}

export async function runQuery(
	context: QueryContext,
	requests: Record<string, unknown>[],
	options: QueryOptions,
): Promise<string> {
	const mode = options.mode ?? (options.json ? "json" : "text");
	const paths = context.root ? createPaths(context.root) : undefined;
	const resolved = await resolveNamesSettled(context.client, requests, paths);
	const results = await Promise.all(
		resolved.map(async (item) => {
			if ("error" in item) return { error: item.error };
			try {
				if (item.request.type === "references") {
					if (!context.references || !paths) throw new Error("references require a project server");
					return { value: await context.references.query(item.request, paths), local: true as const };
				}
				return { value: (await context.client.query(item.request)).value };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error), cause: error };
			}
		}),
	);
	if (requests.length === 1 && "error" in results[0]) throw results[0].cause ?? new Error(results[0].error);
	if (mode === "raw")
		return results
			.map((result) =>
				JSON.stringify(
					"error" in result ? { type: requests[results.indexOf(result)].type, error: result.error } : result.value,
				),
			)
			.join("\n");
	const models = await Promise.all(
		results.map((result, index) =>
			"error" in result
				? ({ type: String(requests[index].type), error: result.error, tsconfig: context.tsconfig } as GraphResult)
				: "local" in result
					? (result.value as GraphResult)
					: normalizeResult(requests[index], result.value, context.ranges, paths),
		),
	);
	await Promise.all(models.map((model, index) => completeTrace(context, requests[index], model, paths)));
	for (const model of models) if (context.tsconfig) model.tsconfig = context.tsconfig;
	for (const model of models) model.nestedProjects = context.nestedProjects ?? [];
	const filtered = options.in
		? models.map((model) => {
				if (model.error) return model;
				const directory = paths
					? paths.inputToRepositoryPath(options.in!)
					: context.root && isAbsolute(options.in!)
						? relative(context.root, options.in!)
						: options.in!;
				return filterIn(
					model,
					directory === ".." || directory.startsWith(`..${sep}`) || isAbsolute(directory) ? "\0" : directory,
				);
			})
		: models;
	if (mode === "json") return JSON.stringify(filtered);
	const formatted = filtered.map((result) =>
		result.error ? `error: ${result.error}` : renderText(result, { color: options.color === true }),
	);
	const output =
		formatted.length === 1
			? formatted[0]
			: formatted.map((value, index) => `=== ${index + 1}: ${models[index].type} ===\n${value}`).join("\n\n");
	return context.nestedProjects?.length
		? `${output}\n\nnote: graphed ${context.tsconfig ?? "tsconfig.json"} (${context.projectFileCount ?? 0} ${context.projectFileCount === 1 ? "file" : "files"}); nested projects: ${context.nestedProjects.slice(0, 5).join(", ")}. Run from one of those for its code.`
		: output;
}
