// Run one working-tree diff with one parser and the existing graph daemon.
import { projectFiles, type Project } from "../project.ts";
import { isAbsolute, resolve } from "node:path";
import { createPaths } from "../paths.ts";
import { createDeclarationParser } from "../ranges.ts";
import { matchChanges } from "./changes.ts";
import { readGitChanges } from "./git.ts";
import { collectImpact } from "./impact.ts";
import { formatDiffNotes, renderDiffText, type DiffResult } from "./render.ts";

/** Compare the chosen commit with disk and return complete text or JSON output. */
export async function runDiff(
	project: Project,
	base: string | undefined,
	options: { json: boolean; color: boolean },
): Promise<string> {
	const git = await readGitChanges(project.root, base);
	const paths = createPaths(project.root, git.repository);
	const parser = createDeclarationParser();
	try {
		const matched = await matchChanges(git, project.root, parser);
		const files = await projectFiles(project);
		const inProject = ({ node, file }: (typeof matched.changed)[number]) =>
			files.has(resolve(project.root, node.file)) ||
			// A deleted file isn't on disk to check against the config, so count it if it was inside the project.
			(file.status === "deleted" &&
				!node.file.startsWith("../") &&
				!isAbsolute(node.file) &&
				!node.file.split("/").includes("node_modules"));
		const outside = matched.changed.filter((change) => !inProject(change));
		matched.changed = matched.changed.filter(inProject);
		if (outside.length)
			matched.notes.push(
				`${outside.length} changed declarations outside the graphed project (${project.tsconfig.slice(project.root.length + 1).replaceAll("\\", "/")})`,
			);
		const impact = matched.changed.length ? await collectImpact(git, project, parser, matched) : undefined;
		const result: DiffResult = {
			base: git.base,
			baseRef: git.baseRef,
			project: git.project,
			tsconfig: project.tsconfig.slice(project.root.length + 1).replaceAll("\\", "/"),
			...(impact && impact.totalChanged > impact.changed.length ? { totalChanged: impact.totalChanged } : {}),
			changed: (impact?.changed ?? []).map(({ node }) => ({
				...node,
				file: paths.toRepositoryPath(node.file),
				handle: paths.toRepositoryHandle(node.handle),
			})),
			callers: (impact?.callers ?? []).map((node) => ({
				...node,
				file: paths.toRepositoryPath(node.file),
				handle: paths.toRepositoryHandle(node.handle),
			})),
			chains: (impact?.chains ?? []).map((chain) => ({
				...chain,
				handles: chain.handles.map(paths.toRepositoryHandle),
				hops: chain.hops.map((hop) => ({
					...hop,
					from: paths.toRepositoryHandle(hop.from),
					to: paths.toRepositoryHandle(hop.to),
				})),
			})),
			tests: (impact?.tests ?? []).map((node) => ({
				...node,
				file: paths.toRepositoryPath(node.file),
				handle: paths.toRepositoryHandle(node.handle),
			})),
			notes: [...(git.baseNote ? [git.baseNote] : []), ...(impact?.notes ?? matched.notes)],
		};
		return options.json
			? JSON.stringify({ ...result, notes: formatDiffNotes(result.notes) })
			: renderDiffText(
					result,
					new Map([...matched.files].map(([file, info]) => [paths.toRepositoryPath(file), info])),
					options.color,
				);
	} finally {
		await parser.close();
	}
}
