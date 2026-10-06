import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const setups = ["baseline", "code", "replace", "read-code"] as const;
export type Setup = (typeof setups)[number];
export type Documentation = "shipped" | "minimal";
export type Sightread = "off" | "on";
/** Pi's codemode tool: absent, alongside the declared tools (`codemode.mode: "on"`), or in place of them ("only"). */
export type Codemode = "off" | "on" | "only";
/** How `shorthand` meets codemode: callable from scripts with a structured result, or declared to the model only. */
export type CodeExposure = "direct" | "model-only";

function distinctMembers<T extends string>(option: string, value: string, members: readonly T[]): T[] {
	const result = value.split(",");
	if (!result.length || result.some((item) => !members.includes(item as T)) || new Set(result).size !== result.length)
		throw new Error(`--${option} must be distinct members of ${members.join(", ")}`);
	return result as T[];
}

export function parseSightread(value: string): Sightread[] {
	return distinctMembers("sightread", value, ["off", "on"]);
}

export function parseCodemode(value: string): Codemode[] {
	return distinctMembers("codemode", value, ["off", "on", "only"]);
}

export function parseCodeExposure(value: string): CodeExposure[] {
	return distinctMembers("code-exposure", value, ["direct", "model-only"]);
}

/** API facts only: no batching advice, workflow examples, or skill referral. */
export const minimalDescription = `Execute a TypeScript program with Bun in an isolated repository workspace. Top-level await and Bun/Node APIs are available. Use relative repository paths. Successful writes are applied transactionally and returned as a diff; failures return the error and candidate diff. Only tracked and non-ignored files are applied. Writes to .git are blocked.
Synchronous globals:
edit({path, oldText, newText}) replaces exactly one literal occurrence.
glob(pattern, dir?) -> string[]
grep(stringOrRegExp, paths?) -> {file, line, text}[]; strings match literally.
sg.find(pattern, files?) -> {file, line, text, vars}[]; files accepts paths, directories, globs or lists (JS/TS). $X matches one node; $$$X matches zero or more.
sg.rewrite(pattern, templateOrFunction, files?) -> number; templates interpolate captures; callbacks receive match with captures directly on it (m.X), returning replacement text or null. A pattern rewrite skips places an earlier rewrite produced.
sg.one(pattern, files?) requires one match; sg.file(path) selects a JS/TS file root, including new files.
sg.insert(text, destination), sg.move(match, destination, transform?), sg.remove(match). Destination is exactly one of {before: match}, {after: match}, {startOf: container}, {endOf: container}. Statements/declarations only. Containers are file roots or matched statement blocks. Matches must be refreshed after editing their file. move's optional function transforms text.
sg also exposes ast-grep's native API, including parse and Lang. Importing @ast-grep/napi is supported.
Asynchronous refactors: refactor.rename({file, symbol, to}), refactor.renameFile({from, to}) and refactor.move({file, symbol, to}) update references and imports across the project.
refactor.references({file, symbol}) returns resolved identifier matches that pass straight to sg.rewrite(matches, callback).
graph.query(request | request[]) queries symbols and relationships; graph results can be passed to sg as scope. The graph shows the repository before this program's edits.
$ is Bun's asynchronous shell and requires await; ast-grep and git CLIs are available.
timeout is in seconds of program time (default 2); time inside helpers is excluded, up to 60 extra seconds. On failure, rollback="file" (default) rolls back failed or interrupted file edits and keeps the others; rollback="all" applies nothing.`;

export function parseSetups(value: string): Setup[] {
	const result = value.split(",");
	if (
		!result.length ||
		result.some((item) => !setups.includes(item as Setup)) ||
		new Set(result).size !== result.length
	)
		throw new Error(`Setups must be distinct members of ${setups.join(", ")}`);
	return result as Setup[];
}

export function conditionTools(setup: Setup, codemode: Codemode = "off"): string[] {
	// Explicit lists keep stock and replacement exploration facilities identical.
	const common = ["read", "bash"];
	const tools =
		setup === "read-code"
			? ["read", "shorthand"]
			: setup === "replace"
				? [...common, "shorthand"]
				: [...common, "edit", "write", ...(setup === "code" ? ["shorthand"] : [])];
	return codemode === "off" ? tools : [...tools, "codemode"];
}

export function rotateConditions<T>(conditions: T[], repetition: number): T[] {
	const offset = (repetition - 1) % conditions.length;
	return [...conditions.slice(offset), ...conditions.slice(0, offset)];
}

/**
 * The entry Pi would load, from package.json's `pi.extensions`. Older checkouts, which paired runs may compare
 * against, kept it at the root as index.ts.
 */
async function extensionIndex(root: string): Promise<string> {
	const manifest = await readFile(path.join(root, "package.json"), "utf8").catch(() => null);
	const entry = manifest ? (JSON.parse(manifest) as { pi?: { extensions?: string[] } }).pi?.extensions?.[0] : undefined;
	return path.join(root, entry ?? "index.ts");
}

/**
 * Wrap registration rather than changing the shipped extension or its execution behaviour. Checkouts from before
 * the tool was renamed register it as `code`, so the wrapper registers it as `shorthand` and gives their
 * listeners the name they expect. Every run loads through the wrapper, so old and new checkouts pair.
 */
export async function extensionEntry(
	root: string,
	documentation: Documentation,
	destination: string,
	sightread: Sightread = "on",
	codemode: Codemode = "off",
	exposure: CodeExposure = "direct",
): Promise<string> {
	const entry = await extensionIndex(root);
	const modelOnly = codemode !== "off" && exposure === "model-only";
	await mkdir(path.dirname(destination), { recursive: true });
	const description = sightread === "on" ? minimalDescription : minimalDescription.replace(/^graph\.query.*\n/m, "");
	const documented =
		documentation === "minimal"
			? `{ ...tool, description: ${JSON.stringify(description)}, promptSnippet: "Transactional Bun program for repository changes", promptGuidelines: [] }`
			: "tool";
	// `direct`, with its output schema, is how `shorthand` ships; `model-only` takes it out of scripts.
	const exposed = modelOnly ? `{ ...${documented}, exposure: "model-only" }` : documented;
	await writeFile(
		destination,
		`import extension from ${JSON.stringify(pathToFileURL(entry).href)};
export default function(pi) {
  let legacy = false;
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return (tool) => {
      if (tool.name !== "code" && tool.name !== "shorthand") return target.registerTool(tool);
      legacy = tool.name === "code";
      return target.registerTool({ ...${exposed}, name: "shorthand" });
    };
    if (key === "on") return (event, handler) => target.on(event, (payload, ...rest) =>
      handler(legacy && payload?.toolName === "shorthand" ? { ...payload, toolName: "code" } : payload, ...rest));
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  return extension(proxy${sightread === "off" ? ", async () => undefined" : ""});
}
`,
	);
	return destination;
}
