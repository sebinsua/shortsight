// Translate graph paths and handles between project and repository coordinates.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { handleSeparator } from "./model.ts";

const roots = new Map<string, string>();
const slash = (path: string) => path.split(sep).join("/");
const inside = (root: string, path: string) => {
	const local = relative(root, path);
	return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
};
const convertHandle = (value: string, convert: (path: string) => string) => {
	const separator = handleSeparator(value);
	return separator < 0 ? value : `${convert(value.slice(0, separator))}${value.slice(separator)}`;
};

export interface PathMapper {
	repository: string;
	project: string;
	toRepositoryPath(path: string): string;
	toRepositoryHandle(handle: string): string;
	toProjectPath(path: string): string;
	toProjectHandle(handle: string): string;
	inputToProjectPath(path: string): string;
	inputToProjectHandle(handle: string): string;
	inputToRepositoryPath(path: string): string;
}

/** Discover the Git root once per project, falling back to the project itself. */
export function createPaths(projectRoot: string, knownRepository?: string): PathMapper {
	const project = realpathSync(resolve(projectRoot));
	let repository = knownRepository ? realpathSync(knownRepository) : roots.get(project);
	if (!repository) {
		try {
			repository = realpathSync(
				execFileSync("git", ["rev-parse", "--show-toplevel"], {
					cwd: project,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim(),
			);
		} catch {
			repository = project;
		}
	}
	roots.set(project, repository);
	const prefix = slash(relative(repository, project));
	// Resolved rather than prefixed, so a sibling package's `../element/x.ts` becomes `packages/element/x.ts`.
	const toRepositoryPath = (path: string) => {
		if (isAbsolute(path)) return inside(project, path) ? slash(relative(repository, path)) : path;
		return prefix ? slash(relative(repository, resolve(project, path))) : path;
	};
	const toProjectPath = (path: string) => {
		if (isAbsolute(path)) return inside(project, path) ? slash(relative(project, path)) : path;
		return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
	};
	const inputToProjectPath = (path: string) => {
		if (isAbsolute(path)) return inside(project, path) ? slash(relative(project, path)) : path;
		if (existsSync(resolve(repository, path))) return slash(relative(project, resolve(repository, path)));
		if (existsSync(resolve(project, path))) return path;
		return path;
	};
	return {
		repository,
		project,
		toRepositoryPath,
		toRepositoryHandle: (value) => convertHandle(value, toRepositoryPath),
		toProjectPath,
		toProjectHandle: (value) => convertHandle(value, toProjectPath),
		inputToProjectPath,
		inputToProjectHandle: (value) => convertHandle(value, inputToProjectPath),
		inputToRepositoryPath: (path) => {
			if (isAbsolute(path)) return inside(repository, path) ? slash(relative(repository, path)) : path;
			if (existsSync(resolve(repository, path))) return slash(relative(repository, resolve(repository, path)));
			if (existsSync(resolve(project, path))) return slash(relative(repository, resolve(project, path)));
			return path;
		},
	};
}
