/**
 * What moving a top-level declaration affects, as TypeScript 7's checker sees it: the names the declaration
 * depends on, whether the rest of its file still uses it, and which files refer to it. move-imports.ts turns
 * this into edits. The checker comes from TypeScript's unstable API, so the typescript version is pinned.
 */
import { realpathSync } from "node:fs";
import type { SgNode } from "@ast-grep/napi";
import { kindsIn, scriptLanguage } from "./placement.ts";
import { API, SymbolFlags, type Project, type Symbol } from "typescript/unstable/async";
import {
	getTouchingPropertyName,
	SyntaxKind,
	type BinaryExpression,
	type Node,
	type PostfixUnaryExpression,
	type PrefixUnaryExpression,
	type SourceFile,
} from "typescript/unstable/ast";

export interface MoveAnalysis {
	/** Names the declaration refers to that are bound outside it: imports, the file's other declarations and globals. */
	dependencies: Set<string>;
	/** Local names of the source file's imports that nothing but the declaration uses, so they leave with it. */
	importsOnlyItUses: Set<string>;
	/** Code left in the source file still refers to the declaration. */
	usedInSource: boolean;
	/** Other files that refer to the declaration, by importing or re-exporting it. */
	referencing: string[];
	/** Files that use the declaration as a property of the module object: `ns.name`, `ns["name"]`, `{ name } = ns`. */
	usedThroughModule: string[];
	/**
	 * Variables a move would make imports where they're assigned, which an import can't be: the source's that the
	 * declaration assigns, and the declaration's that the source still assigns.
	 */
	assignedThroughImport: string[];
}

export interface MoveAnalysisInput {
	root: string;
	file: string;
	/** The top-level statement being moved. */
	node: SgNode;
	/** The names it declares. */
	names: string[];
	/** Every JS/TS file in the repository, so that each lands in a TypeScript project. */
	files: string[];
}

const REFERENCES = ["identifier", "type_identifier", "shorthand_property_identifier"];
/** Where a declaration names what it declares, including `{ name }` in a destructuring declaration. */
const DECLARED = ["identifier", "type_identifier", "shorthand_property_identifier_pattern"];

const real = (file: string) => {
	try {
		return realpathSync(file);
	} catch {
		return file;
	}
};

export async function analyzeMove({ root, file, node, names, files }: MoveAnalysisInput): Promise<MoveAnalysis> {
	const api = new API({ cwd: root });
	try {
		const snapshot = await api.updateSnapshot({ openFiles: [...new Set([file, ...files])] });
		const home = await snapshot.getDefaultProjectForFile(file);
		const sourceFile = await home?.program.getSourceFile(file);
		if (!home || !sourceFile) throw new Error(`refactor.move: TypeScript has no project containing ${file}`);
		// A file in another project, such as another workspace package, imports the source through its own program.
		const projects: Project[] = [];
		for (const project of snapshot.getProjects())
			if (await project.program.getSourceFile(file).catch(() => undefined)) projects.push(project);
		const used = await dependencies(home, sourceFile, node);
		const { assignedInSource, ...referenced } = await references(projects, sourceFile, node, names);
		return {
			...used,
			...referenced,
			assignedThroughImport: [...new Set([...used.assignedThroughImport, ...assignedInSource])],
		};
	} finally {
		await api.close();
	}
}

/**
 * Names in `node` whose symbol is declared outside it, or that resolve to nothing; and of those, the source
 * file's imports that nothing outside `node` uses.
 */
async function dependencies(
	project: Project,
	sourceFile: SourceFile,
	node: SgNode,
): Promise<Pick<MoveAnalysis, "dependencies" | "importsOnlyItUses" | "assignedThroughImport">> {
	const { start, end } = node.range();
	const inside = (reference: Node) => reference.getStart(sourceFile) >= start.index && reference.end <= end.index;
	const onlyUsedInside = async (symbol: Symbol) => {
		for (const handle of await project.checker.getReferencesToSymbolInFile(sourceFile.fileName, symbol)) {
			const reference = await handle.resolve(project);
			if (reference && !inside(reference) && !withinImport(reference)) return false;
		}
		return true;
	};
	const within = async (symbol: Symbol) => {
		if (!symbol.declarations.length) return false;
		for (const declaration of symbol.declarations) {
			if (declaration.path !== sourceFile.path) return false;
			const resolved = await declaration.resolve(project);
			if (!resolved || resolved.getStart(sourceFile) < start.index || resolved.end > end.index) return false;
		}
		return true;
	};
	const lang = scriptLanguage(sourceFile.fileName)!;
	const identifiers = node.findAll({ rule: { any: kindsIn(lang, REFERENCES).map((kind) => ({ kind })) } });
	const symbols = await project.checker.getSymbolAtPosition(
		sourceFile.fileName,
		identifiers.map((identifier) => identifier.range().start.index),
	);
	const names = new Set<string>();
	const importsOnlyItUses = new Set<string>();
	const assignedThroughImport = new Set<string>();
	for (const [index, identifier] of identifiers.entries()) {
		const name = identifier.text();
		const variable = symbols[index];
		if (
			variable &&
			variable.flags & VARIABLE &&
			assigns(getTouchingPropertyName(sourceFile, identifier.range().start.index)) &&
			!(await within(variable)) &&
			variable.declarations.every((declaration) => declaration.path === sourceFile.path)
		)
			assignedThroughImport.add(name);
		if (names.has(name)) continue;
		// `{ name }` declares a property; the value it reads is whatever `name` means there.
		const symbol =
			identifier.kind() === "shorthand_property_identifier"
				? await project.checker.resolveName(
						name,
						SymbolFlags.Value,
						getTouchingPropertyName(sourceFile, identifier.range().start.index),
					)
				: symbols[index];
		if (symbol && (await within(symbol))) continue;
		names.add(name);
		const imported =
			symbol &&
			symbol.flags & SymbolFlags.Alias &&
			symbol.declarations.every((declaration) => declaration.path === sourceFile.path);
		if (imported && (await onlyUsedInside(symbol))) importsOnlyItUses.add(name);
	}
	return { dependencies: names, importsOnlyItUses, assignedThroughImport: [...assignedThroughImport] };
}

/** A node inside an import declaration, such as the binding an import introduces. */
function withinImport(node: Node): boolean {
	for (let current: Node | undefined = node; current; current = current.parent)
		if (current.kind === SyntaxKind.ImportDeclaration || current.kind === SyntaxKind.ImportEqualsDeclaration)
			return true;
	return false;
}

async function references(
	projects: Project[],
	sourceFile: SourceFile,
	node: SgNode,
	names: string[],
): Promise<Pick<MoveAnalysis, "usedInSource" | "referencing" | "usedThroughModule"> & { assignedInSource: string[] }> {
	const { start, end } = node.range();
	const source = real(sourceFile.fileName);
	const seen = new Set<string>();
	const referencing = new Set<string>();
	const usedThroughModule = new Set<string>();
	let usedInSource = false;
	const assignedInSource = new Set<string>();
	for (const project of projects) {
		const own = (await project.program.getSourceFile(sourceFile.fileName))!;
		for (const name of names) {
			// The first mention of a declared name in its declaration is where it is declared.
			const declared = node.find({
				rule: {
					any: kindsIn(scriptLanguage(sourceFile.fileName)!, DECLARED).map((kind) => ({
						kind,
						regex: `^${name.replaceAll("$", "\\$")}$`,
					})),
				},
			});
			if (!declared) continue;
			const position = declared.range().start.index;
			const entries = await project.checker.getReferencedSymbolsForNode(
				getTouchingPropertyName(own, position),
				position,
			);
			for (const handle of entries.flatMap((entry) => entry.references)) {
				const key = `${handle.path}:${handle.index}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const reference = await handle.resolve(project);
				if (!reference) continue;
				const file = real(reference.getSourceFile().fileName);
				if (file === source) {
					if (reference.end <= start.index || reference.getStart() >= end.index) {
						usedInSource = true;
						if (assigns(reference)) assignedInSource.add(name);
					}
					continue;
				}
				referencing.add(file);
				if (throughModule(reference)) usedThroughModule.add(file);
			}
		}
	}
	return {
		usedInSource,
		referencing: [...referencing],
		usedThroughModule: [...usedThroughModule],
		assignedInSource: [...assignedInSource],
	};
}

/** A reference that reads the declaration off a module object rather than binding it by name. */
function throughModule(reference: Node): boolean {
	const parent = reference.parent as Node & Record<string, unknown>;
	switch (parent.kind) {
		case SyntaxKind.PropertyAccessExpression:
			return parent.name === reference;
		case SyntaxKind.ElementAccessExpression:
			// `ns["name"]` reads it off the module; `store[NAME]` only uses the binding as a key.
			return (
				parent.argumentExpression === reference &&
				(reference.kind === SyntaxKind.StringLiteral || reference.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
			);
		case SyntaxKind.QualifiedName:
			return parent.right === reference;
		case SyntaxKind.BindingElement:
			// `{ name } = ns` reads it; `{ timeout = DEFAULT_TIMEOUT }` only uses it as a default.
			return parent.initializer !== reference;
		default:
			return false;
	}
}

const VARIABLE = SymbolFlags.FunctionScopedVariable | SymbolFlags.BlockScopedVariable;

/** Whether a reference is assigned: the target of `=`, `+=` and the like, or of `++` or `--`. */
function assigns(reference: Node): boolean {
	const parent = reference.parent;
	if (parent?.kind === SyntaxKind.BinaryExpression) {
		const { left, operatorToken } = parent as BinaryExpression;
		return (
			left === reference &&
			operatorToken.kind >= SyntaxKind.FirstAssignment &&
			operatorToken.kind <= SyntaxKind.LastAssignment
		);
	}
	if (parent?.kind === SyntaxKind.PrefixUnaryExpression || parent?.kind === SyntaxKind.PostfixUnaryExpression) {
		const { operator } = parent as PrefixUnaryExpression | PostfixUnaryExpression;
		return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken;
	}
	return false;
}
