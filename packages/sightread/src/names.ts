// Resolve request names to graph handles in one lookup batch.
import { fromHandle, object } from "./model.ts";
import type { PathMapper } from "./paths.ts";
import type { GraphClient } from "./upstream.ts";

const fields: Record<string, string[]> = { details: ["handles"], trace: ["from", "to"], references: ["symbol"] };

const segments = (name: string) =>
	name
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.split(/[.\s_]+/)
		.map((word) => word.toLowerCase())
		.filter((word) => word.length >= 3);

function closeName(wanted: string, candidate: string): boolean {
	const left = wanted.split(".").at(-1)!.toLowerCase();
	const right = candidate.split(".").at(-1)!.toLowerCase();
	if (segments(wanted).some((word) => segments(candidate).includes(word))) return true;
	const limit = Math.floor(left.length / 3);
	if (Math.abs(left.length - right.length) > limit) return false;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		const next = [row];
		for (let column = 1; column <= right.length; column++)
			next[column] = Math.min(
				next[column - 1] + 1,
				previous[column] + 1,
				previous[column - 1] + Number(left[row - 1] !== right[column - 1]),
			);
		previous = next;
	}
	return previous[right.length] <= limit;
}

const symbolField: Record<string, string> = { details: "handles", trace: "from", references: "symbol" };

// Each type names its symbol differently, so take `symbol` everywhere, and name the right field when a request
// borrows another type's.
function withAliases(request: Record<string, unknown>): Record<string, unknown> | Error {
	const type = String(request.type);
	const field = symbolField[type];
	if (!field) return request;
	const { symbol, ...rest } = request;
	const value = rest[field] ?? symbol;
	if (value === undefined) {
		const borrowed = Object.values(symbolField).find((name) => request[name] !== undefined);
		return borrowed
			? new Error(`${type} takes ${field === "symbol" ? "symbol" : `${field} or symbol`}, not ${borrowed}`)
			: request;
	}
	if (field === "handles") return { ...rest, handles: Array.isArray(value) ? value : [value] };
	if (!Array.isArray(value)) return { ...rest, [field]: value };
	return value.length === 1
		? { ...rest, [field]: value[0] }
		: new Error(`${type} takes one symbol; got ${value.length}`);
}

/** Whether a handle's symbol is `wanted`, or a member named its last part. */
const named = (wanted: string) => (handle: string) => {
	const parsed = fromHandle(handle);
	return parsed?.name === wanted || parsed?.name.split(".").at(-1) === wanted;
};

const withoutKind = (handle: string) => handle.slice(0, handle.lastIndexOf(":"));

// A name may carry its file, `src/lib/pricing.ts#applyDiscount`, to choose among same-named symbols.
function qualified(value: string): [file: string, name: string] | undefined {
	const at = value.lastIndexOf("#");
	return at > 0 && !fromHandle(value) ? [value.slice(0, at), value.slice(at + 1)] : undefined;
}

/** Replace bare names in handle fields before sending requests upstream. */
export async function resolveNamesSettled(
	client: GraphClient,
	original: Record<string, unknown>[],
	paths?: PathMapper,
	/** Where what `file` exports as `name` is declared, when it re-exports it from another file. */
	reexport?: (file: string, name: string) => Promise<{ file: string; name: string } | undefined>,
): Promise<Array<{ request: Record<string, unknown> } | { error: string }>> {
	const aliased = original.map(withAliases);
	const requests = aliased.map((request) => (request instanceof Error ? {} : request));
	const settle = (request: Record<string, unknown>, index: number) => {
		const alias = aliased[index];
		return alias instanceof Error ? { error: alias.message } : { request: convertHandles(request, paths) };
	};
	const names = [
		...new Set(
			requests.flatMap((request) =>
				(fields[String(request.type)] ?? []).flatMap((field) => {
					const value = request[field];
					return (Array.isArray(value) ? value : [value]).filter(
						(item): item is string => typeof item === "string" && (!item.includes("#") || !!qualified(item)),
					);
				}),
			),
		),
	];
	if (!names.length) return requests.map(settle);
	const queries = [
		...new Set(
			names.flatMap((given) => {
				const name = qualified(given)?.[1] ?? given;
				const last = name.split(".").at(-1)!;
				return [...(qualified(given) ? [given] : []), name, last, last.slice(0, 3)];
			}),
		),
	];
	const qualifiedQueries = new Set(
		names.flatMap((given) => {
			const name = qualified(given)?.[1];
			if (!name) return [];
			const last = name.split(".").at(-1)!;
			return [given, name, last, last.slice(0, 3)];
		}),
	);
	const lookups = await client.batch(
		queries.map((query) => ({ type: "lookup", query, limit: qualifiedQueries.has(query) ? 200 : 10 })),
	);
	const hitsFor = (query: string): string[] => {
		const result = object(object(lookups[queries.indexOf(query)].value)?.result);
		const hits = Array.isArray(result?.hits) ? result.hits : [];
		return hits.flatMap((hit) => {
			const id = object(hit)?.id;
			return typeof id === "string" && fromHandle(id) ? [id] : [];
		});
	};
	const resolved = new Map<string, string | Error>();
	for (let index = 0; index < names.length; index++) {
		const given = names[index];
		const [file, name]: [string | undefined, string] = qualified(given) ?? [undefined, given];
		const inFile = (handle: string) =>
			file === undefined ||
			fromHandle(paths?.toRepositoryHandle(handle) ?? handle)?.file === file ||
			fromHandle(handle)?.file === file;
		const handles = hitsFor(file === undefined ? name : given).filter(inFile);
		let exact = handles.filter(named(name));
		// `src/lib/index.ts#formatAmount` names what a barrel re-exports, perhaps renamed: use its declaration.
		if (!exact.length && file !== undefined && reexport) {
			const [top, ...members] = name.split(".");
			const declared = await reexport(file, top).catch(() => undefined);
			if (declared) {
				const target = [declared.name, ...members].join(".");
				const [lookup] = await client.batch([{ type: "lookup", query: target, limit: 200 }]);
				const hits = object(object(lookup.value)?.result)?.hits;
				exact = (Array.isArray(hits) ? hits : [])
					.flatMap((hit) => {
						const id = object(hit)?.id;
						return typeof id === "string" && fromHandle(id) ? [id] : [];
					})
					.filter(
						(handle) =>
							named(target)(handle) &&
							(fromHandle(paths?.toRepositoryHandle(handle) ?? handle)?.file === declared.file ||
								fromHandle(handle)?.file === declared.file),
					);
			}
		}
		if (exact.length > 1) {
			const listed = exact.map((id) => paths?.toRepositoryHandle(id) ?? id);
			// `file#name` resolves too, and is what gets copied into the next request, so offer it where it's unique.
			const shortest = (handle: string) =>
				listed.filter((other) => withoutKind(other) === withoutKind(handle)).length > 1 ? handle : withoutKind(handle);
			resolved.set(
				given,
				new Error(`${given} is ambiguous; use a handle: ${listed.slice(0, 10).map(shortest).join(", ")}`),
			);
		} else if (!exact.length) {
			const last = name.split(".").at(-1)!;
			const candidates =
				[
					handles,
					hitsFor(name).filter(inFile),
					hitsFor(last).filter(inFile),
					hitsFor(last.slice(0, 3)).filter(inFile),
				].find((items) => items.length) ?? (hitsFor(last).length ? hitsFor(last) : hitsFor(last.slice(0, 3)));
			const nearest = candidates.filter((id) => closeName(name, fromHandle(id)!.name));
			resolved.set(
				given,
				new Error(
					`${given} not found${
						nearest.length
							? `; nearest: ${nearest
									.slice(0, 10)
									.map((id) => paths?.toRepositoryHandle(id) ?? id)
									.join(", ")}`
							: ""
					}`,
				),
			);
		} else resolved.set(given, exact[0]);
	}
	return requests.map((request, index) => {
		const copy = { ...request };
		for (const field of fields[String(request.type)] ?? []) {
			const value = copy[field];
			const entries = Array.isArray(value) ? value : [value];
			const error = entries.map((item) => resolved.get(item)).find((item) => item instanceof Error);
			if (error instanceof Error) return { error: error.message };
			if (typeof value === "string") copy[field] = resolved.get(value) ?? value;
			else if (Array.isArray(value))
				copy[field] = value.map((item) => (typeof item === "string" ? (resolved.get(item) ?? item) : item));
		}
		return settle(copy, index);
	});
}

function convertHandles(request: Record<string, unknown>, paths?: PathMapper): Record<string, unknown> {
	if (!paths) return request;
	const copy = { ...request };
	for (const field of fields[String(request.type)] ?? []) {
		const value = copy[field];
		if (typeof value === "string") copy[field] = paths.inputToProjectHandle(value);
		else if (Array.isArray(value))
			copy[field] = value.map((item) => (typeof item === "string" ? paths.inputToProjectHandle(item) : item));
	}
	return copy;
}

export async function resolveNames(
	client: GraphClient,
	requests: Record<string, unknown>[],
	paths?: PathMapper,
): Promise<Record<string, unknown>[]> {
	const settled = await resolveNamesSettled(client, requests, paths);
	return settled.map((item) => {
		if ("error" in item) throw new Error(item.error);
		return item.request;
	});
}
