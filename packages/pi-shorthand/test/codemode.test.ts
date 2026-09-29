import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import registerCode from "../src/index.ts";

const hasOverlay =
	process.platform === "darwin"
		? Boolean(process.env.AGENTFS_BIN ?? Bun.which("agentfs"))
		: Boolean(Bun.which("bwrap"));

let temporaryRoot: string | undefined;
afterEach(async () => {
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	temporaryRoot = undefined;
});

// A scripted model, so this checks Pi's side of the contract: what a codemode script gets back from `code`.
test.skipIf(!hasOverlay)(
	"a codemode script gets code's result as data, for a failed run too",
	async () => {
		temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-shorthand-codemode-"));
		const repo = path.join(temporaryRoot, "repo");
		const agentDir = path.join(temporaryRoot, "agent");
		await mkdir(agentDir);
		await $`git init -q ${repo}`;
		await Bun.write(path.join(repo, "a.txt"), "a\n");
		await $`git add a.txt && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm init`.cwd(repo);

		const script = `
const edited = await tools.code({ title: "Edit", program: 'await Bun.write("a.txt", "b\\\\n");' });
const failed = await tools.code({ title: "Fail", program: 'throw new Error("boom");' });
return JSON.stringify({
  edited: { exitCode: edited.exitCode, applied: edited.applied, kinds: edited.changes.map((change) => change.kind) },
  failed: { exitCode: failed.exitCode, errorLine: failed.errorLine, applied: failed.applied },
});`;
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: script })), fauxAssistantMessage("Done")]);
		const modelRuntime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const resourceLoader = new DefaultResourceLoader({
			cwd: repo,
			agentDir,
			extensionFactories: [createCodemodeExtension({ mode: "on" }), (pi) => registerCode(pi, async () => undefined)],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: repo,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoader,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(),
			tools: ["code", "codemode"],
		});
		let scriptOutput: unknown;
		try {
			await session.bindExtensions({});
			session.subscribe((event) => {
				if (event.type === "tool_execution_end" && event.toolName === "codemode") scriptOutput = event.result.content;
			});
			await session.prompt("Edit a.txt");
		} finally {
			session.dispose();
		}

		const [header, returned] = scriptOutput as { type: "text"; text: string }[];
		expect(header!.text).toStartWith("Script completed");
		expect(JSON.parse(returned!.text)).toEqual({
			edited: { exitCode: 0, applied: ["a.txt"], kinds: ["modified"] },
			failed: { exitCode: 1, errorLine: 'line 1: throw new Error("boom");', applied: [] },
		});
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("b\n");
	},
	30_000,
);
