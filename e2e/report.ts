import { readFile, writeFile } from "node:fs/promises";
import { SHORTHAND_TOOL_NAMES, type JsonEvent } from "./harness.ts";

const fence = (value: string) => {
	const ticks = "`".repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map((m) => m[0].length + 1)));
	return `${ticks}\n${value}\n${ticks}`;
};

export function sessionReport(events: JsonEvent[], summary?: JsonEvent): string {
	const lines = ["# Session review", "", "Automatic labels are observations, not a score of tool understanding.", ""];
	if (summary)
		lines.push(
			`Verified: ${summary.verified}. Cost estimate: $${summary.usage?.cost?.total ?? "unknown"}. Elapsed: ${summary.seconds}s.`,
			"",
		);
	let calls = 0;
	for (const event of events) {
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const message = event.message;
			const prose = (message.content ?? [])
				.filter((part: JsonEvent) => part.type === "text")
				.map((part: JsonEvent) => part.text)
				.join("\n");
			if (prose) lines.push("### Assistant", "", prose, "");
			if (message.usage)
				lines.push(
					`Response cost estimate: $${message.usage.cost?.total ?? "unknown"}; tokens: ${message.usage.totalTokens ?? "unknown"}.`,
					"",
				);
		}
		if (event.type === "tool_execution_start") {
			lines.push(
				`### ${++calls}. ${event.toolName}${typeof event.observedMs === "number" ? ` at ${(event.observedMs / 1000).toFixed(2)}s` : ""}`,
				"",
				fence(JSON.stringify(event.args, null, 2) ?? "Arguments unavailable"),
				"",
			);
			if (event.toolName === "bash")
				lines.push("Review shell command for writes; shell use alone does not establish a bypass.", "");
		}
		if (event.type === "tool_execution_end") {
			const details = event.result?.details;
			const label = details?.timedOut
				? "timeout"
				: details?.conflicts?.length
					? "conflict"
					: event.isError || (typeof details?.exitCode === "number" && details.exitCode !== 0)
						? "failure — review whether interface, application/check, or infrastructure"
						: "success";
			lines.push(
				`Result (${event.toolCallId ?? event.toolName}): ${label}${details?.durationMs !== undefined ? `; ${details.durationMs} ms` : ""}.`,
				"",
			);
			if (
				SHORTHAND_TOOL_NAMES.includes(event.toolName) &&
				Array.isArray(details?.changes) &&
				details.changes.length === 0
			)
				lines.push("No candidate file changes (may be an intentional inspection/check).", "");
			lines.push(
				fence(
					(event.result?.content ?? [])
						.filter((part: JsonEvent) => part.type === "text")
						.map((part: JsonEvent) => part.text)
						.join("\n"),
				),
				"",
			);
		}
	}
	lines.push(
		"## Reviewer notes",
		"",
		"- First editing call: API use valid? Intended change made?",
		"- Failure causes: interface / application or check / timeout / conflict / infrastructure.",
		"- Strategy: programmatic transformations, reproduced unchanged code, useful or excessive batching.",
		"- Recovery: targeted correction, repeated mistake, or tool abandonment.",
		"- Shell writes and final evaluator result:",
		"",
	);
	return lines.join("\n");
}

if (import.meta.main) {
	const [log, output = `${log}.md`] = process.argv.slice(2);
	if (!log) throw new Error("Usage: bun e2e/report.ts <events.jsonl> [report.md]");
	const events = (await readFile(log, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	await writeFile(output, sessionReport(events));
	console.log(output);
}
