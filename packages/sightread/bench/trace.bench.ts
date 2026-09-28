// Time warm reverse traces from a widely used helper, through the daemon the CLI uses.
//
// Run with `bun packages/sightread/bench/trace.bench.ts [runs]`. The generated project has the shape
// from issue #37: a small helper called from about 200 components, each used by a page, each page used
// by an app, and enough other files to make the graph's per-request freshness check realistic.
//
// Medians of 3 on an Apple Silicon Mac, @ttsc/graph 0.30.4, 2026-09-28:
//
// | Trace         | One trace per symbol    | One details per level |
// | ------------- | ----------------------- | --------------------- |
// | default depth | 6.91s, 242 symbols      | 0.18s, 201 (direct users; the start is a hub) |
// | maxDepth 2    | 5.82s, 241 symbols      | 0.23s, 241 symbols    |
// | maxDepth 1    | 0.14s, 201 symbols      | 0.12s, 201 symbols    |
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect, stopServer } from "../src/server/client.ts";

const runs = Number(process.argv[2]) || 3;
const components = 40;
const perFile = 5;
const filler = 1200;

const root = mkdtempSync(join(tmpdir(), "sightread-bench-"));
const put = (path: string, contents: string) => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), contents);
};
put("tsconfig.json", '{"compilerOptions":{"strict":true},"include":["src"]}');
put(
	"src/lib/cx.ts",
	"export function cx(...names: Array<string | false>) { return names.filter(Boolean).join(' '); }\n",
);
for (let file = 0; file < components; file++) {
	const names = Array.from({ length: perFile }, (_, index) => `Part${file}_${index}`);
	put(
		`src/components/part${file}.ts`,
		`import { cx } from "../lib/cx";\n${names.map((name) => `export function ${name}(on: boolean) { return cx("${name}", on && "on"); }`).join("\n")}\n`,
	);
	put(
		`src/pages/page${file}.ts`,
		`import { ${names.join(", ")} } from "../components/part${file}";\nexport function page${file}() { return [${names.map((name) => `${name}(true)`).join(", ")}]; }\n`,
	);
}
put(
	"src/app.ts",
	`${Array.from({ length: components }, (_, file) => `import { page${file} } from "./pages/page${file}";`).join("\n")}\nexport function app() { return [${Array.from({ length: components }, (_, file) => `page${file}()`).join(", ")}]; }\n`,
);
for (let file = 0; file < filler; file++)
	put(
		`src/filler/f${file}.ts`,
		`export interface Shape${file} { id: string; size: number }\nexport function make${file}(id: string): Shape${file} { return { id, size: id.length }; }\n`,
	);

const project = { root, tsconfig: join(root, "tsconfig.json") };
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
try {
	let started = performance.now();
	const server = await connect(project);
	await server.query([{ type: "overview" }], { mode: "json" });
	console.log(`cold start and overview: ${((performance.now() - started) / 1000).toFixed(1)}s`);
	for (const [label, request] of [
		["reverse trace, default depth", {}],
		["reverse trace, maxDepth 2", { maxDepth: 2 }],
		["reverse trace, maxDepth 1", { maxDepth: 1 }],
	] as const) {
		const times: number[] = [];
		let shown = 0;
		for (let run = 0; run < runs; run++) {
			started = performance.now();
			const [result] = JSON.parse(
				await server.query([{ type: "trace", from: "cx", direction: "reverse", ...request }], { mode: "json" }),
			) as Array<{ nodes: unknown[]; note?: string }>;
			times.push(performance.now() - started);
			shown = result.nodes.length;
		}
		console.log(`${label}: ${(median(times) / 1000).toFixed(2)}s median of ${runs}, ${shown} symbols`);
	}
} finally {
	await stopServer(project);
	rmSync(root, { recursive: true, force: true });
}
