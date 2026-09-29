import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { $ } from "bun";
import type { Task } from "./task.ts";
import { assertImports } from "../verification.ts";

const types = `export interface Item { sku: string; price: number; quantity: number; taxable: boolean }
export interface Options { discount?: number; shipping?: number; taxRate?: number }
export interface Quote { subtotal: number; discount: number; shipping: number; tax: number; total: number; units: number }
`;
const body = `    const discountRate = options.discount ?? 0;
    const shipping = options.shipping ?? 0;
    const taxRate = options.taxRate ?? 0;
    if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 1) {
      throw new Error("Invalid discount");
    }
    if (!Number.isInteger(shipping) || shipping < 0) {
      throw new Error("Invalid shipping");
    }
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
      throw new Error("Invalid tax rate");
    }
    let subtotal = 0;
    let taxableSubtotal = 0;
    let units = 0;
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.sku || seen.has(item.sku)) {
        throw new Error("Invalid SKU");
      }
      seen.add(item.sku);
      if (!Number.isInteger(item.price) || item.price < 0) {
        throw new Error("Invalid price");
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new Error("Invalid quantity");
      }
      const line = item.price * item.quantity;
      subtotal += line;
      units += item.quantity;
      if (item.taxable) taxableSubtotal += line;
    }
    const discount = Math.round(subtotal * discountRate);
    const taxableDiscount = Math.round(taxableSubtotal * discountRate);
    const tax = Math.round((taxableSubtotal - taxableDiscount) * taxRate);
    const chargedShipping = items.length ? shipping : 0;
    return {
      subtotal,
      discount,
      shipping: chargedShipping,
      tax,
      total: subtotal - discount + chargedShipping + tax,
      units,
    };
`;
const original = `import type { Item, Options, Quote } from "./types";
export class Checkout {
  private completed: Quote[] = [];
  quote(items: readonly Item[], options: Options = {}): Quote {
${body}  }
  submit(items: readonly Item[], options: Options = {}): Quote {
    const quote = this.quote(items, options);
    this.completed.push(quote);
    return quote;
  }
  history(): readonly Quote[] { return [...this.completed]; }
}
`;
const preview = `import { Checkout } from "./checkout";
import type { Item, Options } from "./types";
export function preview(items: readonly Item[], options: Options = {}) {
  return new Checkout().quote(items, options);
}
`;

export const orderTask: Task = {
	id: "extract-quote",
	category: "extraction",
	revision: "embedded-v2",
	prompt:
		"Extract Checkout.quote's pricing calculation into an exported pure calculateQuote(items, options?) function in quote.ts. Keep Checkout's public API compatible by delegating to that function, and update preview to call it without constructing Checkout. Preserve all pricing, rounding, validation order, error messages, and submit/history behaviour. Keep the existing shared types.",
	files: { "types.ts": types, "checkout.ts": original, "preview.ts": preview },
	solution: {
		"quote.ts": `import type { Item, Options, Quote } from "./types";\nexport function calculateQuote(items: readonly Item[], options: Options = {}): Quote {\n${body}}\n`,
		"checkout.ts":
			'import { calculateQuote } from "./quote";\n' +
			original.replace(body, "    return calculateQuote(items, options);\n"),
		"preview.ts": preview
			.replace('import { Checkout } from "./checkout";', 'import { calculateQuote } from "./quote";')
			.replace("new Checkout().quote(items, options)", "calculateQuote(items, options)"),
	},
	async verify(root) {
		const { calculateQuote } = await import(
			`${pathToFileURL(path.join(root, "quote.ts")).href}?check=${crypto.randomUUID()}`
		);
		const { Checkout } = await import(
			`${pathToFileURL(path.join(root, "checkout.ts")).href}?check=${crypto.randomUUID()}`
		);
		const { preview: render } = await import(
			`${pathToFileURL(path.join(root, "preview.ts")).href}?check=${crypto.randomUUID()}`
		);
		const checkout = new Checkout();
		const items = [
			{ sku: "a", price: 101, quantity: 3, taxable: true },
			{ sku: "b", price: 250, quantity: 2, taxable: false },
		];
		const options = { discount: 0.15, shipping: 49, taxRate: 0.2 };
		const expected = { subtotal: 803, discount: 120, shipping: 49, tax: 52, total: 784, units: 5 };
		for (const fn of [calculateQuote, checkout.quote.bind(checkout), render]) {
			assert.deepEqual(fn(items, options), expected);
			assert.deepEqual(fn([], { shipping: 99 }), { subtotal: 0, discount: 0, shipping: 0, tax: 0, total: 0, units: 0 });
			assert.deepEqual(fn(items), { subtotal: 803, discount: 0, shipping: 0, tax: 0, total: 803, units: 5 });
			for (const [badOptions, message] of [
				[{ discount: 2, shipping: -1 }, "Invalid discount"],
				[{ shipping: -1, taxRate: 2 }, "Invalid shipping"],
				[{ taxRate: NaN }, "Invalid tax rate"],
			] as const)
				assert.throws(() => fn(items, badOptions), { message });
			for (const [badItems, message] of [
				[[items[0], items[0]], "Invalid SKU"],
				[[{ ...items[0], sku: "", price: -1 }], "Invalid SKU"],
				[[{ ...items[0], price: -1, quantity: 0 }], "Invalid price"],
				[[{ ...items[0], quantity: 0 }], "Invalid quantity"],
			] as const)
				assert.throws(() => fn(badItems), { message });
		}
		assert.deepEqual(checkout.history(), []);
		assert.deepEqual(checkout.submit(items, options), expected);
		assert.throws(() => checkout.submit(items, { discount: -1 }));
		assert.deepEqual(checkout.history(), [expected]);
		const copy = checkout.history();
		copy.length = 0;
		assert.equal(checkout.history().length, 1);
		// Unchanged since the fixture's commit, which holds it as its formatter wrote it.
		const committed = await $`git show HEAD:types.ts`.cwd(root).quiet().text();
		assert.equal(await readFile(path.join(root, "types.ts"), "utf8"), committed);
		for (const file of ["checkout.ts", "preview.ts"]) {
			const text = await readFile(path.join(root, file), "utf8");
			const ast = parse(Lang.TypeScript, text).root();
			assert.equal(ast.findAll("calculateQuote($$$ARGS)").length, 1);
			assert.equal(ast.findAll("Math.round($$$ARGS)").length, 0);
			assert.equal(ast.findAll("new Checkout($$$ARGS)").length, 0);
			await assertImports(root, file, "quote.ts");
		}
	},
};
