/**
 * Generated repository-scale fixtures. Each family changes one API across N consumer files, with decoys that look
 * like the target but must stay unchanged. Sizes separate per-call overhead from per-site cost, so comparisons can
 * locate a crossover instead of averaging tasks of one small size.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { absent, assertNoDrift, contains, matches, measureDrift, resolvesTo, squash, type Check } from "./drift.ts";
import { moduleAt, type Task } from "./task.ts";

export const scaleSizes = [10, 40, 100] as const;

interface Case {
	file: string;
	call: string;
	args?: unknown[];
	expected: unknown;
}

interface Fixture {
	before: Record<string, string>;
	after: Record<string, string | null>;
	sites: Check[];
	decoys: Check[];
	cases: Case[];
	/** Checks the behaviour of a case by what it recorded rather than what it returned. */
	observe?: (root: string) => Promise<unknown>;
	prompt: string;
	brief: string;
}

interface Family {
	id: string;
	category: Task["category"];
	/** Bumped when a family's fixtures change, so results from different versions are not mixed. */
	revision: string;
	build: (size: number) => Fixture;
}

/** Spread consumers across two directory depths so relative paths differ. */
const consumer = (i: number) => (i % 3 === 0 ? `src/features/feature${i}.ts` : `src/features/g${i % 4}/feature${i}.ts`);
const specifier = (from: string, to: string) => {
	const relative = path.posix.relative(path.posix.dirname(from), to.replace(/\.ts$/, "").replace(/\/index$/, ""));
	return relative.startsWith(".") ? relative : `./${relative}`;
};
/** Unique numeric keys per consumer, so each call site can be identified after any reformatting. */
const key = (i: number, k: number) => (i + 1) * 100 + k;
const count = (size: number, kinds: number, ...wanted: number[]) =>
	Array.from({ length: size }, (_, i) => i).filter((i) => wanted.includes(i % kinds)).length;

const moneySource = (name: string) => `export function ${name}(cents: number, currency = "USD"): string {
  return \`\${currency} \${(cents / 100).toFixed(2)}\`;
}
export const MONEY_EVENT = "formatAmount";
`;

const formatCents = (cents: number, currency = "USD") => `${currency} ${(cents / 100).toFixed(2)}`;

const migratedCall = (file: string, url: string) => contains(file, `request("${url}", {`, `request("${url}") migrated`);

const requestResult = (url: string, retries = 0, timeoutMs = 1000) => ({ url, retries, timeoutMs });

const dateSource = (locale: string) =>
	`import { LOCALE } from "${locale}";\nexport function formatDate(epochDay: number): string {\n  return \`\${LOCALE}:\${epochDay}\`;\n}\n`;

const logEntry = (level: string, message: string, context?: unknown) =>
	context ? { level, message, context } : { level, message };

const renameSymbol: Family = {
	id: "rename-symbol",
	revision: "scale-v1",
	category: "rename",
	build(size) {
		const before: Record<string, string> = {
			"src/lib/money.ts": moneySource("formatAmount"),
			"src/lib/index.ts": 'export { formatAmount } from "./money";\n',
			"src/legacy/format.ts": "export function formatAmount(value: number): string {\n  return `#${value}`;\n}\n",
		};
		const after: Record<string, string | null> = {
			"src/lib/money.ts": moneySource("formatPrice"),
			"src/lib/index.ts": 'export { formatPrice } from "./money";\n',
		};
		const sites: Check[] = [
			contains("src/lib/money.ts", "export function formatPrice("),
			contains("src/lib/index.ts", "export { formatPrice } from"),
		];
		const decoys: Check[] = [
			contains("src/lib/money.ts", 'MONEY_EVENT = "formatAmount"'),
			contains("src/legacy/format.ts", "export function formatAmount("),
		];
		const cases: Case[] = [];
		for (let i = 0; i < size; i++) {
			const file = consumer(i);
			const [a, b, c] = [key(i, 1), key(i, 2), key(i, 3)];
			const lib = specifier(file, i % 10 >= 5 ? "src/lib/index.ts" : "src/lib/money.ts");
			const call = `feature${i}`;
			const variants = (name: string) =>
				[
					`import { ${name} } from "${lib}";
export function ${call}() {
  return [${name}(${a}), ${name}(${b}, "EUR")];
}
`,
					`import { ${name} as fmt } from "${lib}";
export function ${call}() {
  return [fmt(${a})];
}
`,
					`import { ${name} } from "${lib}";
type Formatter = (cents: number) => string;
export function render${i}(formatAmount: Formatter) {
  return formatAmount(${c});
}
export function ${call}() {
  return [${name}(${a}), render${i}((cents) => \`~\${cents}\`)];
}
`,
					`import { formatAmount } from "${specifier(file, "src/legacy/format.ts")}";
export function ${call}() {
  return [formatAmount(${a})];
}
`,
					`import { ${name} } from "${lib}";
export const event${i} = { name: "formatAmount", source: "lib/money" };
export function ${call}() {
  return [${name}(${a}), event${i}.name];
}
`,
				][i % 5]!;
			before[file] = variants("formatAmount");
			const kind = i % 5;
			if (kind !== 3) after[file] = variants("formatPrice");
			if (kind === 0) sites.push(contains(file, `formatPrice(${a})`), contains(file, `formatPrice(${b},`));
			if (kind === 1) sites.push(contains(file, "formatPrice as fmt"));
			if (kind === 2) {
				sites.push(contains(file, `formatPrice(${a})`));
				decoys.push(contains(file, "(formatAmount: Formatter)"), contains(file, `formatAmount(${c})`));
			}
			if (kind === 3) decoys.push(contains(file, `formatAmount(${a})`));
			if (kind === 4) {
				sites.push(contains(file, `formatPrice(${a})`));
				decoys.push(contains(file, 'name: "formatAmount"'));
			}
			cases.push({
				file,
				call,
				expected: [
					[formatCents(a), formatCents(b, "EUR")],
					[formatCents(a)],
					[formatCents(a), `~${c}`],
					[`#${a}`],
					[formatCents(a), "formatAmount"],
				][kind],
			});
		}
		const importers = count(size, 5, 0, 1, 2, 4);
		return {
			before,
			after,
			sites,
			decoys,
			cases,
			prompt:
				"Rename the formatAmount function exported by src/lib/money.ts to formatPrice and update everything that uses it. Preserve behaviour.",
			brief: `Rename \`formatAmount\` in src/lib/money.ts to \`formatPrice\`, including its re-export in src/lib/index.ts and every import and call that resolves to it (${importers} files under src/features, some importing through src/lib). Where it is imported with an alias (\`formatAmount as fmt\`), rename the imported name and keep the local alias. Leave these unchanged: the separate formatAmount in src/legacy/format.ts and the files importing it, parameters named formatAmount that shadow the import, and "formatAmount" string values. Make no other changes; run \`npm run check\` afterwards.`,
		};
	},
};

const optionsMigration: Family = {
	id: "options-migration",
	revision: "scale-v1",
	category: "migration",
	build(size) {
		const types = "export interface RequestOptions { retries?: number; timeoutMs?: number }\n";
		const before: Record<string, string> = {
			"src/lib/http.ts": `${types}export function request(url: string, retries = 0, timeoutMs = 1000) {
  return { url, retries, timeoutMs };
}
`,
			"src/lib/cache.ts":
				"export const cache = {\n  request(key: string, ttl: number) {\n    return { key, ttl };\n  },\n};\n",
		};
		const after: Record<string, string | null> = {
			"src/lib/http.ts": `${types}export function request(url: string, options: RequestOptions = {}) {
  return { url, retries: options.retries ?? 0, timeoutMs: options.timeoutMs ?? 1000 };
}
`,
		};
		const sites: Check[] = [
			// Named or destructured: both take the options object.
			matches("src/lib/http.ts", /request\(url:string,(?:\w+|\{[^}]*\}):RequestOptions/, "options signature"),
		];
		const decoys: Check[] = [contains("src/lib/cache.ts", "request(key: string, ttl: number)")];
		const cases: Case[] = [];
		for (let i = 0; i < size; i++) {
			const file = consumer(i);
			const http = specifier(file, "src/lib/http.ts");
			const [u1, u2] = [`/r/${key(i, 1)}`, `/r/${key(i, 2)}`];
			const call = `feature${i}`;
			const kind = i % 5;
			const texts = [
				[
					`import { request } from "${http}";
export function ${call}() {
  return [request("${u1}", 3), request("${u2}")];
}
`,
					`import { request } from "${http}";
export function ${call}() {
  return [request("${u1}", { retries: 3 }), request("${u2}")];
}
`,
				],
				[
					`import { request } from "${http}";
export function ${call}() {
  return [
    request("${u1}", 2, 500),
    request(
      "${u2}",
      5,
      250,
    ),
  ];
}
`,
					`import { request } from "${http}";
export function ${call}() {
  return [
    request("${u1}", { retries: 2, timeoutMs: 500 }),
    request(
      "${u2}",
      { retries: 5, timeoutMs: 250 },
    ),
  ];
}
`,
				],
				[
					`import { request } from "${http}";
export function ${call}(retries: number, timeout: number) {
  return [request("${u1}", undefined, 750), request("${u2}", retries, timeout)];
}
`,
					`import { request } from "${http}";
export function ${call}(retries: number, timeout: number) {
  return [request("${u1}", { timeoutMs: 750 }), request("${u2}", { retries, timeoutMs: timeout })];
}
`,
				],
				[
					`import { cache } from "${specifier(file, "src/lib/cache.ts")}";
import { request } from "${http}";
export function ${call}() {
  return [cache.request("k/${key(i, 1)}", 3), request("${u2}", 1)];
}
`,
					`import { cache } from "${specifier(file, "src/lib/cache.ts")}";
import { request } from "${http}";
export function ${call}() {
  return [cache.request("k/${key(i, 1)}", 3), request("${u2}", { retries: 1 })];
}
`,
				],
				[
					`function request(path: string, weight: number) {
  return \`\${path}:\${weight}\`;
}
export const note${i} = 'request("${u1}", 3)';
export function ${call}() {
  return [request("/local/${key(i, 1)}", 3)];
}
`,
				],
			][kind]!;
			before[file] = texts[0]!;
			if (texts[1]) after[file] = texts[1];
			if (kind === 0) {
				sites.push(migratedCall(file, u1));
				decoys.push(contains(file, `request("${u2}")`));
			}
			if (kind === 1) sites.push(migratedCall(file, u1), migratedCall(file, u2));
			if (kind === 2) sites.push(migratedCall(file, u1), migratedCall(file, u2));
			if (kind === 3) {
				sites.push(migratedCall(file, u2));
				decoys.push(contains(file, `cache.request("k/${key(i, 1)}", 3)`));
			}
			if (kind === 4)
				decoys.push(
					contains(file, `request("/local/${key(i, 1)}", 3)`),
					contains(file, `'request("${u1}", 3)'`, "string contents"),
				);
			cases.push({
				file,
				call,
				args: kind === 2 ? [4, 900] : [],
				expected: [
					[requestResult(u1, 3), requestResult(u2)],
					[requestResult(u1, 2, 500), requestResult(u2, 5, 250)],
					[requestResult(u1, 0, 750), requestResult(u2, 4, 900)],
					[{ key: `k/${key(i, 1)}`, ttl: 3 }, requestResult(u2, 1)],
					[`/local/${key(i, 1)}:3`],
				][kind],
			});
		}
		const callers = count(size, 5, 0, 1, 2, 3);
		return {
			before,
			after,
			sites,
			decoys,
			cases,
			prompt:
				"Change request() in src/lib/http.ts to take an options object using the existing RequestOptions type, instead of positional retries and timeoutMs arguments, and update its callers. Preserve behaviour.",
			brief: `In src/lib/http.ts, change \`request(url, retries = 0, timeoutMs = 1000)\` to \`request(url, options: RequestOptions = {})\`, defaulting retries to 0 and timeoutMs to 1000. Update every call to it (${callers} files under src/features): \`request(u, r)\` becomes \`request(u, { retries: r })\`, \`request(u, r, t)\` becomes \`request(u, { retries: r, timeoutMs: t })\`, and \`request(u, undefined, t)\` becomes \`request(u, { timeoutMs: t })\`. Keep single-argument calls as they are. Some calls span several lines or pass variables. Do not change cache.request, file-local functions that happen to be named request, or string contents. Make no other changes; run \`npm run check\` afterwards.`,
		};
	},
};

const moveModule: Family = {
	id: "move-module",
	revision: "scale-v2",
	category: "move",
	build(size) {
		const from = "src/utils/date.ts";
		const to = "src/shared/time/date.ts";
		const before: Record<string, string> = {
			[from]: dateSource("./locale"),
			"src/utils/locale.ts": 'export const LOCALE = "en-GB";\n',
			"src/utils/index.ts": 'export * from "./date";\nexport * from "./locale";\n',
			"src/legacy/date.ts":
				'export function formatDate(epochDay: number): string {\n  return "legacy:" + epochDay;\n}\n',
			"src/legacy/report.ts": 'import { formatDate } from "./date";\nexport const report = () => formatDate(1);\n',
		};
		const after: Record<string, string | null> = {
			[from]: null,
			[to]: dateSource("../../utils/locale"),
			"src/utils/index.ts": 'export * from "../shared/time/date";\nexport * from "./locale";\n',
		};
		const sites: Check[] = [absent(from), resolvesTo(to, "src/utils/locale.ts"), resolvesTo("src/utils/index.ts", to)];
		const decoys: Check[] = [contains("src/legacy/report.ts", 'from "./date"')];
		const cases: Case[] = [{ file: "src/utils/index.ts", call: "formatDate", args: [7], expected: "en-GB:7" }];
		for (let i = 0; i < size; i++) {
			const file = consumer(i);
			const call = `feature${i}`;
			const day = key(i, 1);
			const kind = i % 4;
			const text = (target: string) =>
				[
					`import { formatDate } from "${specifier(file, target)}";
export function ${call}() {
  return formatDate(${day});
}
`,
					`import { formatDate } from "${specifier(file, "src/utils/index.ts")}";
export function ${call}() {
  return formatDate(${day});
}
`,
					`export { formatDate as ${call} } from "${specifier(file, target)}";
`,
					`import { formatDate } from "${specifier(file, "src/legacy/date.ts")}";
export function ${call}() {
  return formatDate(${day});
}
`,
				][kind]!;
			before[file] = text(from);
			if (kind === 0 || kind === 2) after[file] = text(to);
			if (kind === 0 || kind === 2) sites.push(resolvesTo(file, to));
			if (kind === 1) decoys.push(resolvesTo(file, "src/utils/index.ts"));
			if (kind === 3) decoys.push(resolvesTo(file, "src/legacy/date.ts"));
			cases.push({
				file,
				call,
				args: kind === 2 ? [day] : [],
				expected: kind === 3 ? `legacy:${day}` : `en-GB:${day}`,
			});
		}
		const direct = count(size, 4, 0, 2);
		return {
			before,
			after,
			sites,
			decoys,
			cases,
			prompt: `Move ${from} to ${to} and update everything that depends on it. Preserve behaviour.`,
			brief: `Move ${from} to ${to}. Update the moved file's own import of ./locale, the re-export in src/utils/index.ts, and the imports and re-exports in the ${direct} files under src/features that reference utils/date directly. Files importing the src/utils barrel keep that import. Do not change src/legacy/date.ts or its importers. Do not leave a copy or re-export shim at the old path. Make no other changes; run \`npm run check\` afterwards.`,
		};
	},
};

/**
 * A call migrated to logger, however its arguments are spelled: behaviour checks already compare the
 * recorded entries, so this only confirms the call now goes through logger. A literal level may also be
 * written logger.log("info", m), and a non-literal one logger.log(level, m) or logger[level](m).
 */
const migratedLog = (file: string, level: "info" | "warn" | "error" | "level", message: string): Check =>
	matches(
		file,
		level === "level"
			? new RegExp(`logger(?:\\.log\\(level,|\\[level\\]\\()"${message}"`)
			: new RegExp(`logger(?:\\.${level}\\(|\\.log\\("${level}",)"${message}"[,)]`),
		`logger ${level} call for "${message}"`,
	);

const loggerMigration: Family = {
	id: "logger-migration",
	revision: "scale-v1",
	category: "migration",
	build(size) {
		const before: Record<string, string> = {
			"src/lib/logger.ts": `export type LogLevel = "info" | "warn" | "error";
export interface Entry { level: LogLevel; message: string; context?: Record<string, unknown> }
export const entries: Entry[] = [];
export const logger = {
  log(level: LogLevel, message: string, context?: Record<string, unknown>) {
    entries.push(context ? { level, message, context } : { level, message });
  },
  info: (message: string, context?: Record<string, unknown>) => logger.log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => logger.log("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => logger.log("error", message, context),
};
`,
			"src/lib/log.ts": `import { logger, type LogLevel } from "./logger";
export type { LogLevel };
/** @deprecated Use logger from ./logger. */
export function log(level: LogLevel, message: string, error?: unknown): void {
  logger.log(level, message, error === undefined ? undefined : { error });
}
`,
		};
		const after: Record<string, string | null> = { "src/lib/log.ts": null };
		const sites: Check[] = [absent("src/lib/log.ts")];
		const decoys: Check[] = [];
		const cases: Case[] = [];
		const failure = new Error("failure");
		for (let i = 0; i < size; i++) {
			const file = consumer(i);
			const logImport = specifier(file, "src/lib/log.ts");
			const loggerImport = specifier(file, "src/lib/logger.ts");
			const [m1, m2, m3] = [`m${key(i, 1)}`, `m${key(i, 2)}`, `m${key(i, 3)}`];
			const call = `feature${i}`;
			const kind = i % 5;
			const [text, migrated] = [
				[
					`import { log } from "${logImport}";
export function ${call}() {
  log("info", "${m1}");
  log("warn", "${m2}");
}
`,
					`import { logger } from "${loggerImport}";
export function ${call}() {
  logger.info("${m1}");
  logger.warn("${m2}");
}
`,
				],
				[
					`import { log } from "${logImport}";
export function ${call}(run: () => void) {
  try {
    run();
  } catch (err) {
    log("error", "${m1}", err);
  }
}
`,
					`import { logger } from "${loggerImport}";
export function ${call}(run: () => void) {
  try {
    run();
  } catch (err) {
    logger.error("${m1}", { error: err });
  }
}
`,
				],
				[
					`import { log, type LogLevel } from "${logImport}";
export function ${call}(level: LogLevel) {
  log(level, "${m1}");
}
`,
					`import { logger, type LogLevel } from "${loggerImport}";
export function ${call}(level: LogLevel) {
  logger.log(level, "${m1}");
}
`,
				],
				[
					`import { log } from "${logImport}";
const audit = { log: (level: string, message: string) => \`\${level}:\${message}\` };
export function ${call}() {
  log("info", "${m1}");
  return [audit.log("info", "${m3}"), Math.log(1)];
}
`,
					`import { logger } from "${loggerImport}";
const audit = { log: (level: string, message: string) => \`\${level}:\${message}\` };
export function ${call}() {
  logger.info("${m1}");
  return [audit.log("info", "${m3}"), Math.log(1)];
}
`,
				],
				[
					`import { log } from "${logImport}";
export const hint${i} = 'log("info", "${m2}")';
export function ${call}() {
  log("warn", "${m1}");
}
`,
					`import { logger } from "${loggerImport}";
export const hint${i} = 'log("info", "${m2}")';
export function ${call}() {
  logger.warn("${m1}");
}
`,
				],
			][kind]!;
			before[file] = text!;
			after[file] = migrated!;
			if (kind === 0) sites.push(migratedLog(file, "info", m1), migratedLog(file, "warn", m2));
			if (kind === 1) sites.push(migratedLog(file, "error", m1));
			if (kind === 2) sites.push(migratedLog(file, "level", m1));
			if (kind === 3) {
				sites.push(migratedLog(file, "info", m1));
				decoys.push(contains(file, `audit.log("info", "${m3}")`), contains(file, "Math.log(1)"));
			}
			if (kind === 4) {
				sites.push(migratedLog(file, "warn", m1));
				decoys.push(contains(file, `'log("info", "${m2}")'`, "string contents"));
			}
			cases.push({
				file,
				call,
				args: [
					[],
					[
						() => {
							throw failure;
						},
					],
					["warn"],
					[],
					[],
				][kind],
				expected: [
					{ returned: undefined, logged: [logEntry("info", m1), logEntry("warn", m2)] },
					{ returned: undefined, logged: [logEntry("error", m1, { error: failure })] },
					{ returned: undefined, logged: [logEntry("warn", m1)] },
					{ returned: [`info:${m3}`, 0], logged: [logEntry("info", m1)] },
					{ returned: undefined, logged: [logEntry("warn", m1)] },
				][kind],
			});
		}
		return {
			before,
			after,
			sites,
			decoys,
			cases,
			observe: async (root) => {
				// Consumers import the logger without a cache-busting query, so this is their instance.
				const { entries } = await import(pathToFileURL(path.join(root, "src/lib/logger.ts")).href);
				return entries.splice(0);
			},
			prompt:
				"Replace the deprecated log() from src/lib/log.ts with the logger from src/lib/logger.ts everywhere, then delete src/lib/log.ts. Preserve the recorded log entries.",
			brief: `Migrate every call to the deprecated \`log(level, message, error?)\` from src/lib/log.ts to \`logger\` from src/lib/logger.ts (${size} files under src/features), then delete src/lib/log.ts. Map \`log("info" | "warn" | "error", m)\` to \`logger.info/warn/error(m)\`. A third argument becomes \`{ error: <arg> }\` context: \`log("error", m, err)\` becomes \`logger.error(m, { error: err })\`. Calls with a non-literal level become \`logger.log(level, m)\`. Replace the log import with \`logger\`, importing \`type LogLevel\` from lib/logger where it is used. Leave audit.log, Math.log and string contents alone. Make no other changes; run \`npm run check\` afterwards.`,
		};
	},
};

/** A module that still exports `name`, by declaration or export list, as a leftover re-export shim would. */
const stillExports = (file: string, name: string): Check => ({
	file,
	label: `${file} no longer exports ${name}`,
	holds: (text) =>
		text !== undefined && !new RegExp(`export(?:async)?function${name}\\b|export\\{[^}]*\\b${name}\\b`).test(text),
});

const moveDeclaration: Family = {
	id: "move-declaration",
	revision: "scale-v1",
	category: "move",
	build(size) {
		const from = "src/utils/date.ts";
		const to = "src/shared/time/format.ts";
		const formatRange = `export function formatRange(start: number, end: number): string {\n  return \`\${formatDate(start)}..\${formatDate(end)}\`;\n}\n`;
		const before: Record<string, string> = {
			[from]: dateSource("./locale") + formatRange,
			"src/utils/locale.ts": 'export const LOCALE = "en-GB";\n',
			"src/utils/index.ts": 'export * from "./date";\nexport * from "./locale";\n',
			"src/legacy/date.ts":
				'export function formatDate(epochDay: number): string {\n  return "legacy:" + epochDay;\n}\n',
			"src/legacy/report.ts": 'import { formatDate } from "./date";\nexport const report = () => formatDate(1);\n',
		};
		const after: Record<string, string | null> = {
			[from]: `import { formatDate } from "../shared/time/format";\n${formatRange}`,
			[to]: dateSource("../../utils/locale"),
			"src/utils/index.ts":
				'export * from "./date";\nexport { formatDate } from "../shared/time/format";\nexport * from "./locale";\n',
		};
		const sites: Check[] = [
			stillExports(from, "formatDate"),
			resolvesTo(from, to),
			resolvesTo(to, "src/utils/locale.ts"),
			resolvesTo("src/utils/index.ts", to),
		];
		const decoys: Check[] = [contains("src/legacy/report.ts", 'from "./date"')];
		const cases: Case[] = [
			{ file: "src/utils/index.ts", call: "formatDate", args: [7], expected: "en-GB:7" },
			{ file: from, call: "formatRange", args: [1, 2], expected: "en-GB:1..en-GB:2" },
		];
		for (let i = 0; i < size; i++) {
			const file = consumer(i);
			const call = `feature${i}`;
			const day = key(i, 1);
			const kind = i % 6;
			const date = specifier(file, from);
			const moved = specifier(file, to);
			const body = (use: string) => `export function ${call}() {\n  return ${use};\n}\n`;
			const text = (target: string) =>
				[
					`import { formatDate } from "${target}";\n${body(`formatDate(${day})`)}`,
					`import { formatDate as fd } from "${target}";\nimport { formatRange } from "${date}";\n${body(`fd(${day}) + " " + formatRange(${day}, ${day + 1})`)}`,
					`export { formatDate as ${call} } from "${target}";\n`,
					`import { formatDate } from "${specifier(file, "src/utils/index.ts")}";\n${body(`formatDate(${day})`)}`,
					`import { formatDate } from "${specifier(file, "src/legacy/date.ts")}";\n${body(`formatDate(${day})`)}`,
					`import { formatRange } from "${date}";\n${body(`formatRange(${day}, ${day + 1})`)}`,
				][kind]!;
			// Kind 1 starts with both names in one import from utils/date; only formatDate moves.
			before[file] =
				kind === 1
					? `import { formatDate as fd, formatRange } from "${date}";\n${body(`fd(${day}) + " " + formatRange(${day}, ${day + 1})`)}`
					: text(date);
			if (kind <= 2) {
				after[file] = text(moved);
				sites.push(resolvesTo(file, to));
			}
			if (kind === 1) decoys.push(resolvesTo(file, from));
			if (kind === 3) decoys.push(resolvesTo(file, "src/utils/index.ts"));
			if (kind === 4) decoys.push(resolvesTo(file, "src/legacy/date.ts"));
			if (kind === 5) decoys.push(contains(file, `import { formatRange } from "${date}"`));
			const range = `en-GB:${day}..en-GB:${day + 1}`;
			cases.push({
				file,
				call,
				args: kind === 2 ? [day] : [],
				expected: [`en-GB:${day}`, `en-GB:${day} ${range}`, `en-GB:${day}`, `en-GB:${day}`, `legacy:${day}`, range][
					kind
				],
			});
		}
		const direct = count(size, 6, 0, 1, 2);
		return {
			before,
			after,
			sites,
			decoys,
			cases,
			prompt: `Move formatDate out of ${from} into a new module, ${to}, and update everything that depends on it. formatRange stays in ${from}. Preserve behaviour.`,
			brief: `Move the \`formatDate\` function from ${from} to a new file ${to}, taking the LOCALE import it needs. \`formatRange\` stays in ${from} and imports formatDate from the new file; ${from} must no longer export formatDate. Keep src/utils/index.ts exporting formatDate. Update the imports and re-exports of formatDate in the ${direct} files under src/features that take it from utils/date directly, including aliased ones; their formatRange imports keep pointing at utils/date. Files importing the src/utils barrel keep that import. Do not change src/legacy/date.ts or its importers. Make no other changes; run \`npm run check\` afterwards.`,
		};
	},
};

const impactReport: Family = {
	id: "impact-report",
	revision: "scale-v2",
	category: "analysis",
	build(size) {
		const before: Record<string, string> = {
			"src/lib/pricing.ts":
				"export function applyDiscount(cents: number, rate: number): number { return Math.round(cents * (1 - rate)); }\n",
			"src/lib/index.ts": 'export { applyDiscount } from "./pricing";\n',
			"src/legacy/pricing.ts": "export function applyDiscount(cents: number): number { return cents - 1; }\n",
			"src/features/shared/discount.ts":
				'import { applyDiscount } from "../../lib/pricing";\nexport function sharedDiscount(cents: number) { return applyDiscount(cents, 0.1); }\n',
		};
		const names: string[] = ["sharedDiscount"];
		const decoyNames: string[] = [];
		for (let i = 0; i < size; i++) {
			const file = i === 0 ? "src/features/feature0.tsx" : consumer(i);
			const name = `feature${i}`;
			const kind = i % 7;
			const lib = specifier(file, kind === 1 ? "src/lib/index.ts" : "src/lib/pricing.ts");
			const shared = specifier(file, "src/features/shared/discount.ts");
			const legacy = specifier(file, "src/legacy/pricing.ts");
			const texts = [
				`import { applyDiscount } from "${lib}";\nexport function ${name}() { return applyDiscount(${key(i, 1)}, 0.1); }\n`,
				`import { applyDiscount } from "${lib}";\nexport function ${name}() { return applyDiscount(${key(i, 1)}, 0.1); }\n`,
				`import { applyDiscount as discount } from "${lib}";\nexport function ${name}() { return discount(${key(i, 1)}, 0.1); }\n`,
				`import { sharedDiscount } from "${shared}";\nexport function ${name}() { return sharedDiscount(${key(i, 1)}); }\n`,
				`import { applyDiscount } from "${legacy}";\nexport function ${name}() { return applyDiscount(${key(i, 1)}); }\n`,
				`function applyDiscount(cents: number) { return cents - 2; }\nexport function ${name}() { return applyDiscount(${key(i, 1)}); }\n`,
				`class Cart { applyDiscount() { return 3; } }\nexport const event${i} = "applyDiscount";\nexport function ${name}() { return new Cart().applyDiscount(); }\n`,
			];
			before[file] = texts[kind]!;
			if (i === 0) {
				before[file] +=
					`declare global { namespace JSX { interface IntrinsicElements { [name: string]: Record<string, unknown> } } }
export function Preview<T extends { cents: number }>(props: { items: T[]; title: string }) {
  return <section data-title={props.title}><header><strong>{props.title}</strong></header><main>{props.items.map((item, index) => <article data-index={index}><span>{applyDiscount(item.cents, 0.1)}</span></article>)}</main></section>;
}
`;
				names.push("Preview");
			}
			(kind < 4 ? names : decoyNames).push(name);
		}
		const expected = names.toSorted();
		return {
			before,
			after: { "IMPACT.txt": expected.join("\n") + "\n" },
			sites: expected.map((name) => contains("IMPACT.txt", name)),
			decoys: decoyNames.map((name) => ({
				file: "IMPACT.txt",
				label: `IMPACT.txt: ${name} must be absent`,
				holds: (text) => !text?.includes(name),
			})),
			cases: [],
			prompt:
				"If applyDiscount in src/lib/pricing.ts changed its behaviour, which exported functions under src/features would be affected, directly or through other functions? Write their names to IMPACT.txt, one per line, sorted by character code (uppercase before lowercase).",
			brief:
				"Report exported functions under src/features affected directly or transitively by applyDiscount in src/lib/pricing.ts, through imports, aliases and re-exports. Exclude the separate legacy function, local functions with the same name, class methods, and strings. Write only the affected function names to IMPACT.txt, one per line, sorted by character code (uppercase before lowercase). Make no other changes; run `npm run check` afterwards.",
		};
	},
};

const methodMigration: Family = {
	id: "method-migration",
	revision: "scale-v1",
	category: "migration",
	build(size) {
		const before: Record<string, string> = {
			"src/lib/row.ts": `export const calls: { fresh?: boolean }[] = [];
export interface Getter { get(index: number, options?: { fresh?: boolean }): number }
export class Row implements Getter {
  get(index: number, options: { fresh?: boolean } = {}): number {
    calls.push(options);
    return index + 10;
  }
}
`,
			"src/lib/cache.ts": "export class Cache { get(key: string) { return key; } }\n",
		};
		const after: Record<string, string | null> = {};
		const sites: Check[] = [];
		const decoys: Check[] = [contains("src/lib/cache.ts", "get(key: string)")];
		const cases: Case[] = [];
		for (let i = 0; i < size; i++) {
			const file = consumer(i);
			const row = specifier(file, "src/lib/row.ts");
			const cache = specifier(file, "src/lib/cache.ts");
			const name = `feature${i}`;
			const variants = [
				[
					`import { Row } from "${row}";\nexport function ${name}() { const row = new Row(); return row.get(1) + row.get(2); }\n`,
					`import { Row } from "${row}";\nexport function ${name}() { const row = new Row(); return row.get(1, { fresh: true }) + row.get(2, { fresh: true }); }\n`,
					2,
					23,
				],
				[
					`import { Row } from "${row}";\nexport function ${name}() { const row = new Row(); return row.get(\n  3,\n); }\n`,
					`import { Row } from "${row}";\nexport function ${name}() { const row = new Row(); return row.get(\n  3,\n  { fresh: true },\n); }\n`,
					1,
					13,
				],
				[
					`import { Row } from "${row}";\nexport function ${name}() { const row: Row | undefined = new Row(); return row?.get(0); }\n`,
					`import { Row } from "${row}";\nexport function ${name}() { const row: Row | undefined = new Row(); return row?.get(0, { fresh: true }); }\n`,
					1,
					10,
				],
				[
					`import { Row } from "${row}";\nexport function ${name}() { const rows = [new Row(), new Row()]; return rows.map((r) => r.get(0)); }\n`,
					`import { Row } from "${row}";\nexport function ${name}() { const rows = [new Row(), new Row()]; return rows.map((r) => r.get(0, { fresh: true })); }\n`,
					2,
					[10, 10],
				],
				[
					`import { Row as TableRow } from "${row}";\nexport function ${name}() { return new TableRow().get(4); }\n`,
					`import { Row as TableRow } from "${row}";\nexport function ${name}() { return new TableRow().get(4, { fresh: true }); }\n`,
					1,
					14,
				],
				[
					`import { Row, type Getter } from "${row}";\nexport function ${name}() { const row: Getter = new Row(); return row.get(5); }\n`,
					`import { Row, type Getter } from "${row}";\nexport function ${name}() { const row: Getter = new Row(); return row.get(5, { fresh: true }); }\n`,
					1,
					15,
				],
				[
					`import { Row } from "${row}";\nimport { Cache } from "${cache}";\nconst get = (n: number) => n;\nexport const hint${i} = ".get(";\nexport function ${name}() { new Cache().get("x"); new Map().get("x"); new URLSearchParams().get("x"); get(1); return new Row().get(6); }\n`,
					`import { Row } from "${row}";\nimport { Cache } from "${cache}";\nconst get = (n: number) => n;\nexport const hint${i} = ".get(";\nexport function ${name}() { new Cache().get("x"); new Map().get("x"); new URLSearchParams().get("x"); get(1); return new Row().get(6, { fresh: true }); }\n`,
					1,
					16,
				],
			] as const;
			const [start, solution, calls, returned] = variants[i % variants.length]!;
			before[file] = start;
			after[file] = solution;
			sites.push(contains(file, "{ fresh: true }", `${name} Row.get option`));
			if (i % variants.length === 0)
				sites.push(matches(file, /row\.get\(1,\{fresh:true\}\)\+row\.get\(2,\{fresh:true\}\)/, `${name} both calls`));
			if (i % variants.length === 6)
				decoys.push(
					contains(file, 'new Cache().get("x")'),
					contains(file, 'new Map().get("x")'),
					contains(file, 'new URLSearchParams().get("x")'),
					contains(file, "get(1)"),
					contains(file, '".get("'),
				);
			cases.push({
				file,
				call: name,
				expected: { returned, logged: Array.from({ length: calls }, () => ({ fresh: true })) },
			});
		}
		return {
			before,
			after,
			sites,
			decoys,
			cases,
			observe: async (root) => {
				const { calls } = await import(pathToFileURL(path.join(root, "src/lib/row.ts")).href);
				return calls.splice(0);
			},
			prompt:
				"Every call to Row.get under src/features must pass { fresh: true } as its second argument. Add it to single-argument calls, preserving all other behaviour.",
			brief: `Update every Row.get call under src/features (${size} consumer files) to pass { fresh: true } second, including two calls on one line, multi-line and optional calls, map callbacks, aliased Row imports, and calls typed through an interface. Leave Cache.get, Map.get, URLSearchParams.get, local get functions and strings unchanged. Make no other changes; run \`npm run check\` afterwards.`,
		};
	},
};

export const scaleFamilies: Family[] = [
	renameSymbol,
	optionsMigration,
	moveModule,
	moveDeclaration,
	loggerMigration,
	impactReport,
	methodMigration,
];

function scaleTask(family: Family, size: number): Task {
	const fixture = family.build(size);
	const changed = Object.entries(fixture.after).filter(
		([file, text]) =>
			text === null || fixture.before[file] === undefined || squash(fixture.before[file]!) !== squash(text),
	);
	const drift = (root: string) =>
		measureDrift(root, { expected: changed.map(([file]) => file), sites: fixture.sites, decoys: fixture.decoys });
	const measuredDrift = async (root: string) => {
		const measured = await drift(root);
		if (family.id !== "impact-report") return measured;
		const lines = (await readFile(path.join(root, "IMPACT.txt"), "utf8").catch(() => ""))
			.split(/\r?\n/)
			.filter(Boolean);
		const expected = fixture.after["IMPACT.txt"]!.trim().split("\n");
		const expectedSet = new Set(expected);
		return {
			...measured,
			sites: expected.length,
			missed: expected.filter((name) => !lines.includes(name)).map((name) => `IMPACT.txt: ${name}`),
			decoys: fixture.decoys.length,
			overmatched: lines.filter((name) => !expectedSet.has(name)).map((name) => `IMPACT.txt: ${name}`),
		};
	};
	return {
		id: `${family.id}-${size}`,
		category: family.category,
		revision: family.revision,
		prompt: fixture.prompt,
		brief: fixture.brief,
		files: fixture.before,
		solution: Object.fromEntries(changed),
		include: ["src/**/*.ts", "src/**/*.tsx"],
		drift: measuredDrift,
		async verify(root) {
			if (family.id === "impact-report") {
				const actual = (await readFile(path.join(root, "IMPACT.txt"), "utf8").catch(() => ""))
					.replaceAll("\r\n", "\n")
					.replace(/\n$/, "")
					.split("\n");
				assert.deepEqual(
					actual,
					fixture.after["IMPACT.txt"]!.trim().split("\n"),
					"IMPACT.txt must list exactly the affected functions, sorted",
				);
			}
			for (const { file, call, args = [], expected } of fixture.cases) {
				const module = await moduleAt(root, file);
				assert.equal(typeof module[call], "function", `${file} must export ${call}`);
				const returned = await module[call](...args);
				const actual = fixture.observe ? { returned, logged: await fixture.observe(root) } : returned;
				assert.deepEqual(actual, expected, `${file} ${call}() changed behaviour`);
			}
			assertNoDrift(await measuredDrift(root));
		},
	};
}

export const scaleTasks: Task[] = scaleFamilies.flatMap((family) => scaleSizes.map((size) => scaleTask(family, size)));
