/** Running a program from another tool: Pi's `shorthand` tool and the `shorthand` command both use this. */
export { DEFAULT_TIMEOUT_SECONDS, RunnerError, runWithBun } from "./runner/client.ts";
export { resolveSightread, sightreadAvailable } from "./runner/graph-proxy.ts";
export type { FileChange, FilesystemEntry, RunOptions, RunResult, RunTimings } from "./runner/runner.ts";
export { type Diagnostics, diagnosticLines } from "./runner/diagnostics.ts";
export {
	countLines,
	fileMetadataSummary,
	runFailed,
	timeoutBudgetMs,
	timeoutText,
	timingBreakdown,
} from "./report/run-summary.ts";
export { type ModelTextOptions, type Truncate, textForModel } from "./report/text-for-model.ts";
export { truncateHead, truncateTail } from "./report/truncate.ts";
