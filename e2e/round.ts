/**
 * A benchmark round: every row below, in all four setups, with the same number of attempts. The README's results
 * table is generated from one complete round (see table.ts), never assembled from partial runs.
 */
import type { PromptStyle } from "./tasks.ts";

export interface RoundRow {
	task: string;
	prompt: PromptStyle;
}

export const roundRows: RoundRow[] = [
	{ task: "rename-symbol-100", prompt: "brief" },
	{ task: "rename-symbol-100", prompt: "outcome" },
	{ task: "options-migration-100", prompt: "brief" },
	{ task: "options-migration-100", prompt: "outcome" },
	{ task: "move-module-100", prompt: "brief" },
	{ task: "move-module-100", prompt: "outcome" },
	{ task: "move-declaration-40", prompt: "outcome" },
	{ task: "logger-migration-100", prompt: "brief" },
	{ task: "logger-migration-100", prompt: "outcome" },
	{ task: "method-migration-100", prompt: "outcome" },
	{ task: "impact-report-100", prompt: "outcome" },
	{ task: "rename-symbol-10", prompt: "brief" },
	{ task: "options-migration-10", prompt: "brief" },
	{ task: "method-migration-10", prompt: "outcome" },
	{ task: "impact-report-10", prompt: "outcome" },
	{ task: "empty-average", prompt: "outcome" },
];

/** The four setups, in the table's column order. */
export const roundColumns = [
	{ setup: "baseline", sightread: "off", heading: "Stock" },
	{ setup: "baseline", sightread: "on", heading: "Stock + `sightread`" },
	{ setup: "code", sightread: "off", heading: "Shorthand" },
	{ setup: "code", sightread: "on", heading: "Shorthand + `sightread`" },
] as const;

export const roundAttempts = 2;

/** The suite options a round fixes; `--round` can't be combined with any of them. */
export const roundOptions = {
	setups: "baseline,code",
	skills: "shorthand",
	documentation: "shipped",
	sightread: "off,on",
	runs: String(roundAttempts),
} as const;
