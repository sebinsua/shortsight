---
name: sightread
description: Find every place a TypeScript symbol is used, what calls what, and exactly which lines each piece of code spans, from the TypeScript compiler. Use it instead of searching text or opening files to locate code, before editing call sites, and to see what a branch changed and affects.
---

# sightread

Use `sightread` instead of searching text or opening files to find where code is and what it touches.
Its answers come from the TypeScript compiler, including uses through aliases, re-exports and
interfaces, so trust them: don't repeat the search with `rg` or `grep`.

Ask everything you need in one call, as a JSON array. Names work directly, and a name can carry its file
when the task gives one, like `src/api/users.ts#getUser`:

```sh
sightread '[{"type":"references","symbol":"Session.refresh"},{"type":"trace","from":"Session.refresh","direction":"reverse"}]'
```

- To change every use of something, ask for `references`. It lists each use with its line and text,
  the whole call when it spans lines, and the declaration it's in, which is enough to edit without
  reading the file. With `--json`, each use also gives the exact range of its call and of each
  argument, enough to script many edits without a parser.
- To see what a change affects, ask for `trace` with `"direction": "reverse"`; for what something
  calls, `"forward"`. A trace follows symbols, so calls at a file's top level, such as in tests, aren't
  in it; `references` finds every use.
- For what a symbol uses and contains, `details`. To get your bearings, `overview`. For a branch,
  `sightread diff`.

Read only the line ranges it gives. After editing, verify with the project's type check. Line numbers
change when files do, so ask again rather than reuse old ones.

Run it from where you are. If that's the root of a monorepo, a note names the packages to run it from
instead. `sightread --help` lists every field.
