import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { MessageConnection } from "vscode-jsonrpc/node";
import { withTypeScriptServer } from "../src/refactor/lsp-client.ts";
import { rename, renameFile } from "../src/refactor/typescript-refactors.ts";

// Each test starts a TypeScript language server, which can take seconds on a cold or slow machine.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>) {
	const root = await mkdtemp(path.join(tmpdir(), "shorthand-typescript-"));
	roots.push(root);
	for (const [file, source] of Object.entries(files)) await Bun.write(path.join(root, file), source);
	return root;
}

test("rename changes one resolved symbol across files", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
		"src/parse.ts": 'export const mascot = "😀";\r\nexport function parseUser(value: string) { return value; }\r\n',
		"src/use.ts":
			'import { parseUser } from "./parse";\nexport const api = { parseUser };\nexport const result = parseUser("Ada");\n',
		"src/other.ts": 'function parseUser() { return "unrelated"; }\nexport const text = "parseUser";\n',
	});

	await rename(root, { file: "src/parse.ts", symbol: "parseUser", to: "decodeUser" });

	expect(await Bun.file(path.join(root, "src/parse.ts")).text()).toBe(
		'export const mascot = "😀";\r\nexport function decodeUser(value: string) { return value; }\r\n',
	);
	expect(await Bun.file(path.join(root, "src/use.ts")).text()).toBe(
		'import { decodeUser } from "./parse";\nexport const api = { parseUser: decodeUser };\nexport const result = decodeUser("Ada");\n',
	);
	expect(await Bun.file(path.join(root, "src/other.ts")).text()).toBe(
		'function parseUser() { return "unrelated"; }\nexport const text = "parseUser";\n',
	);
});

test("rename follows re-exports while keeping object literal keys and explicit aliases", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
		"src/lib/money.ts": 'export const mascot = "😀";\nexport function formatAmount(n: number) { return String(n); }\n',
		"src/lib/index.ts": 'export { formatAmount } from "./money";\n',
		"src/public.ts": 'export { formatAmount as legacyFormat } from "./lib/money";\n',
		"src/use.ts":
			'import { formatAmount } from "./lib";\nimport { formatAmount as fmt } from "./lib/money";\nexport const api = { "😀": 1, formatAmount };\nexport const x = api.formatAmount(1) + fmt(2);\n',
		"src/ns.ts":
			'import * as money from "./lib/money";\nconst { formatAmount } = money;\nexport const y = formatAmount(3);\n',
	});

	await rename(root, { file: "src/lib/money.ts", symbol: "formatAmount", to: "formatPrice" });

	const read = (file: string) => Bun.file(path.join(root, file)).text();
	expect(await read("src/lib/index.ts")).toBe('export { formatPrice } from "./money";\n');
	expect(await read("src/public.ts")).toBe('export { formatPrice as legacyFormat } from "./lib/money";\n');
	expect(await read("src/use.ts")).toBe(
		'import { formatPrice } from "./lib";\nimport { formatPrice as fmt } from "./lib/money";\nexport const api = { "😀": 1, formatAmount: formatPrice };\nexport const x = api.formatAmount(1) + fmt(2);\n',
	);
	expect(await read("src/ns.ts")).toBe(
		'import * as money from "./lib/money";\nconst { formatPrice: formatAmount } = money;\nexport const y = formatAmount(3);\n',
	);
});

test("rename keeps the property a renamed destructured binding reads", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
		"src/o.ts": "export const obj = { foo: 1, bar: 2 };\n",
		"src/a.ts": 'import { obj } from "./o";\nconst { foo } = obj;\nexport const x = foo;\n',
	});

	await rename(root, { file: "src/a.ts", symbol: "foo", to: "bar" });

	expect(await Bun.file(path.join(root, "src/a.ts")).text()).toBe(
		'import { obj } from "./o";\nconst { foo: bar } = obj;\nexport const x = bar;\n',
	);
});

test("rename rejects overloaded declarations without writing", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ include: ["src"] }),
		"src/format.ts":
			"export function format(value: string): string;\nexport function format(value: number): number;\nexport function format(value: string | number) { return value; }\n",
		"src/use.ts": 'import { format } from "./format";\nexport const result = format(1);\n',
	});

	await expect(rename(root, { file: "src/format.ts", symbol: "format", to: "render" })).rejects.toThrow(
		"found more than one declaration",
	);
	expect(await Bun.file(path.join(root, "src/format.ts")).text()).toContain("function format");
	expect(await Bun.file(path.join(root, "src/use.ts")).text()).toContain("format(1)");
});

test.each([
	["missing", "found no declaration"],
	["value", "is ambiguous"],
])("rename rejects %s declarations without writing", async (symbol, message) => {
	// A bare name would mean a top-level declaration; these two locals have none.
	const source =
		"export function a() { const value = 1; return value; }\nexport function b() { const value = 2; return value; }\n";
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
		"src/app.ts": source,
	});
	await expect(rename(root, { file: "src/app.ts", symbol, to: "next" })).rejects.toThrow(message);
	expect(await Bun.file(path.join(root, "src/app.ts")).text()).toBe(source);
});

test("renameFile moves a file and updates resolved module paths", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
		"src/shared/types.ts": "export interface User { name: string }\n",
		"src/parse-user.ts":
			'import type { User } from "./shared/types";\nexport function parseUser(name: string): User { return { name }; }\n',
		"src/index.ts": 'export { parseUser } from "./parse-user";\n',
		"src/app.ts": 'import { parseUser } from "./parse-user";\nexport const user = parseUser("Ada");\n',
	});

	await renameFile(root, { from: "src/parse-user.ts", to: "src/users/parse-user.ts" });

	expect(await Bun.file(path.join(root, "src/parse-user.ts")).exists()).toBe(false);
	expect(await Bun.file(path.join(root, "src/users/parse-user.ts")).text()).toBe(
		'import type { User } from "../shared/types";\nexport function parseUser(name: string): User { return { name }; }\n',
	);
	expect(await Bun.file(path.join(root, "src/index.ts")).text()).toBe(
		'export { parseUser } from "./users/parse-user";\n',
	);
	expect(await Bun.file(path.join(root, "src/app.ts")).text()).toBe(
		'import { parseUser } from "./users/parse-user";\nexport const user = parseUser("Ada");\n',
	);
});

test("consecutive refactors share current TypeScript project state", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ include: ["src"] }),
		"src/parse.ts": "export function parseUser(value: string) { return value; }\n",
		"src/use.ts": 'import { parseUser } from "./parse";\nexport const user = parseUser("Ada");\n',
	});

	await rename(root, { file: "src/parse.ts", symbol: "parseUser", to: "decodeUser" });
	await renameFile(root, { from: "src/parse.ts", to: "src/users/decode.ts" });
	await rename(root, { file: "src/users/decode.ts", symbol: "decodeUser", to: "readUser" });

	expect(await Bun.file(path.join(root, "src/users/decode.ts")).text()).toContain("function readUser");
	expect(await Bun.file(path.join(root, "src/use.ts")).text()).toBe(
		'import { readUser } from "./users/decode";\nexport const user = readUser("Ada");\n',
	);
});

test("the TypeScript server is reused when other code changes the project, and told what changed", async () => {
	const root = await fixture({ "src/app.ts": "export const value = 1;\n" });
	let first!: MessageConnection;
	await withTypeScriptServer(root, async (server) => {
		first = server;
	});
	await Bun.write(path.join(root, "src/new.ts"), "export const added = 2;\n");
	await withTypeScriptServer(root, async (server) => {
		expect(server).toBe(first);
	});
	// A configuration change can change which projects exist, so the server starts again.
	await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
	await withTypeScriptServer(root, async (server) => {
		expect(server).not.toBe(first);
	});
});

test("a reused server observes an intervening filesystem edit", async () => {
	const root = await fixture({
		"tsconfig.json": JSON.stringify({ include: ["src"] }),
		"src/app.ts": "export function first() { return 1; }\n",
	});

	await rename(root, { file: "src/app.ts", symbol: "first", to: "initial" });
	await Bun.write(
		path.join(root, "src/app.ts"),
		(await Bun.file(path.join(root, "src/app.ts")).text()) + "export function second() { return 2; }\n",
	);
	await Bun.write(
		path.join(root, "src/use.ts"),
		'import { initial } from "./app";\nexport const result = initial();\n',
	);
	await rename(root, { file: "src/app.ts", symbol: "second", to: "next" });
	await rename(root, { file: "src/app.ts", symbol: "initial", to: "final" });

	expect(await Bun.file(path.join(root, "src/app.ts")).text()).toBe(
		"export function final() { return 1; }\nexport function next() { return 2; }\n",
	);
	expect(await Bun.file(path.join(root, "src/use.ts")).text()).toBe(
		'import { final } from "./app";\nexport const result = final();\n',
	);
});

test("renameFile rejects an existing destination without writing", async () => {
	const root = await fixture({
		"src/old.ts": "export const old = true;\n",
		"src/new.ts": "export const existing = true;\n",
	});
	await expect(renameFile(root, { from: "src/old.ts", to: "src/new.ts" })).rejects.toThrow(
		"destination already exists",
	);
	expect(await Bun.file(path.join(root, "src/old.ts")).text()).toContain("old = true");
	expect(await Bun.file(path.join(root, "src/new.ts")).text()).toContain("existing = true");
});

test("renameFile rejects a destination outside the project", async () => {
	const root = await fixture({ "src/old.ts": "export const old = true;\n" });
	await expect(renameFile(root, { from: "src/old.ts", to: "../outside.ts" })).rejects.toThrow("outside the repository");
	expect(await Bun.file(path.join(root, "src/old.ts")).exists()).toBe(true);
});
