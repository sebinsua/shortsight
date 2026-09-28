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
trace reverse from runWithBun: 3 shown in 3 files; 2 at depth 1, 1 at depth 2

packages/pi-shorthand/src/index.ts
  54-148  default  exported function  calls runWithBun :108
packages/shorthand-code/src/cli/shorthand.ts
  38-105  main  function  calls runWithBun :83
packages/shorthand-code/src/runner/client.ts
  20-115  runWithBun  exported function
packages/shorthand-code/test/graph.test.ts
  504-523  description  function  calls default :506; type_ref default :512
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
