import assert from "node:assert/strict";
import * as path from "node:path";
import { orderTask } from "./extract-quote.ts";
import { moduleAt, parseSource, source, type Task } from "./task.ts";
import { assertImports, assertTypes } from "../verification.ts";

const response = `export function json(data: unknown, options: number | { status: number }) {
  return { data, status: typeof options === "number" ? options : options.status };
}
export const c = { json };
`;
const routes = `import { c } from "./response";
export const fixed = () => [c.json({ ok: true }, 200), c.json({ nested: [1, 2] }, 404)];
export const dynamic = (status: number) => c.json("dynamic", status);
export const existing = () => c.json("existing", { status: 202 });
export const sample = "c.json(data, 400)";
`;
const extra = `import { c } from "./response";
export const other = () => c.json(
  { value: Math.max(2, 3) },
  503
);
`;
const validation = `export function validateAddress(address: string): string {
  const value = address.trim().toLowerCase();
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)) throw new Error("Invalid address");
  return value;
}
`;
const account = `export class Accounts {
  private values = new Map<string, string>();
  register(id: string, address: string) {
    const value = address.trim().toLowerCase();
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)) throw new Error("Invalid address");
    if (this.values.has(id)) throw new Error("Duplicate account");
    this.values.set(id, value);
    return value;
  }
  update(id: string, address: string) {
    const value = address.trim().toLowerCase();
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)) throw new Error("Invalid address");
    if (!this.values.has(id)) throw new Error("Unknown account");
    this.values.set(id, value);
    return value;
  }
  get(id: string) { return this.values.get(id); }
}
`;
const invitation = `export function invitation(address: string) {
  const value = address.trim().toLowerCase();
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)) throw new Error("Invalid address");
  return "Invite: " + value;
}
`;
const duplicatedValidation =
	/const value = address\.trim\(\)\.toLowerCase\(\);\n\s*if \([^\n]+\) throw new Error\("Invalid address"\);/g;

/** The original compact pilot: small fixtures that stock Pi also completes reliably. */
export const pilotTasks: Task[] = [
	orderTask,
	{
		id: "empty-average",
		category: "small-edit",
		revision: "embedded-v2",
		prompt:
			"Make average([]) return undefined. Preserve the existing behaviour for non-empty arrays and update the public return type accordingly.",
		files: {
			"average.ts":
				"export function average(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n",
		},
		solution: {
			"average.ts":
				"export function average(values: number[]): number | undefined {\n  if (values.length === 0) return undefined;\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n",
		},
		async verify(root) {
			const { average } = await moduleAt(root, "average.ts");
			assert.equal(average([]), undefined);
			for (const values of [[1], [1, 3], [-5, 1, 1], [0, 0], [0.1, 0.3]])
				assert.equal(average(values), values.reduce((a, b) => a + b, 0) / values.length);
			await assertTypes(`import { average } from ${JSON.stringify(path.join(root, "average.ts"))};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const correct: Equal<ReturnType<typeof average>, number | undefined> = true;
`);
		},
	},
	{
		id: "status-options",
		category: "migration",
		revision: "embedded-v2",
		prompt:
			"Wherever c.json(data, status) has a number literal as its second argument, pass that number in an options object with a status property. Leave other calls and string contents unchanged. Preserve behaviour.",
		files: { "response.ts": response, "routes.ts": routes, "extra.ts": extra },
		solution: {
			"routes.ts": routes.replace(", 200)", ", { status: 200 })").replace(", 404)", ", { status: 404 })"),
			"extra.ts": extra.replace("  503", "  { status: 503 }"),
		},
		async verify(root) {
			assert.equal(await source(root, "response.ts"), response);
			for (const file of ["routes.ts", "extra.ts"]) {
				const ast = await parseSource(root, file);
				for (const call of ast.findAll("c.json($DATA, $STATUS)"))
					assert.notEqual(call.getMatch("STATUS")?.kind(), "number");
			}
			const routesModule = await moduleAt(root, "routes.ts");
			assert.deepEqual(routesModule.fixed(), [
				{ data: { ok: true }, status: 200 },
				{ data: { nested: [1, 2] }, status: 404 },
			]);
			assert.deepEqual(routesModule.dynamic(418), { data: "dynamic", status: 418 });
			assert.deepEqual(routesModule.existing(), { data: "existing", status: 202 });
			assert.equal(routesModule.sample, "c.json(data, 400)");
			assert.deepEqual((await moduleAt(root, "extra.ts")).other(), { data: { value: 3 }, status: 503 });
			const ast = await parseSource(root, "routes.ts");
			assert.equal(ast.findAll('c.json("dynamic", status)').length, 1);
			assert.equal(ast.findAll('c.json("existing", { status: 202 })').length, 1);
		},
	},
	{
		id: "concurrency-map",
		category: "implementation",
		revision: "embedded-v2",
		prompt:
			"Implement mapConcurrent(items, limit, mapper) in map.ts. It returns a Promise of results in input order, runs at most limit mapper calls concurrently, and passes each item's index to mapper. Reject non-positive or non-integer limits, including for empty input. Propagate mapper errors, including synchronous throws, and stop starting new work once a failure is observed. Empty input returns an empty array. Preserve the generic signature.",
		files: {
			"map.ts":
				"export async function mapConcurrent<T, U>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<U>): Promise<U[]> {\n  throw new Error('Not implemented');\n}\n",
		},
		solution: {
			"map.ts": `export async function mapConcurrent<T, U>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<U>): Promise<U[]> {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Invalid limit");
  const result: U[] = []; let next = 0; let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try { result[index] = await mapper(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}
`,
		},
		async verify(root) {
			const { mapConcurrent } = await moduleAt(root, "map.ts");
			for (const limit of [0, -1, 1.5, NaN, Infinity])
				await assert.rejects(() => mapConcurrent([], limit, async (x: unknown) => x));
			assert.deepEqual(
				await mapConcurrent([], 2, async () => {
					throw new Error("Unexpected mapper");
				}),
				[],
			);
			let active = 0;
			let peak = 0;
			const result = await mapConcurrent([4, 3, 2, 1], 2, async (value: number, index: number) => {
				active++;
				peak = Math.max(active, peak);
				await Bun.sleep(value * 5);
				active--;
				return `${index}:${value}`;
			});
			assert.deepEqual(result, ["0:4", "1:3", "2:2", "3:1"]);
			assert.equal(peak, 2);
			for (const synchronous of [true, false]) {
				const error = new Error("mapper failure");
				const started: number[] = [];
				await assert.rejects(
					() =>
						mapConcurrent([0, 1, 2, 3], 1, (value: number) => {
							started.push(value);
							if (synchronous) throw error;
							return Promise.reject(error);
						}),
					(caught: unknown) => caught === error,
				);
				assert.deepEqual(started, [0]);
			}
			// Hold a second worker open until the first has failed. Check after it settles,
			// including implementations that reject before their remaining workers finish.
			const failure = new Error("concurrent mapper failure");
			const first = Promise.withResolvers<number>();
			const second = Promise.withResolvers<number>();
			const bothStarted = Promise.withResolvers<void>();
			const started: number[] = [];
			const rejected = assert.rejects(
				() =>
					mapConcurrent([0, 1, 2, 3], 2, (value: number) => {
						started.push(value);
						if (value === 0) return first.promise;
						if (value === 1) {
							bothStarted.resolve();
							return second.promise;
						}
						return Promise.resolve(value);
					}),
				(caught: unknown) => caught === failure,
			);
			await bothStarted.promise;
			first.reject(failure);
			await Bun.sleep(0);
			second.resolve(1);
			await rejected;
			await Bun.sleep(0);
			assert.deepEqual(started, [0, 1], "No worker may start new work after a failure is observed");
		},
	},
	{
		id: "shared-validation",
		category: "extraction",
		revision: "embedded-v2",
		prompt:
			"Extract the duplicated address normalisation and validation into an exported validateAddress function in validation.ts. Accounts.register, Accounts.update, and invitation must all use it. Preserve all existing return values, state changes, and error messages, including validation before account existence checks.",
		files: { "accounts.ts": account, "invitation.ts": invitation },
		solution: {
			"validation.ts": validation,
			"accounts.ts":
				'import { validateAddress } from "./validation";\n' +
				account.replace(duplicatedValidation, "const value = validateAddress(address);"),
			"invitation.ts":
				'import { validateAddress } from "./validation";\n' +
				invitation.replace(duplicatedValidation, "const value = validateAddress(address);"),
		},
		async verify(root) {
			const { validateAddress } = await moduleAt(root, "validation.ts");
			const { Accounts } = await moduleAt(root, "accounts.ts");
			const { invitation: invite } = await moduleAt(root, "invitation.ts");
			assert.equal(validateAddress(" A@B.COM "), "a@b.com");
			for (const invalid of ["", "a", "a@b", "a b@c.io", "a@@b.io"]) {
				assert.throws(() => validateAddress(invalid), { message: "Invalid address" });
				assert.throws(() => invite(invalid), { message: "Invalid address" });
			}
			const accounts = new Accounts();
			assert.equal(accounts.register("a", " A@B.COM "), "a@b.com");
			assert.throws(() => accounts.register("a", "invalid"), { message: "Invalid address" });
			assert.throws(() => accounts.register("a", "c@d.io"), { message: "Duplicate account" });
			assert.throws(() => accounts.update("missing", "invalid"), { message: "Invalid address" });
			assert.throws(() => accounts.update("missing", "c@d.io"), { message: "Unknown account" });
			assert.equal(accounts.get("a"), "a@b.com");
			assert.equal(accounts.update("a", " C@D.IO "), "c@d.io");
			assert.equal(accounts.get("a"), "c@d.io");
			assert.equal(invite(" A@B.COM "), "Invite: a@b.com");
			for (const [file, count] of [
				["accounts.ts", 2],
				["invitation.ts", 1],
			] as const) {
				const ast = await parseSource(root, file);
				assert.equal(ast.findAll("validateAddress($ARG)").length, count);
				assert.equal(ast.findAll("$VALUE.toLowerCase()").length, 0);
				await assertImports(root, file, "validation.ts");
			}
		},
	},
	{
		id: "request-cancellation",
		category: "propagation",
		revision: "embedded-v2",
		prompt:
			"Add an optional AbortSignal to loadUser, loadTeam, and dashboard, and forward it through every request. Existing callers without a signal must keep working. A dashboard call must use the same signal for both requests, and request failures must propagate unchanged.",
		files: {
			"client.ts":
				"export async function loadUser(id: string) { return (await fetch(`/users/${id}`)).json(); }\nexport async function loadTeam(id: string) { return (await fetch(`/teams/${id}`)).json(); }\n",
			"dashboard.ts":
				'import { loadUser, loadTeam } from "./client";\nexport async function dashboard(id: string) { const user = await loadUser(id); return { user, team: await loadTeam(user.teamId) }; }\n',
		},
		solution: {
			"client.ts":
				"export async function loadUser(id: string, signal?: AbortSignal) { return (await fetch(`/users/${id}`, { signal })).json(); }\nexport async function loadTeam(id: string, signal?: AbortSignal) { return (await fetch(`/teams/${id}`, { signal })).json(); }\n",
			"dashboard.ts":
				'import { loadUser, loadTeam } from "./client";\nexport async function dashboard(id: string, signal?: AbortSignal) { const user = await loadUser(id, signal); return { user, team: await loadTeam(user.teamId, signal) }; }\n',
		},
		async verify(root) {
			const client = await moduleAt(root, "client.ts");
			const { dashboard } = await moduleAt(root, "dashboard.ts");
			const originalFetch = globalThis.fetch;
			const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
			const error = new Error("request failed");
			let fail = false;
			try {
				globalThis.fetch = (async (url: string, options?: RequestInit) => {
					calls.push({ url, signal: options?.signal });
					if (fail) throw error;
					return { json: async () => (url.startsWith("/users/") ? { teamId: "t" } : { name: "team" }) };
				}) as unknown as typeof fetch;
				for (const signal of [undefined, new AbortController().signal]) {
					calls.length = 0;
					assert.deepEqual(await dashboard("u", signal), { user: { teamId: "t" }, team: { name: "team" } });
					assert.deepEqual(calls, [
						{ url: "/users/u", signal },
						{ url: "/teams/t", signal },
					]);
					calls.length = 0;
					await client.loadUser("v", signal);
					await client.loadTeam("q", signal);
					assert.deepEqual(calls, [
						{ url: "/users/v", signal },
						{ url: "/teams/q", signal },
					]);
				}
				fail = true;
				await assert.rejects(
					() => dashboard("u"),
					(caught: unknown) => caught === error,
				);
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	},
];
