#!/usr/bin/env bun
// Parse the sightread command and route requests to a project daemon.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiff } from "./diff/index.ts";
import { DiscoveryError, findProject, type Project } from "./project.ts";
import { connect, listServers, ServerRequestError, stopAllServers, stopServer } from "./server/client.ts";
import { runDaemon } from "./server/daemon.ts";

const usage = `sightread [--cwd DIR] [--in DIR] [--json | --raw] '<JSON request or array>'
sightread [--cwd DIR] [--json] diff [base]
sightread [--cwd DIR] --help
sightread --skill
sightread ps
sightread [--cwd DIR] stop [--all]`;
const argumentError = "pass one JSON request (or array); run sightread --help";

function helpField(name: string, description?: string): string[] {
	if (!description) return [`  ${name}`];
	const prefix = `  ${name} — `;
	const hanging = " ".repeat(prefix.length);
	const words = description.replace(/\s+/g, " ").trim().split(" ");
	const rows: string[] = [];
	let line = prefix;
	for (const word of words) {
		if (line.length > prefix.length && line.length + word.length + 1 > 100) {
			rows.push(line);
			line = hanging + word;
		} else line += `${line.endsWith(" ") ? "" : " "}${word}`;
	}
	rows.push(line);
	return rows;
}

function isRequest(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function showHelp(cwd: string): Promise<string> {
	let temporary: string | undefined;
	let project: Project;
	try {
		project = await findProject(cwd);
	} catch {
		temporary = await mkdtemp(join(tmpdir(), "sightread-help-"));
		await writeFile(join(temporary, "tsconfig.json"), "{}");
		project = { root: temporary, tsconfig: join(temporary, "tsconfig.json") };
	}
	try {
		const client = await connect(project);
		try {
			const lines = [
				usage,
				"",
				"Examples:",
				`  sightread '{"type":"lookup","query":"findProject"}'`,
				`  sightread '{"type":"trace","from":"findProject","direction":"reverse"}'`,
				`  sightread '{"type":"trace","from":"findProject","direction":"forward"}'`,
				`  sightread '{"type":"details","handles":["findProject"]}'`,
				`  sightread '{"type":"references","symbol":"Session.refresh"}'`,
				"  sightread diff HEAD",
				"  --raw prints upstream values and project-relative paths unchanged.",
				"",
				"Request types:",
			];
			for (const request of await client.requestTypes()) {
				lines.push(request.type);
				for (const field of request.fields) {
					const values = field.values?.length ? ` (${field.values.join("/")})` : "";
					lines.push(...helpField(`${field.name}${field.required ? "*" : ""}${values}`, field.description));
				}
			}
			return lines.join("\n");
		} finally {
			if (temporary) await stopServer(project);
		}
	} finally {
		if (temporary) await rm(temporary, { recursive: true, force: true });
	}
}

async function query(
	cwd: string,
	requests: Record<string, unknown>[],
	mode: "text" | "json" | "raw",
	within?: string,
): Promise<string> {
	const project = await findProject(cwd);
	const output = await (
		await connect(project)
	).query(requests, {
		mode,
		cwd,
		in: within,
		color: mode === "text" && process.stdout.isTTY && process.env.NO_COLOR === undefined,
	});
	if (requests.length > 1) {
		const allFailed =
			mode === "text"
				? output.split(/\n\n(?==== \d+:)/).every((part) => /^=== \d+: [^\n]+ ===\nerror: /.test(part))
				: (mode === "json"
						? (JSON.parse(output) as unknown[])
						: output.split("\n").map((line) => JSON.parse(line) as unknown)
					).every((item) => isRequest(item) && typeof item.error === "string");
		if (allFailed) process.exitCode = 1;
	}
	return output;
}

async function main(args: string[]): Promise<string> {
	if (args[0] === "--daemon" && args.length === 3) {
		await runDaemon({ root: args[1], tsconfig: args[2] });
		return "";
	}
	let cwd = process.cwd();
	let json = false;
	let raw = false;
	let within: string | undefined;
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--cwd") {
			const directory = args[++index];
			if (!directory) throw new Error(argumentError);
			cwd = directory;
		} else if (arg === "--json") json = true;
		else if (arg === "--raw") raw = true;
		else if (arg === "--in") {
			within = args[++index];
			if (!within) throw new Error(argumentError);
		} else positionals.push(arg);
	}
	if (json && raw)
		throw new Error("usage: sightread [--cwd DIR] [--in DIR] [--json | --raw] '<JSON request or array>'");
	if (positionals.length === 1 && ["--help", "-h"].includes(positionals[0])) return showHelp(cwd);
	if (positionals.length === 1 && positionals[0] === "--skill")
		return readFile(join(import.meta.dir, "../skills/sightread/SKILL.md"), "utf8");
	if (positionals[0] === "ps" && positionals.length === 1) {
		return (await listServers())
			.map(({ pid, project, lastUsed }) => `${pid}\t${project}\t${new Date(lastUsed).toISOString()}`)
			.join("\n");
	}
	if (
		positionals[0] === "stop" &&
		(positionals.length === 1 || (positionals.length === 2 && positionals[1] === "--all"))
	) {
		if (positionals[1] === "--all") await stopAllServers();
		else await stopServer(await findProject(cwd));
		return "stopped";
	}
	if (positionals[0] === "diff") {
		if (positionals.length > 2 || raw || within) throw new Error("usage: sightread [--cwd DIR] [--json] diff [base]");
		return runDiff(await findProject(cwd), positionals[1], {
			json,
			color: !json && !!process.stdout.isTTY && process.env.NO_COLOR === undefined,
		});
	}
	if (positionals.length !== 1) throw new Error(argumentError);
	let parsed: unknown;
	try {
		parsed = JSON.parse(positionals[0]);
	} catch {
		throw new Error("invalid JSON request; run sightread --help");
	}
	if (!isRequest(parsed) && !Array.isArray(parsed)) throw new Error(argumentError);
	if (Array.isArray(parsed) && parsed.length === 0) throw new Error("batch must contain at least one request");
	const requests: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
	if (!requests.every(isRequest)) throw new Error(argumentError);
	return query(cwd, requests as Record<string, unknown>[], raw ? "raw" : json ? "json" : "text", within);
}

try {
	const output = await main(process.argv.slice(2));
	if (process.argv[2] !== "--daemon") {
		if (process.argv.includes("--skill")) process.stdout.write(output);
		else console.log(output);
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(
		`sightread: ${(error instanceof ServerRequestError && error.full) || error instanceof DiscoveryError || /(?: is ambiguous; use a handle:| not found(?:; nearest:)?) /.test(`${message} `) ? message : message.length > 240 ? `${message.slice(0, 239)}…` : message}`,
	);
	process.exitCode = 1;
}
