# sightread

![What a change to getMimeType affects in hono](https://raw.githubusercontent.com/sebinsua/shortsight/main/docs/sightread.png)

`sightread` shows how a TypeScript codebase fits together: what calls what, and the exact lines each piece of code spans. A coding agent can get its bearings with one command, then read only the lines it needs instead of whole files.

## Install

Install [Bun](https://bun.sh) 1.4 or later, then `sightread`:

```sh
npm i -g sightread
```

## Use

Run it anywhere inside a TypeScript project, with a request as JSON:

```sh
sightread '{"type":"trace","from":"runWithBun","direction":"reverse"}'
```

```
trace reverse from runWithBun: 3 shown

packages/pi-shorthand/src/index.ts
  48-139  default  function
packages/shorthand-code/src/cli/shorthand.ts
  34-95  main  function
packages/shorthand-code/src/runner/client.ts
  20-115  runWithBun  function
packages/shorthand-code/test/graph.test.ts
  287-306  description  function

hops
  main → runWithBun      calls at shorthand.ts:73
  default → runWithBun   calls at index.ts:100
  description → default  calls at graph.test.ts:289
  description → default  type_ref at graph.test.ts:295
```

Pass an array to ask several questions at once. The requests you'll use most:

- `references` lists every use of a symbol with its line, so each one can be edited without opening the file.
- `trace` follows what calls something, or what it calls, to see what a change affects.
- `details` shows what a symbol calls, uses and contains.
- `tour` and `overview` sketch a feature or the whole project.
- `lookup` finds symbols when you only half know the name.

`sightread --help` lists every field, with examples. Names work wherever a request asks for a symbol, `symbol` names it in any request, and paths are relative to the repository, so you can pass them straight to other tools. Add `--json` for scripts, or `--in packages/api` to keep results to one part of a monorepo.

## What a branch changes

`sightread diff [base]` lists the declarations changed since your branch left `base` (by default, the default branch, or your uncommitted changes when you are on it), what calls them, and the tests that use them:

```
diff against main (1f2b8f79e012): formatPrice edited · used by 2 · tested by 0 files

src/price.ts
  1-3  formatPrice  edited
  └─ called by src/cart.ts:3-5  cartTotal
     └─ called by src/checkout.ts:3-5  checkoutSummary
```
