/** Held-out fixtures for comparing editing guidance: transfer beyond the pilot tasks, not repository scale. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import type { Task } from "./task.ts";
import { assertImports } from "../verification.ts";

const load = (root: string, file: string) => import(pathToFileURL(path.join(root, file)).href);
const read = (root: string, file: string) => readFile(path.join(root, file), "utf8");
const tableBody = `    const separator = options.separator ?? ",";
    if (separator.length !== 1 || /["\\r\\n]/.test(separator)) throw new Error("Invalid separator");
    const width = rows[0]?.length ?? 0;
    const lines: string[] = [];
    for (const row of rows) {
      if (row.length !== width) throw new Error("Unequal row widths");
      const cells: string[] = [];
      for (const cell of row) {
        if (cell !== null && typeof cell !== "string" && typeof cell !== "number") throw new Error("Invalid cell");
        if (typeof cell === "number" && !Number.isFinite(cell)) throw new Error("Invalid number");
        const text = cell === null ? "" : String(cell);
        cells.push(text.includes(separator) || /["\\r\\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text);
      }
      lines.push(cells.join(separator));
    }
    return lines.join("\\r\\n");
`;
const types = `export type Cell = string | number | null;
export interface FormatOptions { separator?: string }
`;
const formatter = `import type { Cell, FormatOptions } from "./types";
export class TableWriter {
  private count = 0;
  format(rows: readonly (readonly Cell[])[], options: FormatOptions = {}): string {
${tableBody}  }
  record(rows: readonly (readonly Cell[])[], options: FormatOptions = {}) {
    const text = this.format(rows, options);
    this.count++;
    return text;
  }
  get completed() { return this.count; }
}
`;
const exportTable = `import { TableWriter } from "./writer";
import type { Cell, FormatOptions } from "./types";
export function exportTable(rows: readonly (readonly Cell[])[], options: FormatOptions = {}) {
  return new TableWriter().format(rows, options);
}
`;
const storage = `export const store = {
  save(key: string, option: boolean | { durable: boolean }) {
    return { key, durable: typeof option === "boolean" ? option : option.durable };
  }
};
`;
const saves = `import { store } from "./storage";
export const defaults = () => [store.save("a", true), store.save("b", false)];
export const dynamic = (flag: boolean) => [store.save("c", flag), store.save("d", !flag)];
export const existing = () => store.save("e", { durable: true });
export const sample = 'store.save("literal", true)';
`;
const secondary = `import { store } from "./storage";
export const extra = () => store.save(
  ["f", "g"].join(":"),
  /* retain durability */ false
);
`;
const api = `export async function readProject(id: string) { return (await fetch('/projects/' + id)).json(); }
export async function readOwner(id: string) { return (await fetch('/owners/' + id)).json(); }
`;
const view = `import { readProject, readOwner } from "./api";
export async function projectView(id: string) {
  const project = await readProject(id);
  return { project, owner: await readOwner(project.ownerId) };
}
`;

export const guidanceTasks: Task[] = [
	{
		id: "extract-table",
		category: "extraction",
		revision: "guidance-v2",
		prompt:
			"Extract TableWriter.format's formatting logic into an exported pure renderTable(rows, options?) function in table.ts. Keep the shared types and TableWriter API, delegating format to renderTable. Update exportTable to use renderTable without constructing TableWriter. Preserve quoting, separators, validation order, error messages and record/completed behavior.",
		files: { "types.ts": types, "writer.ts": formatter, "export.ts": exportTable },
		solution: {
			"table.ts":
				'import type { Cell, FormatOptions } from "./types";\nexport function renderTable(rows: readonly (readonly Cell[])[], options: FormatOptions = {}): string {\n' +
				tableBody +
				"}\n",
			"writer.ts":
				'import { renderTable } from "./table";\n' +
				formatter.replace(tableBody, "    return renderTable(rows, options);\n"),
			"export.ts": exportTable
				.replace('import { TableWriter } from "./writer";', 'import { renderTable } from "./table";')
				.replace("new TableWriter().format(rows, options)", "renderTable(rows, options)"),
		},
		async verify(root) {
			const { renderTable } = await load(root, "table.ts");
			const { TableWriter } = await load(root, "writer.ts");
			const { exportTable: exported } = await load(root, "export.ts");
			await assertImports(root, "writer.ts", "table.ts");
			await assertImports(root, "export.ts", "table.ts");
			const writerSource = await read(root, "writer.ts");
			const method = parse(Lang.TypeScript, writerSource)
				.root()
				.find({ rule: { kind: "method_definition", has: { field: "name", regex: "^format$" } } });
			assert.ok(method && method.text().includes("renderTable"));
			assert.equal(method.findAll({ rule: { kind: "for_in_statement" } }).length, 0);
			assert.ok(!(await read(root, "export.ts")).includes("new TableWriter"));
			for (const [rows, options, expected] of [
				[[], {}, ""],
				[[[]], {}, ""],
				[
					[
						[1, null],
						["a,b", 'x"y'],
					],
					{},
					'1,\r\n"a,b","x""y"',
				],
				[[["a;b", "x\ny"]], { separator: ";" }, '"a;b";"x\ny"'],
				[
					[
						["x", "y"],
						["z", 3],
					],
					{ separator: "|" },
					"x|y\r\nz|3",
				],
			] as const) {
				const instance = new TableWriter();
				assert.equal(renderTable(rows, options), expected);
				assert.equal(exported(rows, options), expected);
				assert.equal(instance.format(rows, options), expected);
				assert.equal(instance.completed, 0);
				assert.equal(instance.record(rows, options), expected);
				assert.equal(instance.record(rows, options), expected);
				assert.equal(instance.completed, 2);
			}
			for (const [rows, options, message] of [
				[[[Infinity], [1, 2]], { separator: "" }, "Invalid separator"],
				[[[1], [1, 2]], {}, "Unequal row widths"],
				[[[Infinity]], {}, "Invalid number"],
				[[[{}]], {}, "Invalid cell"],
			] as const) {
				assert.throws(() => renderTable(rows, options), { message });
				const instance = new TableWriter();
				assert.throws(() => instance.record(rows, options), { message });
				assert.equal(instance.completed, 0);
			}
		},
	},
	{
		id: "durability-options",
		category: "migration",
		revision: "guidance-v2",
		prompt:
			"Migrate every store.save(key, booleanLiteral) call to pass an options object with a durable property as its second argument. Leave dynamic expressions, existing options objects and string contents unchanged. Preserve behavior and existing comments.",
		files: { "storage.ts": storage, "saves.ts": saves, "secondary.ts": secondary },
		solution: {
			"saves.ts": saves
				.replace('store.save("a", true)', 'store.save("a", { durable: true })')
				.replace('store.save("b", false)', 'store.save("b", { durable: false })'),
			"secondary.ts": secondary.replace("/* retain durability */ false", "/* retain durability */ { durable: false }"),
		},
		async verify(root) {
			const a = await load(root, "saves.ts");
			const b = await load(root, "secondary.ts");
			assert.deepEqual(a.defaults(), [
				{ key: "a", durable: true },
				{ key: "b", durable: false },
			]);
			for (const flag of [true, false])
				assert.deepEqual(a.dynamic(flag), [
					{ key: "c", durable: flag },
					{ key: "d", durable: !flag },
				]);
			assert.deepEqual(a.existing(), { key: "e", durable: true });
			assert.deepEqual(b.extra(), { key: "f:g", durable: false });
			assert.equal(a.sample, 'store.save("literal", true)');
			assert.ok((await read(root, "secondary.ts")).includes("/* retain durability */"));
			for (const file of ["saves.ts", "secondary.ts"]) {
				const tree = parse(Lang.TypeScript, await read(root, file)).root();
				for (const call of tree.findAll("store.save($KEY, $OPTION)")) {
					const kind = call.getMatch("OPTION")!.kind();
					assert.ok(kind !== "true" && kind !== "false");
				}
			}
			const tree = parse(Lang.TypeScript, await read(root, "saves.ts")).root();
			for (const expression of [
				'store.save("c", flag)',
				'store.save("d", !flag)',
				'store.save("e", { durable: true })',
			])
				assert.equal(tree.findAll(expression).length, 1);
		},
	},
	{
		id: "request-headers",
		category: "propagation",
		revision: "guidance-v2",
		prompt:
			"Add an optional HeadersInit parameter to readProject, readOwner and projectView, and forward it through every request. A projectView call must use the same headers value for both requests. Existing callers without headers and existing return values must keep working. Request failures must propagate unchanged.",
		files: { "api.ts": api, "view.ts": view },
		solution: {
			"api.ts": api
				.replaceAll("id: string)", "id: string, headers?: HeadersInit)")
				.replaceAll(" + id)", " + id, { headers })"),
			"view.ts": view
				.replace("id: string)", "id: string, headers?: HeadersInit)")
				.replace("readProject(id)", "readProject(id, headers)")
				.replace("readOwner(project.ownerId)", "readOwner(project.ownerId, headers)"),
		},
		async verify(root) {
			const client = await load(root, "api.ts");
			const { projectView } = await load(root, "view.ts");
			const original = globalThis.fetch;
			const calls: Array<{ url: string; headers: unknown }> = [];
			const failure = new Error("network failure");
			let failAt = 0;
			try {
				globalThis.fetch = (async (url: string, init?: RequestInit) => {
					calls.push({ url, headers: init?.headers });
					if (calls.length === failAt) throw failure;
					return { json: async () => (url.startsWith("/projects/") ? { ownerId: "u" } : { name: "owner" }) };
				}) as unknown as typeof fetch;
				for (const headers of [
					undefined,
					{ "x-token": "test" },
					new Headers({ "x-token": "test" }),
					[["x-token", "test"]],
				]) {
					calls.length = 0;
					assert.deepEqual(await projectView("p", headers), { project: { ownerId: "u" }, owner: { name: "owner" } });
					assert.deepEqual(
						calls.map((c) => c.url),
						["/projects/p", "/owners/u"],
					);
					for (const c of calls) assert.equal(c.headers, headers);
					calls.length = 0;
					await client.readProject("q", headers);
					await client.readOwner("v", headers);
					assert.deepEqual(
						calls.map((c) => c.url),
						["/projects/q", "/owners/v"],
					);
					for (const c of calls) assert.equal(c.headers, headers);
				}
				for (failAt of [1, 2]) {
					calls.length = 0;
					await assert.rejects(
						() => projectView("p"),
						(error: unknown) => error === failure,
					);
					assert.equal(calls.length, failAt);
				}
			} finally {
				globalThis.fetch = original;
			}
		},
	},
];
