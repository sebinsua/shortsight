/**
 * Preloaded into every shorthand program. On top of ordinary Bun and Node it adds these globals:
 * $ (Bun shell), edit, glob, grep, sg (ast-grep) and refactor (renames and file moves).
 *
 * sg is ast-grep's own JavaScript API plus file-backed search, rewrite and placement helpers.
 * Programs can also import "@ast-grep/napi" directly.
 *
 * Most helpers are synchronous; semantic TypeScript refactors return promises.
 * File lists come from git (tracked, plus untracked files that aren't ignored), so node_modules
 * and build output are left out on every platform.
 *
 * Each $ command and helper call is reported to the runner while the program is active.
 */

import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as astGrep from "@ast-grep/napi";
import { type Edit, Lang, type NapiConfig, parse, type SgNode } from "@ast-grep/napi";
import { $ as bunShell, Glob } from "bun";
import { editingFiles, executionRoot, installFileOutcomeTracking, wasEdited } from "./file-outcomes.ts";
import {
	file as selectFile,
	moveDeclaration,
	getMatchSnapshot,
	insert,
	isFileTarget,
	move,
	remember,
	NotUtf8Error,
	readUtf8,
	remove,
	syntaxErrorAt,
	type FileTarget,
} from "../refactor/placement.ts";
import type {
	ReferenceLocation,
	ReferencesOptions,
	RenameFileOptions,
	RenameOptions,
} from "../refactor/typescript-refactors.ts";

installFileOutcomeTracking();

const progressDescriptor = process.env.PI_SHORTHAND_PROGRESS_FD;
// Subprocesses do not inherit this descriptor by default, so do not advertise it to them.
delete process.env.PI_SHORTHAND_PROGRESS_FD;
const graphSocket = process.env.PI_SHORTHAND_GRAPH_SOCKET;
delete process.env.PI_SHORTHAND_GRAPH_SOCKET;
const graphSources = new Map<string, string>();

export interface GraphNode {
	handle: string;
	name: string;
	kind?: string;
	file: string;
	ranges: { start: number; end: number }[] | null;
	site?: { start: number; end: number };
	exact?: true;
	line?: number;
	col?: number;
	endLine?: number;
	endCol?: number;
}

export interface GraphEdge {
	from: string;
	to: string;
	kind: string;
	at?: { file: string; line: number; col?: number; endLine?: number; endCol?: number };
}

type GraphSite = NonNullable<GraphEdge["at"]> & { node?: never; text?: never };

export interface GraphResult {
	type: string;
	error?: string;
	shown: number;
	total?: number;
	raise?: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	sections: Record<string, unknown>;
}

function graphQuery(request: Record<string, unknown>): Promise<GraphResult>;
function graphQuery(request: Record<string, unknown>[]): Promise<GraphResult[]>;
function graphQuery(
	request: Record<string, unknown> | Record<string, unknown>[],
): Promise<GraphResult | GraphResult[]> {
	if (!graphSocket) return Promise.reject(new Error("graph is available only inside a shorthand program"));
	return new Promise((done, fail) => {
		const socket = createConnection(graphSocket);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.once("error", fail);
		socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			try {
				const reply = JSON.parse(buffer.slice(0, end)) as {
					value?: GraphResult | GraphResult[];
					error?: string;
					sources?: Record<string, string>;
				};
				if (reply.error) fail(new Error(reply.error));
				else {
					for (const [file, hash] of Object.entries(reply.sources ?? {})) graphSources.set(file, hash);
					done(reply.value!);
				}
			} catch (error) {
				fail(error);
			} finally {
				socket.end();
			}
		});
	});
}

function queryGraph(request: Record<string, unknown>): Promise<GraphResult>;
function queryGraph(request: Record<string, unknown>[]): Promise<GraphResult[]>;
function queryGraph(
	request: Record<string, unknown> | Record<string, unknown>[],
): Promise<GraphResult | GraphResult[]> {
	return logged("graph.query", [request], () => (Array.isArray(request) ? graphQuery(request) : graphQuery(request)));
}

function report(event: Record<string, unknown>) {
	if (!progressDescriptor) return;
	try {
		writeSync(Number(progressDescriptor), JSON.stringify(event) + "\n");
	} catch {
		// Progress is advisory and must never change the program's result.
	}
}

let helperCalls = 0;
/** Errors the program's own code threw from inside a helper, whose stacks already point at it. */
const programErrors = new WeakSet<Error>();

/**
 * A helper whose own errors point at the program line that called it. Bun prints the source around an
 * error's first frame, which would otherwise be shorthand's code rather than the call that failed.
 */
function atCaller<A extends unknown[], T>(helper: (...args: A) => T): (...args: A) => T {
	const call = (...args: A): T => {
		try {
			return helper(...args);
		} catch (error) {
			if (error instanceof Error && !programErrors.has(error)) Error.captureStackTrace(error, call);
			throw error;
		}
	};
	return call;
}
let activeHelper: { helper: string; id: number } | undefined;

/**
 * Runs the program's own code from inside a helper, such as an sg.rewrite callback. That time counts
 * toward the timeout again, so an endless loop in a callback still times out promptly.
 */
function programCode<T>(run: () => T): T {
	const helper = activeHelper;
	if (!helper) return run();
	report({ type: "helper-yield", ...helper });
	activeHelper = undefined;
	try {
		return run();
	} catch (error) {
		if (error instanceof Error) programErrors.add(error);
		throw error;
	} finally {
		activeHelper = helper;
		report({ type: "helper-resume", ...helper });
	}
}

/**
 * Runs a helper, logging when it starts, how long it took and how many results it returned. The runner
 * pauses the program's timeout while helpers run, so every start is matched by a finish, even on failure.
 */
function logged<T>(helper: string, _args: unknown[], run: () => T): T {
	const id = ++helperCalls;
	const startedAt = performance.now();
	report({ type: "helper-start", helper, id });
	const outer = activeHelper;
	activeHelper = { helper, id };
	const done = (value?: unknown) => {
		const results = Array.isArray(value) ? value.length : typeof value === "number" ? value : undefined;
		report({
			type: "helper",
			helper,
			id,
			ms: Math.round(performance.now() - startedAt),
			results,
		});
	};
	let result: T;
	try {
		result = run();
	} catch (error) {
		done();
		throw error;
	} finally {
		activeHelper = outer;
	}
	if (result instanceof Promise)
		return result.then(
			(value) => {
				done(value);
				return value;
			},
			(error) => {
				done();
				throw error;
			},
		) as T;
	done(result);
	return result;
}

/** Bun's shell, logging each command as it starts. */
const $ = new Proxy(bunShell, {
	apply(target, thisArg, args: Parameters<typeof bunShell>) {
		const [strings] = args;
		const words = strings.raw[0].trim().split(/\s+/);
		report({ type: "command", command: words.find((word) => !word.includes("=")) ?? "" });
		return Reflect.apply(target, thisArg, args);
	},
});

/**
 * Files git sees under a directory that match a glob pattern, relative to the working directory,
 * sorted. The directory can also be given as { cwd }, as with Bun's Glob.
 */
function glob(pattern: string, where: string | { cwd?: string } = "."): string[] {
	const dir = typeof where === "string" ? where : (where.cwd ?? ".");
	return selectFiles(resolve(checkedPath(dir), checkedPath(pattern)));
}

/**
 * Search files git sees. A string is matched literally; a RegExp is matched as a Perl-compatible
 * regular expression, which is close to JavaScript's syntax.
 */
function grep(pattern: string | RegExp, scope: string | string[] = ".") {
	const paths = [scope].flat().map((path) => pathArgument("grep", path));
	let flags: string[];
	if (typeof pattern === "string") {
		flags = ["-F", "-e", pattern];
	} else {
		// Bun writes non-ASCII characters in a regex literal as \uXXXX, which PCRE spells \x{XXXX}.
		const source = pattern.source.replace(/\\u\{?([0-9a-fA-F]{4,6})\}?/g, "\\x{$1}");
		flags = ["-P", "-e", source];
		if (pattern.flags.includes("i")) flags.push("-i");
	}
	// Git runs from the root, with paths relative to it, and its files are named from here again below: see git().
	// Git's own pathspecs differ from glob and sg scopes: `*` crosses directories and `[id]` is a character class.
	// An existing path is taken literally and anything else as a glob, as glob() reads it.
	const fromRoot = paths.map((path) => {
		const rooted = relative(repositoryRoot, resolve(path)) || ".";
		return statSync(resolve(path), { throwIfNoEntry: false }) ? `:(literal)${rooted}` : `:(glob)${rooted}`;
	});
	const output = git(
		["-C", repositoryRoot, "grep", "-n", "--null", "--untracked", "-I", ...flags, "--", ...fromRoot],
		[1],
	);

	const matches = [];
	let offset = 0;
	while (offset < output.length) {
		const fileEnd = output.indexOf("\0", offset);
		const lineEnd = fileEnd < 0 ? -1 : output.indexOf("\0", fileEnd + 1);
		const textEnd = lineEnd < 0 ? -1 : output.indexOf("\n", lineEnd + 1);
		const file = fileEnd < 0 ? "" : output.slice(offset, fileEnd);
		const lineNumber = lineEnd < 0 ? "" : output.slice(fileEnd + 1, lineEnd);
		if (!file || !/^\d+$/.test(lineNumber) || textEnd < 0) {
			throw new Error(`git grep returned malformed output: ${JSON.stringify(output.slice(offset, offset + 200))}`);
		}
		const text = output.slice(lineEnd + 1, textEnd);
		matches.push({ file: relative(process.cwd(), resolve(repositoryRoot, file)), line: Number(lineNumber), text });
		offset = textEnd + 1;
	}
	return matches;
}

function git(args: string[], allowedExitCodes: number[] = []): string {
	// `-C <dir>` calls start in that directory: Git reads its starting directory itself, and on macOS that fails in a
	// subdirectory of the AgentFS mount once a file has been read there (see start-directory.ts).
	const result = Bun.spawnSync(["git", ...args], { env: process.env, ...(args[0] === "-C" ? { cwd: args[1] } : {}) });
	if (result.exitCode !== 0 && !allowedExitCodes.includes(result.exitCode)) {
		const diagnostic = result.stderr.toString().trim() || result.stdout.toString().trim();
		const command = args[0] === "-C" ? args[2] : args[0]; // named after the subcommand, not its directory
		throw new Error(`git ${command} failed (exit ${result.exitCode}): ${diagnostic || "no diagnostics"}`);
	}
	return result.stdout.toString();
}

// The runner already resolved this before starting the sandbox. Standalone preloads
// still ask Git, preserving the existing direct-use behavior.
const repositoryRoot = executionRoot || git(["rev-parse", "--show-toplevel"]).trim();

/** Normalize an invocation path or glob to the path form emitted by `git ls-files --full-name`. */
function gitPath(input: string): string {
	const normalized = relative(repositoryRoot, resolve(input)).replaceAll("\\", "/");
	if (normalized === "") return ".";
	if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
		throw new Error(`path is outside the repository: ${JSON.stringify(input)}`);
	}
	return normalized;
}

/**
 * Tracked or non-ignored untracked files, as Git lists them, relative to the repository root. The pathspec is
 * repository-relative too, so Git runs from the root even after the program changes directory.
 */
function listGitFiles(pathspec = "."): string[] {
	const output = git([
		"-C",
		repositoryRoot,
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		pathspec,
	]);
	return [...new Set(output.split("\0"))].filter(Boolean);
}

/** Git still lists a tracked file the program has deleted, so check the final filesystem too. */
function existing(files: string[]): string[] {
	return files.filter((file) => lstatSync(resolve(repositoryRoot, file), { throwIfNoEntry: false })).toSorted();
}

/** Existing tracked or non-ignored untracked files, always named relative to the repository root. */
function gitFiles(pathspec = "."): string[] {
	return existing(listGitFiles(pathspec));
}

// Starting git costs tens of milliseconds inside the sandbox. While set, one listing serves every
// input of a selection, so a list of 80 paths runs git once rather than 80 times.
let sharedListing: { files?: string[] } | undefined;

function withSharedListing<T>(select: () => T): T {
	if (sharedListing) return select();
	sharedListing = {};
	try {
		return select();
	} finally {
		sharedListing = undefined;
	}
}

let tracked: { stamp: string; files: Set<string> } | undefined;
let indexPath: string | undefined;

/** Files Git tracks, listed once and again only after the index changes, e.g. from `git add` in the program. */
function trackedFiles(): Set<string> {
	indexPath ??= resolve(repositoryRoot, git(["-C", repositoryRoot, "rev-parse", "--git-path", "index"]).trim());
	const index = statSync(indexPath, { throwIfNoEntry: false });
	const stamp = index ? `${index.ino}:${index.size}:${index.mtimeMs}` : "";
	if (tracked?.stamp !== stamp) {
		const listed = git(["-C", repositoryRoot, "ls-files", "-z", "--cached"]).split("\0").filter(Boolean);
		tracked = { stamp, files: new Set(listed) };
	}
	return tracked.files;
}

/** Select a Git-visible file, directory, or glob and return repository-relative paths. */
function selectFiles(input: string): string[] {
	const normalized = gitPath(input);
	const stats = statSync(resolve(repositoryRoot, normalized), { throwIfNoEntry: false });
	const pathspec = stats?.isFile() || stats?.isDirectory();
	if (!sharedListing) {
		// A program often names files one at a time; a tracked one needs no git process to be selected.
		if (stats?.isFile() && trackedFiles().has(normalized)) return [normalized];
		if (pathspec) return gitFiles(normalized);
		const matcher = new Glob(normalized);
		return gitFiles().filter((file) => matcher.match(file));
	}
	const files = (sharedListing.files ??= listGitFiles());
	if (pathspec)
		// A pathspec matches the path itself and everything beneath it.
		return existing(
			normalized === "." ? files : files.filter((file) => file === normalized || file.startsWith(`${normalized}/`)),
		);
	const matcher = new Glob(normalized);
	return existing(files.filter((file) => matcher.match(file)));
}

// ── ast-grep ──────────────────────────────────────────────────────────────────────
// Patterns use ast-grep syntax: $X matches one node, $$$X matches zero or more.

const LANGUAGES: Record<string, Lang> = {
	ts: Lang.TypeScript,
	mts: Lang.TypeScript,
	cts: Lang.TypeScript,
	tsx: Lang.Tsx,
	jsx: Lang.Tsx,
	js: Lang.JavaScript,
	mjs: Lang.JavaScript,
	cjs: Lang.JavaScript,
	html: Lang.Html,
	css: Lang.Css,
};

/**
 * A match. Its captures are in `vars` and also directly on it (capture names are uppercase, so they
 * can't clash with the other fields): both `m.vars.ARGS` and `m.ARGS` work.
 */
export type SgMatch = {
	file: string;
	line: number;
	text: string;
	vars: Record<string, string>; // captured metavariables, e.g. vars.ARGS for $$$ARGS
	node: SgNode;
	call?: SgNode; // refactor.references: the call or `new` expression this reference is the callee of
} & Record<Uppercase<string>, string>;

type ScopeItem = string | FileTarget | GraphNode | GraphSite;
export type FileScope = ScopeItem | ScopeItem[];

function graphHandle(value: string): boolean {
	return /#[^/]+:[A-Za-z][\w-]*$/.test(value);
}

function checkedPath(value: string): string {
	if (graphHandle(value))
		throw new TypeError(`${JSON.stringify(value)} is a graph handle, not a path; pass the node, or node.file`);
	if (statSync(resolve(value), { throwIfNoEntry: false })) return value;
	const fromRoot = resolve(repositoryRoot, value);
	return !isAbsolute(value) && statSync(fromRoot, { throwIfNoEntry: false }) ? fromRoot : value;
}

function isGraphNode(value: unknown): value is GraphNode {
	return typeof value === "object" && value !== null && "handle" in value && "file" in value && "ranges" in value;
}

function isGraphSite(value: unknown): value is GraphSite {
	return (
		typeof value === "object" &&
		value !== null &&
		"file" in value &&
		"line" in value &&
		typeof value.file === "string" &&
		typeof value.line === "number"
	);
}

function scopedPath(value: unknown, helper = "sg.find"): string {
	if (typeof value === "string") return checkedPath(value);
	if (isGraphNode(value) || isGraphSite(value)) {
		const file = resolve(repositoryRoot, value.file);
		const expected = graphSources.get(value.file);
		let current: string | undefined;
		try {
			current = createHash("sha256").update(readFileSync(file)).digest("hex");
		} catch {
			// The file disappeared after the graph snapshot.
		}
		if (wasEdited(file) || (expected !== undefined && current !== expected))
			throw new Error(
				`graph ranges for ${value.file} are stale: this program already edited it. Query first, then pass every node to one sg call`,
			);
		return file;
	}
	if (isFileTarget(value)) return value.file;
	if (typeof value === "object" && value !== null && "nodes" in value && "edges" in value)
		throw new TypeError("pass result.nodes (or a node), not the whole result");
	if (typeof value === "object" && value !== null && "from" in value && "to" in value && "kind" in value)
		throw new TypeError("an edge isn't a location; use edge.at for its span, or the node for edge.from");
	throw new TypeError(`${helper}: files must be paths, sg.file() targets, or an array of either`);
}

type ScopeRange = { start: number; end: number; col?: number; endCol?: number };

function scopeRanges(helper: string, files: FileScope): Map<string, ScopeRange[] | null> {
	const ranges = new Map<string, ScopeRange[] | null>();
	for (const item of Array.isArray(files) ? files : [files]) {
		const file = scopedPath(item, helper);
		const key = resolve(file);
		if (isGraphNode(item) && !isGraphSite(item) && !item.site && !item.ranges?.length)
			throw new Error(
				`graph node ${item.handle} has no line ranges, so it can't limit sg to that symbol; pass node.file to search the whole file`,
			);
		if (!isGraphNode(item) && !isGraphSite(item)) {
			ranges.set(key, null);
			continue;
		}
		if (ranges.has(key) && ranges.get(key) === null) continue;
		const added = isGraphSite(item)
			? [{ start: item.line, end: item.endLine ?? item.line, col: item.col, endCol: item.endCol }]
			: item.site
				? [item.site]
				: item.ranges;
		if (!added?.length) ranges.set(key, null);
		else ranges.set(key, [...(ranges.get(key) ?? []), ...added]);
	}
	return ranges;
}

function withinScope(match: SgMatch, ranges: Map<string, ScopeRange[] | null>): boolean {
	const selected = ranges.get(resolve(match.file));
	return (
		!selected ||
		selected.some(({ start, end, col, endCol }) => {
			if (match.line < start || match.line > end) return false;
			if (col === undefined && endCol === undefined) return true;
			const column = match.node.range().start.column + 1;
			return (match.line > start || column >= (col ?? 1)) && (match.line < end || column < (endCol ?? Infinity));
		})
	);
}

/** File targets opt into explicit files; strings retain the helper's existing selection semantics. */
function scopeFiles(helper: string, files: FileScope, select: (input: string) => string[]): string[] {
	const inputs = Array.isArray(files) ? files : [files];
	const selectAll = () => selectScope(helper, inputs, select);
	return inputs.length > 1 ? withSharedListing(selectAll) : selectAll();
}

function selectScope(helper: string, inputs: ScopeItem[], select: (input: string) => string[]): string[] {
	return [
		...new Set(
			inputs.flatMap((input) => {
				if (typeof input === "string" || isGraphNode(input) || isGraphSite(input))
					return select(scopedPath(input, helper));
				scopedPath(input, helper);
				if (!isFileTarget(input))
					throw new TypeError(`${helper}: files must be paths, sg.file() targets, or an array of either`);
				const absolute = explicitPath(input.file);
				if (!statSync(absolute, { throwIfNoEntry: false })?.isFile())
					throw new Error(
						`${helper}: file target does not exist or is not a file: ${JSON.stringify(gitPath(absolute))}`,
					);
				return [gitPath(absolute)];
			}),
		),
	];
}

const SCRIPTS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

/** JS/TS files Git sees, tracked or new. */
function scriptFiles(): string[] {
	return git(["-C", repositoryRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCRIPTS])
		.split("\0")
		.filter(Boolean)
		.map((file) => resolve(repositoryRoot, file));
}

/** JS/TS files Git sees with a line matching an extended regular expression. */
function scriptFilesMatching(pattern: string): string[] {
	return git(["-C", repositoryRoot, "grep", "-l", "-z", "-E", "--untracked", "-e", pattern, "--", ...SCRIPTS], [1])
		.split("\0")
		.filter(Boolean)
		.map((file) => resolve(repositoryRoot, file));
}

/** JS/TS files Git sees that call import() or require(). */
const filesLoadingModules = () =>
	// The call may continue on the next line or after a comment: `import\n("./a")`.
	scriptFilesMatching("(^|[^[:alnum:]_$])(import|require)[[:space:]]*(\\(|/[*/]|$)");

/** JS/TS files Git sees that may re-export a module wholesale, with `export *`, which may span lines. */
const filesReexportingAll = () => scriptFilesMatching("(^|[^[:alnum:]_$])export[[:space:]]*(\\*|/[*/]|$)");

/** A scope for a warning: short scopes in full, long ones as a count and the first few paths. */
function describeScope(scope: FileScope): string {
	const paths = (Array.isArray(scope) ? scope : [scope]).map((entry) =>
		typeof entry === "string" ? entry : isGraphNode(entry) || isGraphSite(entry) ? entry.file : gitPath(entry.file),
	);
	if (paths.length <= 3) return JSON.stringify(paths);
	return `${paths.length} paths (${paths
		.slice(0, 3)
		.map((path) => JSON.stringify(path))
		.join(", ")}, …)`;
}

/**
 * The supported syntax files to search. `files` is a Git-visible file, directory, glob, or a list
 * of any of those. Warns if there are none, since that's almost always a mistake.
 */
function sourceFiles(helper: string, files: FileScope): string[] {
	const found = scopeFiles(helper, files, selectFiles);
	const parseable = found.filter(
		(file) =>
			LANGUAGES[file.split(".").pop()!] && statSync(resolve(repositoryRoot, file), { throwIfNoEntry: false })?.isFile(),
	);
	if (parseable.length === 0) console.error(`warning: ${helper} found no supported files in ${describeScope(files)}`);
	// A symlink and its target are one file: reading and writing both would rewrite it twice. Keep the real path.
	const byRealPath = new Map<string, string>();
	for (const file of parseable) {
		const absolute = resolve(repositoryRoot, file);
		const real = realpathSync(absolute);
		if (!byRealPath.has(real) || !lstatSync(absolute).isSymbolicLink()) byRealPath.set(real, file);
	}
	const unique = parseable.filter((file) => byRealPath.get(realpathSync(resolve(repositoryRoot, file))) === file);
	// Named from the program's working directory, like every other path it reads and writes, so a program that
	// changes directory still reads, writes and reports the file it selected. At the root this is the path itself.
	return unique.map((file) => {
		const absolute = resolve(repositoryRoot, file);
		try {
			return relative(process.cwd(), absolute);
		} catch {
			return absolute;
		}
	});
}

/**
 * A file path argument. Helpers are documented and typed as taking paths, but also accept an sg.file()
 * target in their place, since that is an easy mistake to make and its meaning is unambiguous.
 */
function pathArgument(helper: string, path: unknown): string {
	if (typeof path === "string") return checkedPath(path);
	if (isGraphNode(path)) return scopedPath(path);
	if (isFileTarget(path)) return getMatchSnapshot(path).file;
	throw new TypeError(`${helper}: expected a file path string`);
}

function refactorTarget(helper: string, options: { file: string | GraphNode; symbol?: string }) {
	const node = isGraphNode(options.file) ? options.file : undefined;
	if (
		node &&
		(!node.name ||
			["file", "project", "package", "directory", "test", "reference", "external"].includes(node.kind ?? ""))
	)
		throw new Error(`${helper}: graph node ${node.handle} cannot be used as a symbol target`);
	return {
		file: gitPath(pathArgument(helper, options.file)),
		symbol: options.symbol ?? node?.name,
	};
}

function find(pattern: string | NapiConfig, files: FileScope = "."): SgMatch[] {
	return findMatches("sg.find", pattern, files);
}

function findMatches(helper: string, pattern: string | NapiConfig, files: FileScope): SgMatch[] {
	const matches: SgMatch[] = [];
	const ranges = scopeRanges(helper, files);
	const search = patternSearch(helper, pattern);
	for (const file of sourceFiles(helper, files)) {
		const parsed = parseFile(file);
		if (!parsed) continue;
		for (const node of search.nodes(file, parsed.root)) {
			const match = toMatch(file, node, parsed.source, pattern);
			if (withinScope(match, ranges)) matches.push(match);
		}
	}
	search.finish();
	return matches;
}

function one(pattern: string | NapiConfig, files: FileScope = "."): SgMatch {
	const matches = findMatches("sg.one", pattern, files);
	if (matches.length !== 1)
		throw new Error(`sg.one expected exactly one match, found ${matches.length} for ${JSON.stringify(pattern)}`);
	return matches[0];
}

/**
 * A class method written on its own ("name($$$ARGS) { $$$BODY }") does not parse as one node, so it is
 * matched as a method of a class instead. Other fragments keep the parse failure, with how to fix it.
 */
function findNodes(helper: string, root: SgNode, pattern: string | NapiConfig): SgNode[] {
	try {
		return root.findAll(pattern);
	} catch (error) {
		if (typeof pattern !== "string" || !(error instanceof Error) || !error.message.includes("Multiple AST nodes"))
			throw error;
		try {
			return root.findAll({
				rule: { pattern: { context: `class C { ${pattern} }`, selector: "method_definition" } },
			});
		} catch {
			// Not a class member either. Preserve the original failure below.
		}
		throw new PatternParseError(
			`${helper}: ${error.message}\nPatterns must parse as one syntax node. For a fragment, use { rule: { pattern: { context: "complete surrounding code", selector: "node_kind" } } }.`,
		);
	}
}

/** A string pattern that doesn't parse as one node in some file's language. */
class PatternParseError extends Error {}

/**
 * Finds a pattern across files of several languages. A pattern can parse in one and not another, as
 * `useState<$T>($A)` parses as TypeScript but not as HTML or JavaScript: such a file has no match. It's an error
 * only when nothing matched and it parsed in no JS or TS file, since HTML takes almost any text as content.
 */
function patternSearch(helper: string, pattern: string | NapiConfig) {
	let parsedInScript = false;
	let matched = false;
	let failure: PatternParseError | undefined;
	return {
		nodes(file: string, root: SgNode): SgNode[] {
			try {
				const nodes = findNodes(helper, root, pattern);
				if (/\.[cm]?[jt]sx?$/.test(file)) parsedInScript = true;
				if (nodes.length) matched = true;
				return nodes;
			} catch (error) {
				if (!(error instanceof PatternParseError)) throw error;
				failure ??= error;
				return [];
			}
		},
		finish(): void {
			if (failure && !parsedInScript && !matched) throw failure;
		},
	};
}

/** Explicit destinations may be ignored or missing, but cannot resolve outside the repository. */
function placementFile(path: string) {
	return selectFile(explicitPath(path));
}

function explicitPath(path: string): string {
	let ancestor = resolve(repositoryRoot, gitPath(checkedPath(path)));
	const missing: string[] = [];
	while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
		missing.unshift(basename(ancestor));
		ancestor = dirname(ancestor);
	}
	const target = resolve(realpathSync(ancestor), ...missing);
	const relativeTarget = relative(realpathSync(repositoryRoot), target);
	if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
		throw new Error(`path is outside the repository: ${JSON.stringify(path)}`);
	}
	return target;
}

/** Text replaces the whole match; native edits replace nodes within it. Other listed values skip. */
export type RewriteResult = string | Edit | readonly Edit[] | null | undefined | false;

function replacementEdits(result: unknown, match: SgMatch, file: string): Edit[] {
	const node = match.node;
	if (result === null || result === undefined || result === false) return [];
	if (typeof result === "string") return [node.replace(result)];
	const location = `${JSON.stringify(file)}:${node.range().start.line + 1}`;
	const invalid = (detail: string): never => {
		throw new Error(
			`sg.rewrite at ${location}: ${detail}. Return text, a node.replace(...) edit, an array of edits, or null/undefined/false to skip.`,
		);
	};
	if (typeof result === "object" && result !== null && "then" in result && typeof result.then === "function") {
		return invalid("Received a Promise/thenable; rewrite callbacks are synchronous");
	}
	const edits = Array.isArray(result) ? result : [result];
	const bounds = (match.call ?? node).replace("");
	return Array.from(edits, (edit): Edit => {
		if (
			typeof edit !== "object" ||
			edit === null ||
			!Number.isSafeInteger(edit.startPos) ||
			!Number.isSafeInteger(edit.endPos) ||
			typeof edit.insertedText !== "string"
		) {
			return invalid(`Unsupported callback result (${edit === null ? "null in edit array" : typeof edit})`);
		}
		if (edit.startPos < bounds.startPos || edit.endPos > bounds.endPos || edit.endPos < edit.startPos) {
			return invalid(
				`Edit range [${edit.startPos}, ${edit.endPos}) is outside match [${bounds.startPos}, ${bounds.endPos}) or reversed`,
			);
		}
		return { startPos: edit.startPos, endPos: edit.endPos, insertedText: edit.insertedText };
	});
}

const rewriteStaleAdvice =
	"this match predates a change to its file. For independent edits from one selection, rerun with sg.rewrite(matches, callback) to apply them together. Otherwise, select again after editing.";

type Replacement = string | ((match: SgMatch) => RewriteResult);
type RewriteArgs =
	| [pattern: string | NapiConfig, replacement: Replacement, files?: FileScope]
	| [matches: SgMatch | readonly SgMatch[], replacement: Replacement];

const METAVARIABLE = /(\$\$\$|\$)([A-Z_][A-Z0-9_]*)/g;

/** A template's metavariables that the pattern doesn't capture: a typo would otherwise be written out literally. */
function checkTemplate(template: string, captured: ReadonlySet<string>): void {
	// `$$$`, `$_` and names starting with `_` match without capturing, so a template can't refer to them: `$$$` would
	// be written out as is, and `$$$_REST` as nothing.
	const uncaptured = /\$\$\$(?![A-Z_])|\$+_[A-Z0-9_]*/.exec(template);
	if (uncaptured)
		throw new Error(
			`sg.rewrite: the replacement uses ${uncaptured[0]}, which captures nothing. Name it without a leading underscore in both the pattern and the replacement, such as $$$ARGS.`,
		);
	const unknown = [...new Set([...template.matchAll(METAVARIABLE)].map((match) => match[0]))].filter(
		(name) => !captured.has(name.replace(/^\$+/, "")),
	);
	if (unknown.length)
		throw new Error(
			`sg.rewrite: the replacement uses ${unknown.join(", ")}, which the pattern doesn't capture${captured.size ? ` (it captures ${[...captured].map((name) => `$${name}`).join(", ")})` : ""}. For literal text like that, return it from a callback.`,
		);
}

const matchRange = (match: SgMatch) => match.node.range();

/**
 * Where a template replacement's own text is, as opposed to text its metavariables carried over from the match.
 * Only that text is new: a later pattern may still rewrite the original code a capture carried along.
 */
const literalText = new WeakMap<Edit, [number, number][]>();

function interpolate(template: string, match: SgMatch): { text: string; literal: [number, number][] } {
	let text = "";
	const literal: [number, number][] = [];
	let last = 0;
	for (const variable of template.matchAll(METAVARIABLE)) {
		const before = template.slice(last, variable.index);
		if (before) literal.push([text.length, text.length + before.length]);
		text += before + (match.vars[variable[2]!] ?? variable[0]);
		last = variable.index + variable[0].length;
	}
	const rest = template.slice(last);
	if (rest) literal.push([text.length, text.length + rest.length]);
	return { text: text + rest, literal };
}

/**
 * A callback's text without what it carried over from the match: wherever it repeats the match or a captured value,
 * as `console.info(${m.vars.A})` does, that text is the original code rather than new.
 */
function outsideCaptures(text: string, match: SgMatch): [number, number][] {
	const carried: [number, number][] = [];
	// The whole match counts too: `"async " + m.text` carries all of it over.
	for (const value of [match.text, ...Object.values(match.vars)]
		.filter(Boolean)
		.toSorted((a, b) => b.length - a.length))
		for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length))
			if (!carried.some(([from, to]) => at < to && at + value.length > from)) carried.push([at, at + value.length]);
	const literal: [number, number][] = [];
	let last = 0;
	for (const [from, to] of carried.toSorted((a, b) => a[0] - b[0])) {
		if (from > last) literal.push([last, from]);
		last = to;
	}
	if (last < text.length) literal.push([last, text.length]);
	return literal;
}

/** Whether two edits conflict. The same edit twice is one edit, as when a call is found through a class and its interface. */
function conflicting(a: Edit, b: Edit): boolean {
	if (a.startPos === b.startPos && a.endPos === b.endPos && a.insertedText === b.insertedText) return false;
	return a.startPos === b.startPos || (a.startPos < b.endPos && b.startPos < a.endPos);
}

function applyRewrites(
	matches: readonly SgMatch[],
	replacement: Replacement,
	file: string,
	nested: SgMatch[] = [],
): number {
	const planned: { match: SgMatch; edits: Edit[] }[] = [];
	for (const match of matches) {
		if (typeof replacement === "string") checkTemplate(replacement, new Set(Object.keys(match.vars)));
		const template = typeof replacement === "string" ? interpolate(replacement, match) : undefined;
		const result = template
			? template.text
			: programCode(() => (replacement as (match: SgMatch) => RewriteResult)(match));
		const changes = replacementEdits(result, match, file);
		if (template && changes[0]) literalText.set(changes[0], template.literal);
		else if (typeof result === "string" && changes[0]) literalText.set(changes[0], outsideCaptures(result, match));
		if (changes.length > 0) planned.push({ match, edits: changes });
	}
	// Outer matches first. A match inside one whose edits it clashes with is left alone, as ast-grep's CLI does:
	// in p.then(a).then(b), rewriting the outer call already rewrote from the original text of the inner one.
	planned.sort(
		(a, b) =>
			matchRange(a.match).start.index - matchRange(b.match).start.index ||
			matchRange(b.match).end.index - matchRange(a.match).end.index,
	);
	const kept: typeof planned = [];
	for (const entry of planned) {
		const outer = kept.find((other) => other.edits.some((edit) => entry.edits.some((mine) => conflicting(edit, mine))));
		const [o, e] = outer ? [matchRange(outer.match), matchRange(entry.match)] : [];
		const inside =
			o &&
			e &&
			o.start.index <= e.start.index &&
			e.end.index <= o.end.index &&
			(o.start.index !== e.start.index || o.end.index !== e.end.index);
		if (inside) nested.push(entry.match);
		else kept.push(entry);
	}
	const edits = kept.flatMap((entry) => entry.edits);
	const count = kept.length;
	if (edits.length === 0) return 0;
	const source = matches[0].node.getRoot().root().text();
	// Two matches can reach one place, such as a call found through a class and its interface. The same
	// edit twice is one edit; only different edits to the same text conflict.
	const ordered = edits
		// Text breaks ties so identical edits sit together, however the matches were ordered.
		.toSorted(
			(a, b) =>
				a.startPos - b.startPos ||
				b.endPos - a.endPos ||
				(a.insertedText < b.insertedText ? -1 : a.insertedText > b.insertedText ? 1 : 0),
		)
		.filter(
			(edit, i, all) =>
				i === 0 ||
				edit.startPos !== all[i - 1].startPos ||
				edit.endPos !== all[i - 1].endPos ||
				edit.insertedText !== all[i - 1].insertedText,
		);
	for (let i = 1; i < ordered.length; i++) {
		const previous = ordered[i - 1],
			current = ordered[i];
		if (current.startPos < previous.endPos || current.startPos === previous.startPos) {
			const [first, second] = [previous, current].map((edit) => source.slice(0, edit.startPos).split("\n").length);
			const lines = first === second ? `line ${first}` : `lines ${first} and ${second}`;
			throw new Error(
				`sg.rewrite produced overlapping edits in ${JSON.stringify(relative(repositoryRoot, resolve(file)))} at ${lines}; return one edit for each place`,
			);
		}
	}
	// A callback can run arbitrary code, including writes: don't overwrite changes made after selection.
	const sources = new Map<string, string | null>();
	for (const match of matches) getMatchSnapshot(match, sources, rewriteStaleAdvice);
	const output = matches[0].node.getRoot().root().commitEdits(ordered);
	const lang = LANGUAGES[file.split(".").pop()!];
	if (lang && !syntaxErrorAt(matches[0].node.getRoot().root())) {
		const error = syntaxErrorAt(parse(lang, output).root());
		if (error)
			throw new Error(
				`sg.rewrite would leave invalid syntax in ${JSON.stringify(relative(repositoryRoot, resolve(file)))} at line ${error.range().start.line + 1}: ${output.split("\n")[error.range().start.line]!.trim().slice(0, 120)}`,
			);
	}
	recordRewriteOutput(file, source, output, ordered);
	writeFileSync(file, output);
	return count;
}

// Where earlier sg.rewrite calls put their replacements, per file, while the file still holds exactly what
// the last rewrite wrote. Rewrites apply one after another, so a later pattern can match an earlier result:
// rewriting request(u, undefined, t) to request(u, { timeoutMs: t }) creates a new two-argument call.
// Pattern rewrites skip such places; selections the program makes itself are always rewritten. Each range
// keeps where its replacement's own text is: code a metavariable carried over is still the original code.
let explainedSkips = false;
interface OutputRange {
	from: number;
	to: number;
	literal: [number, number][];
}
const rewriteOutputs = new Map<string, { text: string; ranges: OutputRange[] }>();

const moved = (range: OutputRange, by: number): OutputRange => ({
	from: range.from + by,
	to: range.to + by,
	literal: range.literal.map(([from, to]) => [from + by, to + by]),
});

function recordRewriteOutput(file: string, before: string, after: string, all: readonly Edit[]): void {
	// A replacement identical to what it replaced produced nothing, so later rewrites may still match there.
	const edits = all.filter((edit) => edit.insertedText !== before.slice(edit.startPos, edit.endPos));
	const key = resolve(file);
	const previous = rewriteOutputs.get(key);
	const ranges: OutputRange[] = [];
	let shift = 0;
	let next = 0;
	const earlier = previous?.text === before ? previous.ranges : [];
	for (const edit of edits) {
		// Keep earlier ranges this edit leaves alone, moved by the edits before them.
		for (; next < earlier.length && earlier[next]!.to <= edit.startPos; next++)
			ranges.push(moved(earlier[next]!, shift));
		while (next < earlier.length && earlier[next]!.from < edit.endPos) next++;
		const start = edit.startPos + shift;
		const literal = literalText.get(edit) ?? [[0, edit.insertedText.length]];
		ranges.push({
			from: start,
			to: start + edit.insertedText.length,
			literal: literal.map(([from, to]) => [start + from, start + to]),
		});
		shift += edit.insertedText.length - (edit.endPos - edit.startPos);
	}
	for (; next < earlier.length; next++) ranges.push(moved(earlier[next]!, shift));
	rewriteOutputs.set(key, { text: after, ranges });
}

/**
 * Pattern matches that lie inside text an earlier sg.rewrite produced in this file, which is still unchanged,
 * and take in some of that rewrite's own text rather than only code a metavariable carried over.
 */
function insideEarlierOutput(file: string, source: string, matches: readonly SgMatch[]): Set<SgMatch> {
	const recorded = rewriteOutputs.get(resolve(file));
	if (!recorded || recorded.text !== source) return new Set();
	return new Set(
		matches.filter((match) => {
			const { start, end } = match.node.range();
			return recorded.ranges.some(
				(range) =>
					start.index >= range.from &&
					end.index <= range.to &&
					range.literal.some(([from, to]) => start.index < to && end.index > from),
			);
		}),
	);
}

function explainNested(nested: readonly SgMatch[]): void {
	if (!nested.length) return;
	const example = nested[0]!;
	console.error(
		`warning: sg.rewrite left ${nested.length} match${nested.length === 1 ? "" : "es"} inside another match unchanged, e.g. ${gitPath(example.file)}:${example.line} ${example.text.split("\n")[0]}. The outer match was rewritten from the original text. To rewrite the inner ones too, select them again with sg.find and pass the matches to sg.rewrite.`,
	);
}

/** Rewrites patterns or existing selections; returns matches producing edits, not individual edits. */
function rewrite(...[target, replacement, files]: RewriteArgs): number {
	const selected = Array.isArray(target) || (typeof target === "object" && target !== null && "node" in target);
	if (selected) {
		if (files !== undefined)
			throw new Error("sg.rewrite: selected matches already specify their files; omit the file scope");
		const groups = new Map<string, SgMatch[]>();
		const sources = new Map<string, string | null>();
		for (const match of (Array.isArray(target) ? target : [target]) as SgMatch[]) {
			const saved = getMatchSnapshot(match, sources, rewriteStaleAdvice);
			if (!match.vars || typeof match.line !== "number")
				throw new Error("sg.rewrite expects matches from sg.one or sg.find");
			const file = explicitPath(match.file);
			if (file !== saved.file) throw new Error("sg.rewrite: selected file changed; select it again");
			const group = groups.get(file) ?? [];
			group.push(match);
			groups.set(file, group);
		}
		let count = 0;
		const nested: SgMatch[] = [];
		for (const [file, matches] of groups) {
			count += editingFiles([file], () => {
				const currentSources = new Map<string, string | null>();
				for (const match of matches) getMatchSnapshot(match, currentSources, rewriteStaleAdvice);
				return applyRewrites(matches, replacement, file, nested);
			});
		}
		explainNested(nested);
		return count;
	}
	const pattern = target as string | NapiConfig;
	if (typeof replacement === "string")
		checkTemplate(replacement, new Set([...JSON.stringify(pattern).matchAll(METAVARIABLE)].map((match) => match[2]!)));
	const scope = files ?? ".";
	const nested: SgMatch[] = [];
	const ranges = scopeRanges("sg.rewrite", scope);
	let count = 0,
		matched = 0;
	const skipped: SgMatch[] = [];
	const search = patternSearch("sg.rewrite", pattern);
	for (const file of sourceFiles("sg.rewrite", scope)) {
		count += editingFiles([file], () => {
			const parsed = parseFile(file);
			if (!parsed) return 0;
			const matches = search
				.nodes(file, parsed.root)
				.map((node) => toMatch(file, node, parsed.source, pattern))
				.filter((match) => withinScope(match, ranges));
			matched += matches.length;
			const earlier = insideEarlierOutput(file, parsed.source, matches);
			skipped.push(...earlier);
			return applyRewrites(
				matches.filter((match) => !earlier.has(match)),
				replacement,
				file,
				nested,
			);
		});
	}
	search.finish();
	explainNested(nested);
	if (matched === 0) {
		console.error(`warning: sg.rewrite matched nothing for ${JSON.stringify(pattern)} in ${describeScope(scope)}`);
	}
	// The explanation applies to every later rewrite too, so it is given once per program.
	if (skipped.length > 0 && !explainedSkips) {
		explainedSkips = true;
		const example = skipped[0]!;
		console.error(
			`warning: sg.rewrite skipped ${skipped.length} place${skipped.length === 1 ? "" : "s"} inside text an earlier sg.rewrite produced, e.g. ${gitPath(example.file)}:${example.line} ${example.text.split("\n")[0]}. Rewrites apply one after another, so this pattern would have rewritten that output a second time. To rewrite those places anyway, select them with sg.find and pass the matches to sg.rewrite.`,
		);
	}
	return count;
}

const skippedNotUtf8 = new Set<string>();

/** A JS/TS/HTML/CSS file's source and syntax tree, or null for other files and files that aren't UTF-8. */
function parseFile(file: string) {
	const lang = LANGUAGES[file.split(".").pop()!];
	if (!lang) return null;
	let source: string;
	try {
		source = readUtf8(file);
	} catch (error) {
		if (!(error instanceof NotUtf8Error)) throw error;
		if (!skippedNotUtf8.has(resolve(file))) {
			skippedNotUtf8.add(resolve(file));
			console.error(`warning: skipped ${gitPath(file)}: it isn't valid UTF-8, and editing it here would corrupt it`);
		}
		return null;
	}
	return { source, root: parse(lang, source).root() };
}

function toMatch(
	file: string,
	node: SgNode,
	source: string,
	pattern: string | NapiConfig,
	sourceFile = file,
	call?: SgNode,
): SgMatch {
	const vars: Record<string, string> = {};
	for (const [, dollars, name] of JSON.stringify(pattern).matchAll(/(\$\$\$|\$)([A-Z_][A-Z0-9_]*)/g)) {
		if (dollars === "$$$") {
			vars[name] = sequenceText(node.getMultipleMatches(name), source);
		} else {
			const captured = node.getMatch(name);
			if (captured) vars[name] = captured.text();
		}
	}
	return remember(
		{ ...vars, file, line: node.range().start.line + 1, text: node.text(), vars, node, call },
		source,
		true,
		sourceFile,
	);
}

/**
 * A `$$$` capture's text, sliced from the original source so separators and formatting are kept ("a, b" rather than
 * "a,b"), but without a trailing comma: in `f(\n  a,\n  b,\n)`, `f($$$ARGS, c)` would otherwise give `b,, c`. A
 * trailing comment is kept; a line comment then ends the line, so the rest of the template isn't commented out.
 */
function sequenceText(nodes: SgNode[], source: string): string {
	const lastItem = nodes.findLastIndex((item) => item.kind() !== "," && item.kind() !== "comment");
	if (lastItem < 0) return "";
	const comments = nodes.slice(lastItem + 1).filter((item) => item.kind() === "comment");
	const text =
		source.slice(nodes[0]!.range().start.index, nodes[lastItem]!.range().end.index) +
		comments.map((comment) => ` ${comment.text()}`).join("");
	return comments.at(-1)?.text().startsWith("//") ? `${text}\n` : text;
}

/** A reference can edit its enclosing call only when it names the callee. */
function referenceCall(node: SgNode): SgNode | undefined {
	let callee = node;
	const parent = node.parent();
	if (parent?.kind() === "member_expression") {
		const property = parent.field("property")?.range();
		const span = node.range();
		if (!property || property.start.index !== span.start.index || property.end.index !== span.end.index) return;
		callee = parent;
	}
	const call = callee.parent();
	if (call?.kind() !== "call_expression" && call?.kind() !== "new_expression") return;
	const called = call.field(call.kind() === "new_expression" ? "constructor" : "function")?.range();
	const span = callee.range();
	return called?.start.index === span.start.index && called.end.index === span.end.index ? call : undefined;
}

function referenceMatches(locations: ReferenceLocation[]): SgMatch[] {
	const parsed = new Map<string, NonNullable<ReturnType<typeof parseFile>>>();
	return locations.map(({ uri, range }) => {
		const file = fileURLToPath(uri);
		let document = parsed.get(file);
		if (!document) {
			document = parseFile(file) ?? undefined;
			if (!document) throw new Error(`refactor.references cannot parse ${JSON.stringify(file)}`);
			parsed.set(file, document);
		}
		const start = range.start;
		const end = range.end;
		const node = document.root
			.findAll({
				rule: {
					any: [
						"identifier",
						"type_identifier",
						"property_identifier",
						"private_property_identifier",
						"shorthand_property_identifier",
						"shorthand_property_identifier_pattern",
						"string_fragment",
					].map((kind) => ({ kind })),
				},
			})
			.find((candidate) => {
				const span = candidate.range();
				return (
					span.start.line === start.line &&
					span.start.column === start.character &&
					span.end.line === end.line &&
					span.end.column === end.character
				);
			});
		if (!node)
			throw new Error(`refactor.references could not locate the identifier at ${gitPath(file)}:${start.line + 1}`);
		return toMatch(gitPath(file), node, document.source, "", file, referenceCall(node));
	});
}

function normalizeEditLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Replace exactly one literal occurrence, tolerating line endings. Synchronous; await is safe. */
function editText(options: { path: string; oldText: string; newText: string }): void {
	const { oldText, newText } = options;
	const path = pathArgument("edit", options.path);
	if (typeof oldText !== "string" || typeof newText !== "string")
		throw new Error("edit expects { path, oldText, newText } strings");
	if (!oldText) throw new Error("edit: oldText must not be empty; use Bun.write to create a file");
	const source = readUtf8(path);
	const searchable = normalizeEditLineEndings(source);
	const needle = normalizeEditLineEndings(oldText);
	const start = searchable.indexOf(needle);
	if (start === -1)
		throw new Error(`edit ${JSON.stringify(path)}: oldText not found; read the file and use its exact text`);
	if (searchable.indexOf(needle, start + 1) !== -1)
		throw new Error(`edit ${JSON.stringify(path)}: oldText matches more than once; include more surrounding text`);
	// Translate normalized offsets back so untouched bytes (including BOMs and mixed endings) survive.
	const originalOffset = (offset: number) => {
		let original = 0;
		for (let normalized = 0; normalized < offset; normalized++, original++) {
			if (source[original] === "\r" && source[original + 1] === "\n") original++;
		}
		return original;
	};
	writeFileSync(
		path,
		source.slice(0, originalOffset(start)) + newText + source.slice(originalOffset(start + needle.length)),
	);
}

const globals = {
	$,
	edit: atCaller((...args: Parameters<typeof editText>) =>
		logged("edit", args, () => {
			const path = pathArgument("edit", args[0]?.path);
			return editingFiles([path], () => editText({ ...args[0], path }));
		}),
	),
	glob: atCaller((...args: Parameters<typeof glob>) => logged("glob", args, () => glob(...args))),
	grep: atCaller((...args: Parameters<typeof grep>) => logged("grep", args, () => grep(...args))),
	sg: {
		...astGrep,
		find: atCaller((...args: Parameters<typeof find>) => logged("sg.find", args, () => find(...args))),
		one: atCaller((...args: Parameters<typeof one>) => logged("sg.one", args, () => one(...args))),
		file: atCaller((path: string) => logged("sg.file", [path], () => placementFile(pathArgument("sg.file", path)))),
		insert: atCaller((...args: Parameters<typeof insert>) => logged("sg.insert", args, () => insert(...args))),
		move: atCaller((...args: Parameters<typeof move>) => {
			const [match, destination, transform] = args;
			const own = transform && ((text: string) => programCode(() => transform(text)));
			return logged("sg.move", args, () => move(match, destination, own));
		}),
		remove: atCaller((...args: Parameters<typeof remove>) => logged("sg.remove", args, () => remove(...args))),
		rewrite: atCaller((...args: Parameters<typeof rewrite>) => logged("sg.rewrite", args, () => rewrite(...args))),
	},
	refactor: {
		rename: (
			options:
				| RenameOptions<string | GraphNode>
				| (Omit<RenameOptions<string | GraphNode>, "symbol"> & { symbol?: string }),
		) =>
			logged("refactor.rename", [options], () => {
				const prepared = {
					...options,
					...refactorTarget("refactor.rename", options),
				};
				return import("../refactor/typescript-refactors.ts").then(({ rename }) =>
					rename(repositoryRoot, prepared as RenameOptions),
				);
			}),
		references: (
			options:
				| ReferencesOptions<string | GraphNode>
				| (Omit<ReferencesOptions<string | GraphNode>, "symbol"> & { symbol?: string }),
		) =>
			logged("refactor.references", [options], async () => {
				const prepared = { ...options, ...refactorTarget("refactor.references", options) };
				const { references } = await import("../refactor/typescript-refactors.ts");
				return referenceMatches(await references(repositoryRoot, prepared as ReferencesOptions));
			}),
		move: (options: { file: string | GraphNode; symbol?: string; to: string }) =>
			logged("refactor.move", [options], async () => {
				const target = refactorTarget("refactor.move", options);
				const from = explicitPath(target.file);
				const to = explicitPath(pathArgument("refactor.move", options.to));
				if (typeof target.symbol !== "string" || !target.symbol)
					throw new TypeError("refactor.move expects { file, symbol, to } with a symbol name");
				if (target.symbol.includes("."))
					throw new Error(`refactor.move only moves top-level declarations; ${target.symbol} names a member`);
				await moveDeclaration(from, target.symbol, to, {
					root: repositoryRoot,
					scripts: scriptFiles,
					loadingModules: filesLoadingModules,
					reexportingAll: filesReexportingAll,
				});
			}),
		renameFile: (options: RenameFileOptions) =>
			logged("refactor.renameFile", [options], () => {
				const prepared = {
					from: pathArgument("refactor.renameFile", options.from),
					to: pathArgument("refactor.renameFile", options.to),
				};
				return import("../refactor/typescript-refactors.ts").then(({ renameFile }) =>
					renameFile(repositoryRoot, prepared),
				);
			}),
	},
	graph: { query: queryGraph },
};

export type ShorthandGlobals = typeof globals;
Object.assign(globalThis, globals);
