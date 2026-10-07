import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { Lang, parse } from "@ast-grep/napi";
import { SymbolFlags } from "typescript/unstable/async";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { editingFiles } from "../program/file-outcomes.ts";
import {
	checkerProject,
	documentDiagnostics,
	notifyTypeScriptServer,
	recordTypeScriptFiles,
	withTypeScriptServer,
	type Diagnostic,
} from "./lsp-client.ts";
import { relativeCandidates, resolveModule } from "./move-imports.ts";
import { moveDeclaration, scriptLanguage, withoutComments, type MoveFiles } from "./placement.ts";
import {
	existingProjectFile,
	planWorkspaceEdit,
	projectPath,
	shiftedOffset,
	type PlacedEdit,
	type Position,
	type Range,
	type WorkspaceEdit,
} from "./workspace-edit.ts";

export interface RenameOptions<File = string> {
	file: File;
	symbol: string;
	to: string;
}

export interface ReferencesOptions<File = string> {
	file: File;
	symbol: string;
	includeDeclaration?: boolean;
}

export interface ReferenceLocation {
	uri: string;
	range: Range;
}

export interface RenameFileOptions<File = string> {
	from: File;
	to: File;
}

interface DocumentSymbol {
	name: string;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

interface SymbolInformation {
	name: string;
	containerName?: string;
	location: { range: Range };
}

export async function rename(root: string, options: RenameOptions): Promise<void> {
	validateRename(options);
	const file = existingProjectFile(root, options.file);
	const from = options.symbol.split(".").at(-1)!;
	const { to } = options;
	await withTypeScriptServer(root, async (server) => {
		const symbols = await server.sendRequest<Array<DocumentSymbol | SymbolInformation> | null>(
			"textDocument/documentSymbol",
			{ textDocument: { uri: pathToFileURL(file).href } },
		);
		const position = symbolPosition(
			symbols ?? [],
			options.symbol,
			options.file,
			"refactor.rename",
			readFileSync(file, "utf8"),
		);
		const checked = checkedEdits(server, root);
		// Where the new name was written, as offsets in each file's current contents.
		const sites = new Map<string, number[]>();
		const place = async (changes: Map<string, string>, placed: Map<string, PlacedEdit[]>) => {
			await checked.write(changes);
			for (const [changed, edits] of placed) {
				const kept = (sites.get(changed) ?? []).map((offset) => shiftedOffset(offset, edits));
				for (const edit of edits) {
					const at = edit.text.search(wholeWord(to));
					if (at >= 0) kept.push(edit.start + at);
				}
				sites.set(changed, kept);
			}
		};
		const renameAt = async (target: string, at: Position) => {
			const placed = new Map<string, PlacedEdit[]>();
			const edit = await server.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
				textDocument: { uri: pathToFileURL(target).href },
				position: at,
				newName: to,
			});
			const changes = planWorkspaceEdit(root, edit, placed);
			await place(changes, placed);
			return changes.size;
		};

		try {
			// TypeScript renames the variable behind `{ parseUser }`, so a member written that way is spelled out
			// first, as `{ parseUser: parseUser }`, and its key renamed.
			if (options.symbol.includes(".")) {
				const source = readFileSync(file, "utf8");
				const offset = offsetOf(source, position);
				const lang = scriptLanguage(file);
				const shorthand = lang
					? parse(lang, source)
							.root()
							.findAll({ rule: { kind: "shorthand_property_identifier" } })
							.some((node) => node.range().start.index === offset)
					: false;
				if (shorthand) {
					const text = `${from}: `;
					await place(
						new Map([[file, source.slice(0, offset) + text + source.slice(offset)]]),
						new Map([[file, [{ oldStart: offset, oldEnd: offset, start: offset, text }]]]),
					);
				}
			}
			if ((await renameAt(file, position)) === 0)
				throw new Error(`TypeScript returned no edits for ${JSON.stringify(options.symbol)}`);
			// TypeScript renames without changing what other code sees: an object literal keeps its key
			// (`{ from: to }`), and a module keeps its export's name (`export { to as from }`), as does an importer
			// its local name. The keys stay; each alias is renamed in turn, so the new name goes everywhere else.
			for (let round = 0; round < 100; round++) {
				const alias = findAlias([...sites.keys()], to, from);
				if (!alias) break;
				await renameAt(alias.file, positionOf(alias.source, alias.offset));
				const collapsed = collapseAliases(readFileSync(alias.file, "utf8"), to);
				if (!collapsed) break;
				await place(new Map([[alias.file, collapsed.source]]), new Map([[alias.file, collapsed.edits]]));
			}
			await checked.verify(
				`refactor.rename of ${JSON.stringify(options.symbol)} to ${to}`,
				(message) => message.replaceAll(`'${to}'`, `'${from}'`),
				await capturedPlaces(server, checked.root, sites, to),
			);
		} catch (error) {
			await checked.restore();
			throw error;
		}
	});
}

const escaped = (name: string) => name.replaceAll("$", "\\$");
const wholeWord = (name: string) => new RegExp(`(?<![\\w$])${escaped(name)}(?![\\w$])`);

/** An import or export specifier `to as from` that a rename introduced, and the offset of its `from`. */
function findAlias(
	files: string[],
	to: string,
	from: string,
): { file: string; source: string; offset: number } | undefined {
	const specifier = new RegExp(`([{,]\\s*(?:type\\s+)?${escaped(to)} as )${escaped(from)}(?=\\s*[,}])`);
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		const match = specifier.exec(source);
		if (match) return { file, source, offset: match.index + match[1]!.length };
	}
	return undefined;
}

/** `{ to as to }` as `{ to }`, once its alias has been renamed. */
function collapseAliases(source: string, to: string): { source: string; edits: PlacedEdit[] } | undefined {
	const specifier = new RegExp(`([{,]\\s*(?:type\\s+)?)${escaped(to)} as ${escaped(to)}(?=\\s*[,}])`, "g");
	const edits: PlacedEdit[] = [];
	let shift = 0;
	for (const match of source.matchAll(specifier)) {
		const oldStart = match.index + match[1]!.length;
		const oldEnd = match.index + match[0].length;
		edits.push({ oldStart, oldEnd, start: oldStart + shift, text: to });
		shift += to.length - (oldEnd - oldStart);
	}
	if (!edits.length) return undefined;
	let output = source;
	for (const edit of edits.toReversed())
		output = output.slice(0, edit.oldStart) + edit.text + output.slice(edit.oldEnd);
	return { source: output, edits };
}

/**
 * Writes a refactor's files and then checks the result with TypeScript instead of predicting it: the files it
 * touched, and the files that import them, must have no type errors they didn't have before. Otherwise the
 * caller puts the files back and the refactor is refused with what went wrong.
 */
function checkedEdits(
	server: Parameters<typeof notifyTypeScriptServer>[0],
	projectRoot: string,
	scripts: () => string[] = () => projectScripts(projectRoot),
) {
	const root = realpathSync(projectRoot);
	// Each touched file's contents before, or undefined for a file the refactor creates.
	const originals = new Map<string, string | undefined>();
	const before = new Map<string, Diagnostic[]>();
	const errors = async (file: string) =>
		existsSync(file)
			? (await documentDiagnostics(server, file)).filter((diagnostic) => (diagnostic.severity ?? 1) === 1)
			: [];
	const notify = (files: string[]) =>
		filesChanged(
			server,
			files.filter((file) => originals.get(file) !== undefined && existsSync(file)),
			files.filter((file) => originals.get(file) !== undefined && !existsSync(file)),
			files.filter((file) => originals.get(file) === undefined && existsSync(file)),
		);
	const checked = {
		root,
		/** Notes the contents and errors of files about to change, and of the files that import them. */
		async track(files: string[]) {
			const fresh = files.filter((file) => !originals.has(file));
			for (const file of fresh) originals.set(file, existsSync(file) ? readFileSync(file, "utf8") : undefined);
			// A file that imports a changed one can break without changing, such as a barrel whose `export *`
			// now exports the same name twice.
			const existing = fresh.filter((file) => originals.get(file) !== undefined);
			for (const file of [...fresh, ...(await importersOf(server, existing, scripts()))])
				if (!before.has(file)) before.set(file, await errors(file));
		},
		async write(changes: Map<string, string>) {
			await checked.track([...changes.keys()]);
			editingFiles([...changes.keys()], () => {
				for (const [file, source] of changes) writeFileSync(file, source);
			});
			await notify([...changes.keys()]);
		},
		async restore() {
			if (!originals.size) return;
			const files = [...originals.keys()];
			editingFiles(files, () => {
				for (const [file, source] of originals)
					if (source === undefined) rmSync(file, { force: true });
					else writeFileSync(file, source);
			});
			await notify(files);
			originals.clear();
		},
		/**
		 * Refuses if a checked file has an error it didn't have before. `same` maps an error's message to how it
		 * would have read before, such as with the old name; `problems` are any the caller found itself.
		 */
		async verify(what: string, same: (message: string) => string = (message) => message, problems: string[] = []) {
			await notify([...before.keys()].filter((file) => originals.has(file)));
			// Errors are compared across the files together, since moved code takes its errors with it, and a
			// relative path in one is only compared by the file it names, as moving a file changes the path.
			const key = (diagnostic: Diagnostic) =>
				`${diagnostic.code}:${same(diagnostic.message).replaceAll(/(["'])\.{1,2}\/(?:[^"'\n]*\/)?([^"'\n/]*)\1/g, "$1$2$1")}`;
			const existing = new Map<string, number>();
			for (const diagnostic of [...before.values()].flat())
				existing.set(key(diagnostic), (existing.get(key(diagnostic)) ?? 0) + 1);
			for (const file of before.keys()) {
				for (const diagnostic of await errors(file)) {
					const left = existing.get(key(diagnostic)) ?? 0;
					if (left > 0) existing.set(key(diagnostic), left - 1);
					else problems.push(`${relative(root, file)}:${diagnostic.range.start.line + 1}: ${diagnostic.message}`);
				}
			}
			if (problems.length)
				throw new Error(
					`${what} would break the code, so nothing was changed:\n${problems
						.slice(0, 10)
						.map((problem) => `  ${problem}`)
						.join("\n")}`,
				);
		},
	};
	return checked;
}

/**
 * refactor.move, checked: moves the declaration with moveDeclaration, then refuses and puts everything back if
 * the source, the target or a file importing either has a type error it didn't have before, such as an import
 * the moved code now assigns to, or a barrel that would export a name twice.
 */
export async function moveSymbol(from: string, symbol: string, to: string, files: MoveFiles): Promise<void> {
	await withTypeScriptServer(files.root, async (server) => {
		const checked = checkedEdits(server, files.root, files.scripts);
		// The importers of the source are the files the move may repoint.
		await checked.track([from, to, ...(await importersOf(server, [from], files.scripts()))]);
		try {
			await moveDeclaration(from, symbol, to, files);
			await checked.verify(`refactor.move of ${symbol} to ${relative(files.root, to)}`);
		} catch (error) {
			await checked.restore();
			throw error;
		}
	});
}

const where = (uri: string, position: Position) => `${uri}:${position.line}:${position.character}`;

/**
 * Places given the new name that now mean something else: the checker's symbol there, through any import, is
 * declared somewhere other than those places, as when the new name is captured by a declaration in scope there. For a file
 * outside every tsconfig, the server's definition is asked instead.
 */
async function capturedPlaces(
	server: Parameters<typeof notifyTypeScriptServer>[0],
	root: string,
	sites: Map<string, number[]>,
	name: string,
): Promise<string[]> {
	// The checker counts UTF-16 units after a byte order mark; a declaration is known by where its name ends.
	const bom = new Map([...sites.keys()].map((file) => [file, readFileSync(file, "utf8").startsWith("\uFEFF") ? 1 : 0]));
	const renamedEnds = new Set(
		[...sites].flatMap(([file, offsets]) =>
			offsets.map((offset) => `${file.toLowerCase()}:${offset - bom.get(file)! + name.length}`),
		),
	);
	const problems: string[] = [];
	for (const [file, offsets] of sites) {
		const source = readFileSync(file, "utf8");
		const project = await checkerProject(server, file);
		if (!project) {
			problems.push(...(await definitionsElsewhere(server, root, file, source, offsets, sites, name)));
			continue;
		}
		const symbols = await project.checker.getSymbolAtPosition(
			file,
			offsets.map((offset) => offset - bom.get(file)!),
		);
		for (const [index, found] of symbols.entries()) {
			if (!found) continue;
			const symbol = found.flags & SymbolFlags.Alias ? await project.checker.getAliasedSymbol(found) : found;
			const declared = await Promise.all(
				symbol.declarations.map(async (handle) => {
					const node = (await handle.resolve(project)) as { name?: { end: number } } | undefined;
					return node?.name ? { handle, end: node.name.end } : undefined;
				}),
			);
			// Every declaration: renamed into an existing interface, a symbol merges with it and keeps both.
			const other = declared.find(
				(declaration) => declaration && !renamedEnds.has(`${declaration.handle.path.toLowerCase()}:${declaration.end}`),
			);
			if (!other) continue;
			const otherFile = other && (await project.program.getSourceFile(other.handle.path));
			const position = positionOf(source, offsets[index]!);
			problems.push(
				`${relative(root, file)}:${position.line + 1}: ${name} would refer to ${
					otherFile
						? `${relative(root, otherFile.fileName)}:${otherFile.text.slice(0, other.end).split("\n").length}`
						: "something else"
				} instead`,
			);
		}
	}
	return problems;
}

/** capturedPlaces for a file the checker doesn't have: the server's definition of each place must be one of them. */
async function definitionsElsewhere(
	server: Parameters<typeof notifyTypeScriptServer>[0],
	root: string,
	file: string,
	source: string,
	offsets: number[],
	sites: Map<string, number[]>,
	name: string,
): Promise<string[]> {
	const renamed = new Set(
		[...sites].flatMap(([site, places]) => {
			const text = site === file ? source : readFileSync(site, "utf8");
			return places.map((offset) => where(pathToFileURL(site).href, positionOf(text, offset)));
		}),
	);
	const problems: string[] = [];
	for (const offset of offsets) {
		const position = positionOf(source, offset);
		const definitions =
			(await server.sendRequest<Array<{ uri: string; range: Range }> | { uri: string; range: Range } | null>(
				"textDocument/definition",
				{ textDocument: { uri: pathToFileURL(file).href }, position },
			)) ?? [];
		const other = [definitions]
			.flat()
			.find((definition) => !renamed.has(where(definition.uri, definition.range.start)));
		if (other)
			problems.push(
				`${relative(root, file)}:${position.line + 1}: ${name} would refer to ${relative(root, fileURLToPath(other.uri))}:${other.range.start.line + 1} instead`,
			);
	}
	return problems;
}

/** The offset of a position the server gave, which counts characters after a byte order mark. */
function offsetOf(source: string, position: Position): number {
	let offset = source.startsWith("\uFEFF") ? 1 : 0;
	for (let line = 0; line < position.line; line++) offset = source.indexOf("\n", offset) + 1;
	return offset + position.character;
}

/** The position of an offset, as the server counts it: after a byte order mark. */
function positionOf(source: string, offset: number): Position {
	const bom = source.startsWith("﻿") ? 1 : 0;
	const before = source.slice(0, offset);
	const line = before.split("\n").length - 1;
	const lineStart = before.lastIndexOf("\n") + 1;
	return { line, character: offset - lineStart - (line === 0 ? bom : 0) };
}

/** Compiler-resolved reference spans, kept as LSP locations for the caller to turn into sg matches. */
export async function references(root: string, options: ReferencesOptions): Promise<ReferenceLocation[]> {
	if (!options || typeof options.file !== "string" || typeof options.symbol !== "string")
		throw new TypeError("refactor.references expects { file, symbol } strings");
	if (!options.file || !options.symbol) throw new Error("refactor.references file and symbol must not be empty");
	const file = existingProjectFile(root, options.file);
	const uri = pathToFileURL(file).href;
	return withTypeScriptServer(root, async (server) => {
		const symbols = await server.sendRequest<Array<DocumentSymbol | SymbolInformation> | null>(
			"textDocument/documentSymbol",
			{ textDocument: { uri } },
		);
		const position = symbolPosition(
			symbols ?? [],
			options.symbol,
			options.file,
			"refactor.references",
			readFileSync(file, "utf8"),
		);
		return (
			(await server.sendRequest<ReferenceLocation[] | null>("textDocument/references", {
				textDocument: { uri },
				position,
				context: { includeDeclaration: options.includeDeclaration === true },
			})) ?? []
		);
	});
}

/**
 * The server renames without aliases, so imports and re-exports follow the new name (see lsp-client.ts). That
 * would also change the key of an object literal shorthand such as `{ parseUser }`, while reads of that property
 * keep the old key. Expand those to `parseUser: decodeUser` so only the referenced value changes.
 */
/**
 * Moves a file by writing it anew and removing the old one. A rename within one directory, such as `a.ts` to
 * `a.tsx`, isn't recorded correctly by the macOS workspace (AgentFS), and the run can't be applied.
 */
function moveFile(from: string, to: string): void {
	const stats = lstatSync(from);
	if (stats.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
	else {
		writeFileSync(to, readFileSync(from));
		chmodSync(to, stats.mode & 0o7777);
	}
	unlinkSync(from);
}

/** Whether `specifier` in `file` will resolve to `destination` once `target` has moved there. */
function stillLeadsTo(file: string, specifier: string, target: string, destination: string): boolean {
	for (const candidate of relativeCandidates(file, specifier)) {
		if (candidate === resolve(destination)) return true;
		if (candidate !== resolve(target) && existsSync(candidate) && statSync(candidate).isFile()) return false;
	}
	return false;
}

/** Whether a relative specifier leads somewhere from `file`: a file as written, or a module TypeScript-style. */
function leadsSomewhere(file: string, specifier: string): boolean {
	return existsSync(resolve(dirname(file), specifier)) || resolveModule(file, specifier) !== undefined;
}

/**
 * Relative paths in a moved file that worked from where it was and don't from where it goes: static and side-effect
 * imports of assets, `import()`, `require()` and `new URL()`. Ones TypeScript already updated work from both.
 */
function repointMovedPaths(text: string, from: string, to: string): string {
	if (dirname(from) === dirname(to)) return text;
	return text.replace(
		/(\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)(["'])(\.\.?\/[^"'\n]*)\2/g,
		(whole, before: string, quote: string, specifier: string) => {
			if (!leadsSomewhere(from, specifier) || leadsSomewhere(to, specifier)) return whole;
			let path = relative(dirname(to), resolve(dirname(from), specifier)).replaceAll("\\", "/");
			if (!path.startsWith(".")) path = `./${path}`;
			return `${before}${quote}${path}${quote}`;
		},
	);
}

/**
 * Git-visible scripts with a relative import, export, require or import() of `target` that won't still lead to it
 * once it's at `destination`: TypeScript rightly leaves `./a` alone when `a.ts` becomes `a.tsx` or `a/index.ts`.
 */
const relativeSpecifier = /(?:\bfrom|\bimport|\brequire\(|\bimport\()\s*["'](\.{1,2}\/[^"']*)["']/g;

/** The project's JS/TS files, as Git sees them. */
function projectScripts(root: string): string[] {
	const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		encoding: "utf8",
	});
	if (listed.status !== 0) return [];
	return listed.stdout
		.split("\0")
		.filter((file) => /\.[cm]?[jt]sx?$/.test(file))
		.map((file) => resolve(root, file));
}

/**
 * The files among `scripts` that import one of these files, up to a few hundred, as TypeScript resolves their
 * imports: through a tsconfig `paths` alias or a package's exports too. Only files that mention a target's name are
 * asked about; a file outside every tsconfig is judged by its relative paths instead.
 */
async function importersOf(
	server: Parameters<typeof notifyTypeScriptServer>[0],
	targets: string[],
	scripts: string[],
): Promise<string[]> {
	const reals = new Set(targets.map((target) => realpathSync(target)));
	const canonical = new Set([...reals].map((target) => target.toLowerCase()));
	const names = [...reals].map((target) => {
		const name = basename(target).replace(/\.[^.]*$/, "");
		return name === "index" ? basename(dirname(target)) : name;
	});
	const importers: string[] = [];
	for (const file of scripts) {
		if (importers.length >= 300) break;
		if (reals.has(file) || !existsSync(file)) continue;
		const text = readFileSync(file, "utf8");
		if (!names.some((name) => text.includes(name))) continue;
		const project = await checkerProject(server, file);
		const sourceFile = await project?.program.getSourceFile(file);
		if (project && sourceFile) {
			const modules = sourceFile.imports.length ? await project.checker.getSymbolAtLocation(sourceFile.imports) : [];
			if (
				modules.some((module) =>
					module?.declarations.some((declaration) => canonical.has(declaration.path.toLowerCase())),
				)
			)
				importers.push(file);
		} else if (
			[...withoutComments(file, text).matchAll(relativeSpecifier)].some((match) =>
				reals.has(resolveModule(file, match[1]!) ?? ""),
			)
		)
			importers.push(file);
	}
	return importers;
}

function relativeImporters(root: string, target: string, destination: string, edited: Map<string, string>): string[] {
	const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		encoding: "utf8",
	});
	if (listed.status !== 0) return [];
	const real = realpathSync(target);
	return listed.stdout
		.split("\0")
		.filter((file) => /\.[cm]?[jt]sx?$/.test(file))
		.map((file) => resolve(root, file))
		.filter((file) => {
			if (file === target || !existsSync(file)) return false;
			// As TypeScript would leave it: an edited importer can still have a path it didn't update, such as a
			// `require()` beside an updated import.
			const text = withoutComments(file, edited.get(file) ?? readFileSync(file, "utf8"));
			return [...text.matchAll(relativeSpecifier)].some(
				(match) => resolveModule(file, match[1]!) === real && !stillLeadsTo(file, match[1]!, target, destination),
			);
		});
}

export async function renameFile(root: string, options: RenameFileOptions): Promise<void> {
	validateRenameFile(options);
	const from = existingProjectFile(root, options.from);
	const to = projectPath(root, options.to);
	if (from === to) throw new Error("refactor.renameFile source and destination are the same file");
	if (lstatSync(to, { throwIfNoEntry: false }))
		throw new Error(`refactor.renameFile destination already exists: ${JSON.stringify(options.to)}`);
	if (!/\.(?:[cm]?[jt]sx?|json)$/.test(to))
		throw new Error(
			`refactor.renameFile destination needs a module extension, such as .ts: ${JSON.stringify(options.to)}`,
		);
	// The TypeScript server only renames modules; given a stylesheet or a document, it stops.
	if (!/\.(?:[cm]?[jt]sx?|json)$/.test(from))
		throw new Error(
			`refactor.renameFile moves JavaScript and TypeScript modules; move ${JSON.stringify(options.from)} with Bun and update the paths to it with sg.rewrite`,
		);

	await withTypeScriptServer(root, async (server) => {
		const files = [{ oldUri: pathToFileURL(from).href, newUri: pathToFileURL(to).href }];
		const edit = await server.sendRequest<WorkspaceEdit | null>("workspace/willRenameFiles", { files });
		const changes = planWorkspaceEdit(root, edit);
		// The moved file's relative paths TypeScript doesn't resolve, such as CSS or a `new URL("./logo.svg")`.
		const moved = changes.get(from) ?? readFileSync(from, "utf8");
		const repointed = repointMovedPaths(moved, from, to);
		if (repointed !== moved) changes.set(from, repointed);
		// The server can return no edits at all, as when a file augments this one with `declare module`. Check its
		// answer against the files that import this one by a relative path, rather than leave them broken.
		const missed = relativeImporters(root, from, to, changes);
		if (missed.length)
			throw new Error(
				`refactor.renameFile: TypeScript didn't update the import of ${JSON.stringify(options.from)} in ${missed.map((file) => JSON.stringify(relative(root, file))).join(", ")}, so nothing was renamed. It doesn't update \`require()\` calls, and a \`declare module\` augmentation of the file stops it; update those paths with sg.rewrite and move the file with Bun.`,
			);
		const checked = checkedEdits(server, root);
		await checked.track([...changes.keys(), from, to]);
		try {
			editingFiles([...changes.keys(), from, to], () => {
				for (const [changedFile, source] of changes) writeFileSync(changedFile, source);
				mkdirSync(dirname(to), { recursive: true });
				moveFile(from, to);
			});
			await notifyTypeScriptServer(server, "workspace/didRenameFiles", { files });
			await checked.verify(`refactor.renameFile of ${options.from} to ${options.to}`);
		} catch (error) {
			await checked.restore();
			throw error;
		}
	});
}

async function filesChanged(
	server: Parameters<typeof notifyTypeScriptServer>[0],
	changed: string[],
	deleted: string[] = [],
	created: string[] = [],
): Promise<void> {
	recordTypeScriptFiles(server, [...changed, ...deleted, ...created]);
	await notifyTypeScriptServer(server, "workspace/didChangeWatchedFiles", {
		changes: [
			...changed.map((file) => ({ uri: pathToFileURL(file).href, type: 2 })),
			...deleted.map((file) => ({ uri: pathToFileURL(file).href, type: 3 })),
			...created.map((file) => ({ uri: pathToFileURL(file).href, type: 1 })),
		],
	});
}

function validateRename(options: RenameOptions): void {
	if (
		!options ||
		typeof options.file !== "string" ||
		typeof options.symbol !== "string" ||
		typeof options.to !== "string"
	)
		throw new TypeError("refactor.rename expects { file, symbol, to } strings");
	if (!options.file || !options.symbol || !options.to)
		throw new Error("refactor.rename file, symbol and to must not be empty");
	// The new name alone: `to: "Session.renew"` would be written out as is.
	const privateName = options.symbol.split(".").at(-1)!.startsWith("#");
	if (
		!(
			privateName
				? /^#[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u
				: /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u
		).test(options.to)
	)
		throw new Error(
			`refactor.rename: ${JSON.stringify(options.to)} isn't a name; give the new name alone${options.to.includes(".") ? `, such as ${JSON.stringify(options.to.split(".").at(-1))}` : ""}`,
		);
}

function validateRenameFile(options: RenameFileOptions): void {
	if (!options || typeof options.from !== "string" || typeof options.to !== "string")
		throw new TypeError("refactor.renameFile expects { from, to } strings");
	if (!options.from || !options.to) throw new Error("refactor.renameFile from and to must not be empty");
}

const samePosition = (a: Position, b: Position) => a.line === b.line && a.character === b.character;

/**
 * The members of type aliases' object types, `User.name` for `type User = { name: string }`, including those of
 * intersections and unions: the server's document symbols leave them out.
 */
function typeAliasMembers(file: string, source: string): { name: string; position: Position }[] {
	const lang = scriptLanguage(file);
	// JavaScript has no type aliases, and its grammar no kind for them.
	if (!lang || lang === Lang.JavaScript || !source) return [];
	const members: { name: string; position: Position }[] = [];
	for (const alias of parse(lang, source)
		.root()
		.findAll({ rule: { kind: "type_alias_declaration" } })) {
		const owner = alias.field("name")?.text();
		const value = alias.field("value");
		if (!owner || !value) continue;
		const objects =
			value.kind() === "object_type"
				? [value]
				: value.findAll({
						rule: { kind: "object_type", inside: { kind: "type_alias_declaration", stopBy: { kind: "object_type" } } },
					});
		for (const object of objects)
			for (const member of object.children()) {
				if (!["property_signature", "method_signature"].includes(String(member.kind()))) continue;
				const name = member.field("name");
				if (!name) continue;
				const { line, column } = name.range().start;
				members.push({ name: `${owner}.${name.text()}`, position: { line, character: column } });
			}
	}
	return members;
}

function symbolPosition(
	symbols: Array<DocumentSymbol | SymbolInformation>,
	name: string,
	file: string,
	helper: string,
	source = "",
): Position {
	const entries: { name: string; position: Position }[] = [];
	const visit = (items: Array<DocumentSymbol | SymbolInformation>, container = "") => {
		for (const item of items) {
			const parent = "containerName" in item ? item.containerName || container : container;
			const local = item.name === "constructor" ? "__constructor" : item.name;
			const qualified = parent ? `${parent}.${local}` : local;
			entries.push({
				name: qualified,
				position: "selectionRange" in item ? item.selectionRange.start : item.location.range.start,
			});
			if ("children" in item && item.children) visit(item.children, qualified);
		}
	};
	visit(symbols);
	entries.push(
		...typeAliasMembers(file, source).filter(
			(member) => !entries.some((entry) => samePosition(entry.position, member.position)),
		),
	);
	const found = entries.filter((entry) =>
		name.includes(".") ? entry.name === name : entry.name.split(".").at(-1) === name,
	);
	if (found.length === 0)
		throw new Error(`${helper} found no declaration named ${JSON.stringify(name)} in ${JSON.stringify(file)}`);
	// A bare name means the top-level declaration when there is one, not also members and locals named like it:
	// otherwise `parseUser`, offered below as a choice, would be just as ambiguous.
	const topLevel = found.filter((entry) => entry.name === name);
	if (found.length > 1 && topLevel.length === 1) return topLevel[0]!.position;
	// A type and a value of one name (`type Status` with `const Status`) are one symbol to TypeScript.
	// The server gives a position at the name or, for some declarations, at the `export` before them.
	const kindAt = ({ line, character }: Position) => {
		const text = source.split("\n")[line] ?? "";
		return /\b(?:type|interface)\s+$/.test(text.slice(0, character)) ||
			/^(?:export\s+)?(?:declare\s+)?(?:type|interface)\b/.test(text.slice(character))
			? "type"
			: "value";
	};
	if (
		found.length === 2 &&
		new Set(found.map((entry) => entry.name)).size === 1 &&
		kindAt(found[0]!.position) !== kindAt(found[1]!.position)
	)
		return found[0]!.position;
	// A property's `get` and `set` accessors are one symbol to TypeScript, listed twice: either renames both.
	// The server gives an accessor's position at its `get` or `set` keyword; the name follows it.
	const lines = source.split("\n");
	const accessorName = ({ line, character }: Position): Position | undefined => {
		const keyword = /^(?:static\s+)?[gs]et\s+/.exec(lines[line]?.slice(character) ?? "");
		return keyword ? { line, character: character + keyword[0].length } : undefined;
	};
	if (
		found.length > 1 &&
		new Set(found.map((entry) => entry.name)).size === 1 &&
		found.every((entry) => accessorName(entry.position))
	)
		return accessorName(found[0]!.position)!;
	if (found.length > 1) {
		const names = [...new Set(found.map((entry) => entry.name))];
		if (names.length > 1)
			throw new Error(`${JSON.stringify(name)} is ambiguous in ${file}; use one of: ${names.join(", ")}`);
		throw new Error(
			`${helper} found more than one declaration named ${JSON.stringify(name)} in ${JSON.stringify(file)}`,
		);
	}
	return found[0]!.position;
}
