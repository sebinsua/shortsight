// Answer for declarations the graph has no node for, such as a type literal's members, from their own parse.
import { fromHandle, object } from "./model.ts";
import { graphKind, type DeclarationKind } from "./naming.ts";
import { graphNameOf, type Declaration, type RangeIndex } from "./ranges.ts";

/** The declaration a handle names when the graph has no node for it. */
export async function unindexed(ranges: RangeIndex, handle: unknown): Promise<Declaration | undefined> {
	const ref = typeof handle === "string" ? fromHandle(handle) : undefined;
	if (!ref) return undefined;
	const declarations = ((await ranges.declarations(ref.file)) ?? []).filter(
		(declaration) => graphKind(declaration.kind) === graphKind(ref.kind as DeclarationKind),
	);
	if (declarations.some((declaration) => graphNameOf(declaration) === ref.name)) return undefined;
	return declarations.find((declaration) => declaration.unindexed && declaration.name === ref.name);
}

function why(declaration: Declaration): string {
	const owner = declaration.name.slice(0, declaration.name.lastIndexOf("."));
	switch (declaration.unindexed) {
		case "local":
			return `it's local to ${owner} and holds no function`;
		case "shared":
			return `it shares the name ${declaration.graphName} with another declaration in its file`;
		default:
			return `it's a member of ${owner}`;
	}
}

/** Why a trace can't run, when it would start forward from or end at a declaration the graph has no node for. */
export async function traceRefusal(ranges: RangeIndex, request: Record<string, unknown>): Promise<string | undefined> {
	const advice = "trace reverse from it for what uses it, or ask references";
	const to = await unindexed(ranges, request.to);
	if (to) return `trace can't reach ${to.name}: the graph has no node for it, as ${why(to)}; ${advice}`;
	const from = await unindexed(ranges, request.from);
	if (from && (request.direction !== "reverse" || request.to !== undefined))
		return `trace can only go reverse from ${from.name}: the graph has no node for it, as ${why(from)}; ${advice}`;
	return undefined;
}

/** Give each handle `details` didn't know its declaration's node, which has lines but no edges. */
export async function withUnindexed(ranges: RangeIndex, value: unknown): Promise<{ value: unknown; note?: string }> {
	const result = object(object(value)?.result) ?? object(value);
	const unknown = Array.isArray(result?.unknown) ? result.unknown : [];
	const found: Array<[string, Declaration]> = [];
	for (const handle of unknown) {
		const declaration = await unindexed(ranges, handle);
		if (declaration) found.push([handle as string, declaration]);
	}
	if (!result || !found.length) return { value };
	result.nodes = [
		...(Array.isArray(result.nodes) ? result.nodes : []),
		...found.map(([handle, declaration]) => ({ id: handle, ...fromHandle(handle), kind: declaration.kind })),
	];
	result.unknown = unknown.filter((handle) => !found.some(([known]) => known === handle));
	const names = found.map(([, declaration]) => declaration.name);
	const one = names.length === 1;
	return {
		value,
		note: `${names.join(", ")} ${one ? "has" : "have"} no graph node, so no edges; references lists ${one ? "its" : "their"} uses`,
	};
}
