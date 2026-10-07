import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";
import { Lang, parse } from "@ast-grep/napi";
import { file, move, moveDeclaration, remember, type MoveFiles } from "../src/refactor/placement.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "shorthand-move-imports-")));
	roots.push(root);
	const all = {
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				strict: true,
				module: "ESNext",
				moduleResolution: "bundler",
				noEmit: true,
				paths: { "@app/*": ["./src/*"] },
			},
			include: ["src"],
		}),
		...files,
	};
	for (const [path, text] of Object.entries(all)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

function declaration(root: string, path: string, pattern: string) {
	const absolute = join(root, path);
	const source = readFileSync(absolute, "utf8");
	const node = parse(Lang.TypeScript, source).root().find(pattern)!;
	expect(node).not.toBeNull();
	// The statement, including any `export` keyword around the declaration.
	const statement = node.parent()?.kind() === "export_statement" ? node.parent()! : node;
	return remember({ file: absolute, text: statement.text(), node: statement }, source);
}

/** Every source file under src, as a stand-in for Git's listings and searches. */
const everyFile = (root: string): MoveFiles => {
	const all = () =>
		(readdirSync(join(root, "src"), { recursive: true }) as string[])
			.filter((path) => path.endsWith(".ts"))
			.map((path) => resolve(root, "src", path));
	return { root, scripts: all, loadingModules: all, reexportingAll: all };
};

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

/**
 * The error a move rejects with. Awaited directly: Bun's `expect(promise).rejects` services the TypeScript
 * API's pipe only about once a second, which makes each request take that long.
 */
const rejection = (moving: Promise<void>) =>
	moving.then(
		() => undefined,
		(error: unknown) => error,
	);

async function typeCheck(root: string) {
	const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
	const result = await $`${tsc} -p ${join(root, "tsconfig.json")}`.nothrow().quiet();
	expect(result.stdout.toString() + result.stderr.toString()).toBe("");
	expect(result.exitCode).toBe(0);
}

test("moving a declaration updates its dependencies, the source and every kind of importer", async () => {
	const root = project({
		"src/lib/util.ts": "export const helper = (n: number) => n + 1;\n",
		"src/types.ts": "export type Shape = { kind: string };\n",
		"src/a.ts": [
			'import { helper } from "./lib/util";',
			'import type { Shape } from "./types";',
			"const scale = 2;",
			"type Local = { n: number };",
			"export function moveMe(n: number, shape: Shape): Local {",
			"\treturn { n: helper(n) * scale + shape.kind.length };",
			"}",
			'export const other = moveMe(1, { kind: "x" });',
			"",
		].join("\n"),
		"src/b.ts": 'import { moveMe, other } from "./a";\nexport const b = moveMe(2, { kind: "b" }).n + other.n;\n',
		"src/c.ts": 'import { moveMe as m } from "./a";\nexport const c = m(3, { kind: "c" });\n',
		"src/d.ts": 'export { moveMe } from "./a";\n',
		"src/index.ts": 'export * from "./a";\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/moved/target.ts"), everyFile(root));

	expect(read(root, "src/moved/target.ts")).toBe(
		[
			'import { helper } from "../lib/util";',
			'import type { Shape } from "../types";',
			'import { scale, type Local } from "../a";',
			"export function moveMe(n: number, shape: Shape): Local {",
			"\treturn { n: helper(n) * scale + shape.kind.length };",
			"}",
			"",
		].join("\n"),
	);
	expect(read(root, "src/a.ts")).toContain('import { moveMe } from "./moved/target";');
	expect(read(root, "src/a.ts")).toContain("export const scale = 2;");
	expect(read(root, "src/a.ts")).toContain("export type Local = { n: number };");
	expect(read(root, "src/a.ts")).not.toContain("function moveMe");
	expect(read(root, "src/b.ts")).toBe(
		'import { other } from "./a";\nimport { moveMe } from "./moved/target";\nexport const b = moveMe(2, { kind: "b" }).n + other.n;\n',
	);
	expect(read(root, "src/c.ts")).toContain('import { moveMe as m } from "./moved/target";');
	expect(read(root, "src/c.ts")).not.toContain('from "./a"');
	expect(read(root, "src/d.ts")).toContain('export { moveMe } from "./moved/target";');
	expect(read(root, "src/d.ts")).not.toContain('from "./a"');
	expect(read(root, "src/index.ts")).toBe('export * from "./a";\nexport { moveMe } from "./moved/target";\n');
	await typeCheck(root);
});

test("new specifiers keep each file's .js style and quotes, and a moved type stays type-only", async () => {
	const root = project({
		"src/shapes.ts": "export interface Shape { kind: string }\nexport const unit = 1;\n",
		"src/use.ts": "import type { Shape } from './shapes.js';\nexport const s: Shape = { kind: 'x' };\n",
		"src/target.ts": "import { unit } from './shapes.js';\nexport const u = unit;\n",
	});

	await moveDeclaration(join(root, "src/shapes.ts"), "Shape", join(root, "src/target.ts"), everyFile(root));

	expect(read(root, "src/use.ts")).toBe(
		"import type { Shape } from './target.js';\nexport const s: Shape = { kind: 'x' };\n",
	);
	expect(read(root, "src/target.ts")).toContain("export interface Shape { kind: string }");
	expect(read(root, "src/shapes.ts").trim()).toBe("export const unit = 1;");
	await typeCheck(root);
});

test("a declaration the target already imports from the source becomes local there", async () => {
	const root = project({
		"src/a.ts": "export const limit = 3;\nexport const other = 1;\n",
		"src/target.ts": 'import { limit, other } from "./a";\nexport const both = () => limit + other;\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "limit", join(root, "src/target.ts"), everyFile(root));

	expect(read(root, "src/target.ts")).toBe(
		'import { other } from "./a";\nexport const limit = 3;\nexport const both = () => limit + other;\n',
	);
	await typeCheck(root);
});

test.each([
	["a default export", { "src/a.ts": "export default function moveMe() {}\n" }, "moveMe", "default export"],
	[
		"overloads",
		{ "src/a.ts": "export function moveMe(a: string): string;\nexport function moveMe(a: string) { return a; }\n" },
		"moveMe",
		"overloads or merged declarations",
	],
	["a local export list", { "src/a.ts": "function moveMe() {}\nexport { moveMe };\n" }, "moveMe", "export list"],
	[
		"a namespace import that uses it",
		{
			"src/a.ts": "export function moveMe() {}\n",
			"src/b.ts": 'import * as a from "./a";\na.moveMe();\n',
		},
		"moveMe",
		"namespace import",
	],
	[
		"a destructured namespace import",
		{
			"src/a.ts": "export function moveMe() {}\n",
			"src/b.ts": 'import * as a from "./a";\nconst { moveMe } = a;\nmoveMe();\n',
		},
		"moveMe",
		"namespace import",
	],
	[
		"a namespace import indexed by a string",
		{
			"src/a.ts": "export function moveMe() {}\n",
			"src/b.ts": 'import * as a from "./a";\na["moveMe"]();\n',
		},
		"moveMe",
		"namespace import",
	],
	[
		"a dynamic import of the source",
		{
			"src/a.ts": "export function moveMe() {}\n",
			"src/b.ts": 'export const lazy = () => import("./a").then((a) => a.moveMe);\n',
		},
		"moveMe",
		"import()",
	],
	[
		"a namespace re-export of the source",
		{ "src/a.ts": "export function moveMe() {}\n", "src/b.ts": 'export * as a from "./a";\n' },
		"moveMe",
		"as a namespace",
	],
	[
		"a dynamic import in a file that never names it",
		{
			"src/a.ts": "export function moveMe() {}\n",
			"src/b.ts": 'export const load = () => import("./a");\n',
		},
		"moveMe",
		"import()",
	],
	[
		"a target with its own declaration of that name",
		{ "src/a.ts": "export function moveMe() {}\n", "src/target.ts": "export const moveMe = 1;\n" },
		"moveMe",
		"already declares moveMe",
	],
	[
		"a global the target shadows",
		{ "src/a.ts": "export const read = () => fetch;\n", "src/target.ts": "export const fetch = 1;\n" },
		"read",
		"fetch is a global",
	],
])("refuses %s before writing anything", async (_, files, symbol, message) => {
	const root = project({ "src/target.ts": "export {};\n", ...files });
	const before = Object.fromEntries(Object.keys(files).map((path) => [path, read(root, path)]));
	const targetBefore = read(root, "src/target.ts");
	const error = await rejection(
		moveDeclaration(join(root, "src/a.ts"), symbol, join(root, "src/target.ts"), everyFile(root)),
	);
	expect(String(error)).toContain(message);
	for (const [path, text] of Object.entries(before)) expect(read(root, path)).toBe(text);
	expect(read(root, "src/target.ts")).toBe(targetBefore);
});

test("importers through a tsconfig path alias keep using the alias", async () => {
	const root = project({
		"src/api.ts": "export function parseUser(name: string) { return { name }; }\n",
		"src/app.ts": 'import { parseUser } from "@app/api";\nexport const user = parseUser("Ada");\n',
	});

	await moveDeclaration(join(root, "src/api.ts"), "parseUser", join(root, "src/users/parse.ts"), everyFile(root));

	expect(read(root, "src/app.ts")).toBe(
		'import { parseUser } from "@app/users/parse";\nexport const user = parseUser("Ada");\n',
	);
	await typeCheck(root);
});

test("a declaration the source still uses is exported from the target", async () => {
	const root = project({ "src/a.ts": "const limit = 3;\nexport const twice = limit * 2;\n" });

	await moveDeclaration(join(root, "src/a.ts"), "limit", join(root, "src/limits.ts"), everyFile(root));

	expect(read(root, "src/limits.ts")).toBe("export const limit = 3;\n");
	expect(read(root, "src/a.ts")).toContain('import { limit } from "./limits";');
	await typeCheck(root);
});

test("a nested local that shares an import's name does not hide the import's other uses", async () => {
	const root = project({
		"src/util.ts": "export const helper = (n: number) => n + 1;\n",
		"src/a.ts":
			'import { helper } from "./util";\nexport function run(n: number) {\n\tconst inner = () => { const helper = 0; return helper; };\n\treturn helper(n) + inner();\n}\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "run", join(root, "src/run.ts"), everyFile(root));

	expect(read(root, "src/run.ts")).toStartWith('import { helper } from "./util";\n');
	await typeCheck(root);
});

test("a barrel that re-exports the source wholesale also re-exports the moved declaration", async () => {
	const root = project({
		"src/a.ts": "export function moveMe() { return 1; }\nexport const other = 2;\n",
		"src/barrel.ts": 'export * from "./a";\n',
		"src/use.ts": 'import { moveMe as mm, other } from "./barrel";\nexport const u = mm() + other;\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/moved.ts"), everyFile(root));

	expect(read(root, "src/barrel.ts")).toBe('export * from "./a";\nexport { moveMe } from "./moved";\n');
	expect(read(root, "src/use.ts")).toBe(
		'import { moveMe as mm, other } from "./barrel";\nexport const u = mm() + other;\n',
	);
	await typeCheck(root);
});

test("dependencies follow TypeScript's scoping: hoisted vars, shorthand properties and shadowed imports", async () => {
	const root = project({
		"src/util.ts": "export const helper = (n: number) => n + 1;\nexport const scale = 2;\n",
		"src/a.ts": [
			'import { helper, scale } from "./util";',
			"export function run(n: number) {",
			"\tfor (var i = 0; i < 1; i++) { var last: number | undefined = i; }",
			"\tconst shadow = () => { const scale = 0; return scale; };",
			"\tconst o = { helper };",
			"\treturn o.helper(n) + (last ?? 0) + shadow();",
			"}",
			"",
		].join("\n"),
	});

	await moveDeclaration(join(root, "src/a.ts"), "run", join(root, "src/run.ts"), everyFile(root));

	expect(read(root, "src/run.ts")).toStartWith('import { helper } from "./util";\nexport function run');
	await typeCheck(root);
});

test("a file only a different, same-named symbol appears in is left alone", async () => {
	const root = project({
		"src/a.ts": "export function moveMe() { return 1; }\n",
		"src/b.ts": 'import { moveMe } from "./a";\nexport const b = moveMe();\n',
		"src/other.ts": 'import * as a from "./a";\nfunction moveMe() { return a; }\nexport const o = moveMe();\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/moved.ts"), everyFile(root));

	expect(read(root, "src/b.ts")).toBe('import { moveMe } from "./moved";\nexport const b = moveMe();\n');
	expect(read(root, "src/other.ts")).toBe(
		'import * as a from "./a";\nfunction moveMe() { return a; }\nexport const o = moveMe();\n',
	);
});

test("importers in another TypeScript project are updated too", async () => {
	const root = project({
		"src/a.ts": "export function moveMe() { return 1; }\n",
		"app/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["."] }),
		"app/main.ts": 'import { moveMe } from "../src/a";\nexport const m = moveMe();\n',
	});
	const files = everyFile(root);
	const scripts = () => [...files.scripts(), join(root, "app/main.ts")];

	await moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/moved.ts"), { ...files, scripts });

	expect(read(root, "app/main.ts")).toBe('import { moveMe } from "../src/moved";\nexport const m = moveMe();\n');
});

test("a destructuring declaration's importers and remaining uses are updated", async () => {
	const root = project({
		"src/a.ts": "export const { moveMe } = { moveMe: 1 };\nexport const val = moveMe;\n",
		"src/use.ts": 'import { moveMe } from "./a";\nexport const u = moveMe;\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/moved.ts"), everyFile(root));

	expect(read(root, "src/a.ts")).toContain('import { moveMe } from "./moved";');
	expect(read(root, "src/use.ts")).toBe('import { moveMe } from "./moved";\nexport const u = moveMe;\n');
	await typeCheck(root);
});

test("specifiers are relative to the real files when the repository is reached through a symlink", async () => {
	const real = project({
		"src/util.ts": "export const helper = () => 1;\n",
		"src/a.ts": 'import { helper } from "./util";\nexport function moveMe() { return helper(); }\n',
		"src/b.ts": 'import { moveMe } from "./a";\nexport const b = moveMe();\n',
	});
	const root = `${real}-link`;
	symlinkSync(real, root);
	roots.push(root);

	await moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/lib/moved.ts"), everyFile(root));

	expect(read(real, "src/lib/moved.ts")).toStartWith('import { helper } from "../util";\n');
	expect(read(real, "src/b.ts")).toBe('import { moveMe } from "./lib/moved";\nexport const b = moveMe();\n');
	await typeCheck(real);
});

test("imports only the moved declaration used leave the source with it", async () => {
	const root = project({
		"src/locale.ts": 'export const LOCALE = "en";\nexport const REGION = "GB";\n',
		"src/util.ts": "export const helper = (n: number) => n + 1;\n",
		"src/types.ts": "export type Shape = { kind: string };\n",
		"src/a.ts": [
			'import { LOCALE, REGION } from "./locale";',
			'import { helper } from "./util";',
			'import type { Shape } from "./types";',
			"",
			"export function moveMe(s: Shape) {",
			"\treturn LOCALE + helper(1) + s.kind;",
			"}",
			"export const region = REGION;",
			"export function other() {",
			"\tconst helper = 2;",
			"\treturn helper;",
			"}",
			'export const keep = moveMe({ kind: "k" });',
			"",
		].join("\n"),
	});

	await moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/moved.ts"), everyFile(root));

	expect(read(root, "src/a.ts")).toBe(
		[
			'import { REGION } from "./locale";',
			'import { moveMe } from "./moved";',
			"",
			"export const region = REGION;",
			"export function other() {",
			"\tconst helper = 2;",
			"\treturn helper;",
			"}",
			'export const keep = moveMe({ kind: "k" });',
			"",
		].join("\n"),
	);
	await typeCheck(root);
});

test("comments inside import lists don't stop a move", async () => {
	const root = project({
		"src/dep.ts": "export const a = 1;\nexport const b = 2;\n",
		"src/m.ts":
			'import {\n\ta, // first\n\tb,\n} from "./dep";\nexport function f() {\n\treturn a;\n}\nexport const g = b;\n',
		"src/use.ts": 'import {\n\tf, // the function\n\tg,\n} from "./m";\nexport const r = f() + g;\n',
	});

	await moveDeclaration(join(root, "src/m.ts"), "f", join(root, "src/n.ts"), everyFile(root));

	expect(read(root, "src/n.ts")).toBe('import { a } from "./dep";\nexport function f() {\n\treturn a;\n}\n');
	expect(read(root, "src/use.ts")).toContain('import { f } from "./n";');
	await typeCheck(root);
});

test("moved code keeps its dollar signs when the target has to export it", async () => {
	const root = project({
		"src/price.ts":
			'function format(a: number) {\n\treturn `$${a.toFixed(2)}` + "$&";\n}\nexport function label(a: number) {\n\treturn format(a);\n}\n',
	});

	await moveDeclaration(join(root, "src/price.ts"), "format", join(root, "src/format.ts"), everyFile(root));

	expect(read(root, "src/format.ts")).toBe(
		'export function format(a: number) {\n\treturn `$${a.toFixed(2)}` + "$&";\n}\n',
	);
	await typeCheck(root);
});

test("a default export elsewhere in either file doesn't stop a move, but moving one is refused", async () => {
	const root = project({
		"src/app.ts":
			"export function helper(n: number) {\n\treturn n + 1;\n}\nexport default function App() {\n\treturn helper(1);\n}\n",
		"src/util.ts": "export default class Other {}\n",
	});

	await moveDeclaration(join(root, "src/app.ts"), "helper", join(root, "src/util.ts"), everyFile(root));
	expect(read(root, "src/util.ts")).toContain("export function helper");
	await typeCheck(root);
	expect(
		String(
			await rejection(moveDeclaration(join(root, "src/app.ts"), "App", join(root, "src/util.ts"), everyFile(root))),
		),
	).toContain("moving a default export is not supported yet");
});

test("moving into the module a declaration imports from uses that module's own declaration", async () => {
	const root = project({
		"src/b.ts": "export function helperB() {\n\treturn 1;\n}\n",
		"src/a.ts": 'import { helperB } from "./b";\nexport function f() {\n\treturn helperB();\n}\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "f", join(root, "src/b.ts"), everyFile(root));

	expect(read(root, "src/b.ts")).toBe(
		"export function helperB() {\n\treturn 1;\n}\nexport function f() {\n\treturn helperB();\n}\n",
	);
	await typeCheck(root);
});

test("a target that re-exports the moved declaration from the source now exports its own", async () => {
	const root = project({
		"src/a.ts": "export function moved() {\n\treturn 1;\n}\nexport const keep = 2;\n",
		"src/index.ts": 'export { moved, keep } from "./a";\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "moved", join(root, "src/index.ts"), everyFile(root));

	expect(read(root, "src/index.ts")).toBe('export { keep } from "./a";\nexport function moved() {\n\treturn 1;\n}\n');
	await typeCheck(root);
});

test("a dependency the source exports through an export list isn't exported twice", async () => {
	const root = project({
		"src/a.ts": "const helper = () => 1;\nexport function moved() {\n\treturn helper();\n}\nexport { helper };\n",
	});

	await moveDeclaration(join(root, "src/a.ts"), "moved", join(root, "src/b.ts"), everyFile(root));

	expect(read(root, "src/a.ts")).toBe("const helper = () => 1;\nexport { helper };\n");
	await typeCheck(root);
});

test("a move that would leave a module variable assigned through an import is refused", async () => {
	const root = project({
		"src/a.ts": [
			"export let count = 0;",
			"export function bump() {",
			"\tcount++;",
			"}",
			"let cache: string | undefined;",
			"export function load() {",
			'\treturn (cache ??= "x");',
			"}",
			"export function local() {",
			"\tlet count = 1;",
			"\tcount++;",
			"\treturn count;",
			"}",
			"",
		].join("\n"),
	});

	for (const [symbol, message] of [
		["bump", "it assigns count"],
		["load", "it assigns cache"],
		["count", "count is assigned elsewhere"],
	])
		expect(
			String(await rejection(moveDeclaration(join(root, "src/a.ts"), symbol, join(root, "src/b.ts"), everyFile(root)))),
		).toContain(message);
	await moveDeclaration(join(root, "src/a.ts"), "local", join(root, "src/b.ts"), everyFile(root));
	await typeCheck(root);
});

test("an import added where the source's first statement gains export doesn't join the two", async () => {
	const root = project({
		"src/a.ts": "const base = 10;\nexport const limit = base * 2;\nexport const doubled = limit * 2;\n",
	});

	await moveDeclaration(join(root, "src/a.ts"), "limit", join(root, "src/limit.ts"), everyFile(root));

	expect(read(root, "src/a.ts")).toBe(
		'import { limit } from "./limit";\nexport const base = 10;\nexport const doubled = limit * 2;\n',
	);
	await typeCheck(root);
});

test("a declaration moved into a file that uses it goes before its first use there", async () => {
	const root = project({
		"src/a.ts": "export const LIMIT = 5;\nexport class Base {}\n",
		"src/b.ts":
			'import { LIMIT, Base } from "./a";\nexport const doubled = LIMIT * 2;\nexport class Child extends Base {}\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "LIMIT", join(root, "src/b.ts"), everyFile(root));
	await moveDeclaration(join(root, "src/a.ts"), "Base", join(root, "src/b.ts"), everyFile(root));

	expect(read(root, "src/b.ts")).toBe(
		"export const LIMIT = 5;\nexport const doubled = LIMIT * 2;\nexport class Base {}\nexport class Child extends Base {}\n",
	);
	await typeCheck(root);
});

test("a dependency that is the source's default export is imported as one", async () => {
	const root = project({
		"src/a.ts":
			"export default function helper() {\n\treturn 1;\n}\nexport function foo() {\n\treturn helper() + 1;\n}\n",
	});

	await moveDeclaration(join(root, "src/a.ts"), "foo", join(root, "src/b.ts"), everyFile(root));

	expect(read(root, "src/b.ts")).toBe(
		'import helper from "./a";\nexport function foo() {\n\treturn helper() + 1;\n}\n',
	);
	await typeCheck(root);
});

test("an overloaded dependency is exported on every signature", async () => {
	const root = project({
		"src/a.ts": [
			"function fmt(x: string): string;",
			"function fmt(x: number): string;",
			"function fmt(x: string | number) {",
			"\treturn String(x);",
			"}",
			"export function foo() {",
			'\treturn fmt(1) + fmt("a");',
			"}",
			"export const keep = fmt(2);",
			"",
		].join("\n"),
	});

	await moveDeclaration(join(root, "src/a.ts"), "foo", join(root, "src/b.ts"), everyFile(root));

	expect(read(root, "src/a.ts")).toStartWith(
		"export function fmt(x: string): string;\nexport function fmt(x: number): string;\nexport function fmt(",
	);
	await typeCheck(root);
});

test("the moved code's own relative paths are repointed", async () => {
	const root = project({
		"src/heavy.ts": "export interface Runner {\n\trun(): void;\n}\nexport const r: Runner = { run() {} };\n",
		"src/a.ts":
			'export type Run = import("./heavy").Runner;\nexport async function load() {\n\tconst m = await import("./heavy");\n\treturn m.r;\n}\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "load", join(root, "src/lib/b.ts"), everyFile(root));
	await moveDeclaration(join(root, "src/a.ts"), "Run", join(root, "src/lib/b.ts"), everyFile(root));

	expect(read(root, "src/lib/b.ts")).toBe(
		'export async function load() {\n\tconst m = await import("../heavy");\n\treturn m.r;\n}\nexport type Run = import("../heavy").Runner;\n',
	);
	await typeCheck(root);
});

test("a dependency declared as a namespace or with declare is refused rather than treated as a global", async () => {
	const root = project({
		"src/a.ts":
			"namespace Utils {\n\texport const x = 1;\n}\ndeclare const VERSION: string;\nexport function f() {\n\treturn Utils.x;\n}\nexport function g() {\n\treturn VERSION;\n}\n",
	});

	for (const [symbol, name] of [
		["f", "Utils"],
		["g", "VERSION"],
	])
		expect(
			String(await rejection(moveDeclaration(join(root, "src/a.ts"), symbol, join(root, "src/b.ts"), everyFile(root)))),
		).toContain(`it uses ${name}, which`);
});

test("a file with no relative imports gets the .js specifiers NodeNext resolution needs", async () => {
	const root = project({
		"tsconfig.json": JSON.stringify({
			compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext", noEmit: true, types: [] },
			include: ["src"],
		}),
		"package.json": '{ "type": "module" }',
		"src/util/a.ts":
			'export function load(p: string) {\n\treturn p.length;\n}\nexport function keep() {\n\treturn load("x");\n}\n',
		"src/main.ts": 'import { load } from "./util/a.js";\nexport const n = load("y");\n',
	});

	await moveDeclaration(join(root, "src/util/a.ts"), "load", join(root, "src/io/load.ts"), everyFile(root));

	expect(read(root, "src/util/a.ts")).toStartWith('import { load } from "../io/load.js";\n');
	expect(read(root, "src/main.ts")).toStartWith('import { load } from "./io/load.js";\n');
	await typeCheck(root);
});

test("moving into the file that imports it, when that needs a new import, puts it after the imports that stay", async () => {
	const root = project({
		"src/a.ts":
			"export function helper(n: number) {\n\treturn n * 2;\n}\nexport function run(n: number) {\n\treturn helper(n) + 1;\n}\n",
		"src/b.ts": 'import { run } from "./a";\nexport const x = run(1);\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "run", join(root, "src/b.ts"), everyFile(root));

	expect(read(root, "src/b.ts")).toBe(
		'import { helper } from "./a";\nexport function run(n: number) {\n\treturn helper(n) + 1;\n}\nexport const x = run(1);\n',
	);
	await typeCheck(root);
});

test("a dependency exported under another name is imported by that name", async () => {
	for (const [alias, line] of [
		["double", 'import { double as helper } from "./a";'],
		["default", 'import helper from "./a";'],
	]) {
		const root = project({
			"src/a.ts": `function helper(n: number) {\n\treturn n * 2;\n}\nexport { helper as ${alias} };\nexport function run(n: number) {\n\treturn helper(n) + 1;\n}\n`,
		});
		await moveDeclaration(join(root, "src/a.ts"), "run", join(root, "src/b.ts"), everyFile(root));
		expect(read(root, "src/b.ts")).toStartWith(line);
		await typeCheck(root);
	}
});

test("a shorthand use in the target counts as a use, and the moved code goes after what it needs there", async () => {
	const root = project({
		"src/constants.ts": "export const LIMIT = 10;\nexport const TIMEOUT = 5;\n",
		"src/config.ts": 'import { LIMIT, TIMEOUT } from "./constants";\nexport const config = { LIMIT, TIMEOUT };\n',
		"src/target.ts":
			'import { SCALED } from "./source";\nexport function describe() {\n\treturn SCALED;\n}\nexport const BASE = 10;\n',
		"src/source.ts": 'import { BASE } from "./target";\nexport const SCALED = BASE * 2;\n',
		"src/eager.ts": 'import { EAGER } from "./early";\nexport const doubled = EAGER * 2;\nexport const BASE2 = 10;\n',
		"src/early.ts": 'import { BASE2 } from "./eager";\nexport const EAGER = BASE2 * 2;\n',
	});

	await moveDeclaration(join(root, "src/constants.ts"), "LIMIT", join(root, "src/config.ts"), everyFile(root));
	await moveDeclaration(join(root, "src/source.ts"), "SCALED", join(root, "src/target.ts"), everyFile(root));

	expect(read(root, "src/config.ts")).toBe(
		'import { TIMEOUT } from "./constants";\nexport const LIMIT = 10;\nexport const config = { LIMIT, TIMEOUT };\n',
	);
	expect(read(root, "src/target.ts")).toBe(
		"export function describe() {\n\treturn SCALED;\n}\nexport const BASE = 10;\nexport const SCALED = BASE * 2;\n",
	);
	expect(
		String(
			await rejection(
				moveDeclaration(join(root, "src/early.ts"), "EAGER", join(root, "src/eager.ts"), everyFile(root)),
			),
		),
	).toContain("uses it as the file loads");
});

test("a target's type-only import of something the moved code uses as a value becomes a value import", async () => {
	const root = project({
		"src/model.ts":
			"export class User {\n\tconstructor(public name: string) {}\n}\nexport interface Role {\n\tr: string;\n}\n",
		"src/factory.ts":
			'import { User } from "./model";\nexport function makeUser(name: string) {\n\treturn new User(name);\n}\n',
		"src/repo.ts":
			'import type { User, Role } from "./model";\nexport function save(u: User, r: Role) {\n\treturn [u, r];\n}\n',
	});

	await moveDeclaration(join(root, "src/factory.ts"), "makeUser", join(root, "src/repo.ts"), everyFile(root));

	expect(read(root, "src/repo.ts")).toStartWith('import { User, type Role } from "./model";\n');
	await typeCheck(root);
});

test("a dependency that is both a type and a value is imported as a value", async () => {
	const root = project({
		"src/a.ts":
			'export type Status = "a" | "b";\nexport const Status = { Active: "a" } as const;\nexport function isActive(s: Status) {\n\treturn s === Status.Active;\n}\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "isActive", join(root, "src/b.ts"), everyFile(root));

	expect(read(root, "src/b.ts")).toStartWith('import { Status } from "./a";\n');
	await typeCheck(root);
});

test("a helper the move would export is refused when a barrel already exports that name from elsewhere", async () => {
	const root = project({
		"src/lib/a.ts":
			'function format(n: number) {\n\treturn n.toFixed(2);\n}\nexport function price(n: number) {\n\treturn "$" + format(n);\n}\n',
		"src/lib/b.ts": "export function format(s: string) {\n\treturn s.trim();\n}\n",
		"src/lib/index.ts": 'export * from "./a";\nexport * from "./b";\n',
	});

	expect(
		String(
			await rejection(
				moveDeclaration(join(root, "src/lib/a.ts"), "price", join(root, "src/lib/price.ts"), everyFile(root)),
			),
		),
	).toContain("already exports format");
});

test("the target's default export, used by the moved code, is its own; a barrel collision in the target is refused", async () => {
	const root = project({
		"src/b.ts": "export default function Button() {\n\treturn 1;\n}\n",
		"src/a.ts": 'import Button from "./b";\nexport function iconButton() {\n\treturn Button();\n}\n',
		"src/ui/source.ts": 'export const label = "x";\nexport const other = 1;\n',
		"src/ui/button.ts": "export const Button = 1;\n",
		"src/ui/format.ts": "export function label() {\n\treturn 1;\n}\n",
		"src/ui/index.ts": 'export * from "./button";\nexport * from "./format";\n',
	});

	await moveDeclaration(join(root, "src/a.ts"), "iconButton", join(root, "src/b.ts"), everyFile(root));
	expect(read(root, "src/b.ts")).toBe(
		"export default function Button() {\n\treturn 1;\n}\nexport function iconButton() {\n\treturn Button();\n}\n",
	);
	await typeCheck(root);
	expect(
		String(
			await rejection(
				moveDeclaration(join(root, "src/ui/source.ts"), "label", join(root, "src/ui/button.ts"), everyFile(root)),
			),
		),
	).toContain("already exports label");
});

test("import attributes survive in the source and are copied with the imports the target needs", async () => {
	const root = project({
		"src/data.json": '{ "a": 1, "b": 2 }\n',
		"src/a.ts": [
			'import data, { a } from "./data.json" with { type: "json" };',
			"export function moveMe() {",
			"\treturn a;",
			"}",
			"export const b = data.b;",
			"",
		].join("\n"),
	});

	await moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/moved.ts"), everyFile(root));

	expect(read(root, "src/a.ts")).toBe(
		'import data from "./data.json" with { type: "json" };\nexport const b = data.b;\n',
	);
	expect(read(root, "src/moved.ts")).toBe(
		'import { a } from "./data.json" with { type: "json" };\nexport function moveMe() {\n\treturn a;\n}\n',
	);
});

test("moving works without a tsconfig", async () => {
	const root = project({
		"src/a.ts": "export function moveMe() { return 1; }\n",
		"src/b.ts": 'import { moveMe } from "./a";\nexport const b = moveMe();\n',
	});
	rmSync(join(root, "tsconfig.json"));

	await moveDeclaration(join(root, "src/a.ts"), "moveMe", join(root, "src/moved.ts"), everyFile(root));

	expect(read(root, "src/b.ts")).toBe('import { moveMe } from "./moved";\nexport const b = moveMe();\n');
});

test("sg.move places syntax without changing imports", () => {
	const root = project({
		"src/a.ts": 'import { x } from "./x";\nexport function f() { return x; }\n',
		"src/b.ts": 'import { f } from "./a";\nf();\n',
		"src/x.ts": "export const x = 1;\n",
	});
	move(declaration(root, "src/a.ts", "function f() { return x; }"), { endOf: file(join(root, "src/moved.ts")) });
	expect(read(root, "src/moved.ts")).toBe("export function f() { return x; }\n");
	expect(read(root, "src/b.ts")).toBe('import { f } from "./a";\nf();\n');
});

test("a declaration must exist once at the top level", async () => {
	const root = project({ "src/a.ts": "export function f() {}\nfunction g() { const h = 1; }\n" });
	const error = await rejection(moveDeclaration(join(root, "src/a.ts"), "h", join(root, "src/b.ts"), everyFile(root)));
	expect(String(error)).toContain("found no top-level declaration of h");
});
