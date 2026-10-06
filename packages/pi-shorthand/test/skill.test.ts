import { expect, test } from "bun:test";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerShorthand from "../src/index.ts";

test("Pi loads the shorthand skill from shorthand-code", async () => {
	const handlers = new Map<string, () => unknown>();
	await registerShorthand(
		{
			on(event: string, handler: () => unknown) {
				handlers.set(event, handler);
			},
			registerTool() {},
		} as unknown as ExtensionAPI,
		async () => undefined,
	);
	const discovered = (await handlers.get("resources_discover")?.()) as { skillPaths: string[] };
	expect(discovered.skillPaths).toHaveLength(1);
	const skill = await Bun.file(path.join(discovered.skillPaths[0], "shorthand/SKILL.md")).text();
	expect(skill.startsWith("---\nname: shorthand\n")).toBe(true);
});

test("Node resolves shorthand-code's package.json, as Pi does when loading the extension", () => {
	// Bun ignores a package's `exports` map here, and Node doesn't, so check under Node.
	const result = Bun.spawnSync(["node", "-e", 'console.log(require.resolve("shorthand-code/package.json"))'], {
		cwd: path.join(import.meta.dir, ".."),
	});
	expect(result.stderr.toString()).toBe("");
	expect(result.stdout.toString().trim().endsWith(path.join("shorthand-code", "package.json"))).toBe(true);
});

test("the extension loads under Node, the way Pi loads it", () => {
	// Tests run in Bun, which has globals Node lacks. Pi loads extensions with jiti under Node, so load it that way.
	const piDirectory = path.dirname(Bun.resolveSync("@earendil-works/pi-coding-agent/package.json", import.meta.dir));
	const jiti = Bun.resolveSync("jiti", piDirectory);
	const entry = path.join(import.meta.dir, "../src/index.ts");
	const script = `
		const { createJiti } = await import(${JSON.stringify(jiti)});
		const extension = await createJiti(import.meta.url).import(${JSON.stringify(entry)});
		let tool;
		await extension.default({ on() {}, registerTool(registered) { tool = registered; } });
		console.log(tool.name, tool.description.includes("graph.query"));
	`;
	const result = Bun.spawnSync(["node", "--input-type=module", "-e", script]);
	expect(result.stderr.toString()).toBe("");
	// sightread is a workspace package here, so Node must find it and the tool must offer graph.query.
	expect(result.stdout.toString().trim()).toBe("shorthand true");
});
