/** Types for programs executed by shorthand. Type-only: this does not install runtime globals. */
import type { ShorthandGlobals } from "./prelude.ts";

declare global {
	const $: ShorthandGlobals["$"];
	const edit: ShorthandGlobals["edit"];
	const glob: ShorthandGlobals["glob"];
	const grep: ShorthandGlobals["grep"];
	const sg: ShorthandGlobals["sg"];
	const refactor: ShorthandGlobals["refactor"];
	const graph: ShorthandGlobals["graph"];
	type GraphNode = import("./prelude.ts").GraphNode;
	type GraphEdge = import("./prelude.ts").GraphEdge;
	type GraphResult = import("./prelude.ts").GraphResult;
	type SgMatch = import("./prelude.ts").SgMatch;
}

export type { GraphResult, GraphNode, GraphEdge } from "./prelude.ts";
export type { SgMatch } from "./prelude.ts";
export type { RewriteResult } from "./prelude.ts";
export type { ShorthandGlobals };
