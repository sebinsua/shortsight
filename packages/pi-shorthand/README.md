# pi-shorthand

![A code call in Pi](https://raw.githubusercontent.com/sebinsua/shortsight/main/docs/shorthand.png)

A [Pi](https://github.com/earendil-works/pi) tool for editing repositories with Bun programs, with first-class support for TypeScript and JavaScript.

## Install

Install [Bun](https://bun.sh) 1.4 or later, which runs the programs:

```sh
curl -fsSL https://bun.sh/install | bash
```

Then install pi-shorthand:

```sh
pi install npm:pi-shorthand
```

On macOS, install clang and AgentFS:

```sh
xcode-select --install
curl -fsSL https://agentfs.ai/install | bash
```

On Linux, install bubblewrap 0.11 or later, a C compiler, and `lsof`. For Debian and Ubuntu, check the available bubblewrap version before installing:

```sh
apt-cache policy bubblewrap
sudo apt install bubblewrap build-essential lsof
```

## Technical choices

pi-shorthand gives Pi a programming environment instead of a patch format. This makes multi-file and structural edits possible in one call, but does not guarantee that Pi will find it easier or more reliable than its built-in edit tool. Which works better depends on the model and the task.

Programs edit a private workspace, with host files outside the repository kept read-only. Agents are good at improving things a step at a time, so changes are applied a whole file at a time and the agent is told which worked and which didn't. Concurrent edits can cause a run to be rejected; conflict detection is best-effort, not an atomic commit.

The `code` tool uses Pi's working directory by default. Pass `cwd` to target another checkout; relative paths are resolved from Pi's working directory. For example, when Pi starts in a bare worktree container, `cwd: "child"` targets its `child` worktree. The chosen directory must be inside a Git worktree.

Scripts run by Pi's `codemode` tool can call `code` too. They get back what the run changed as data, not text.

## Without Pi

The engine is published separately as [shorthand-code](https://github.com/sebinsua/shortsight/tree/main/packages/shorthand-code), with a `shorthand` command that runs a program from a file or stdin and prints the same result. See `shorthand --help`.

## Code graph (optional)

Install [`sightread`](https://github.com/sebinsua/shortsight/tree/main/packages/sightread) and programs can also ask the TypeScript compiler what calls what, with exact line ranges, before they edit:

```sh
npm i -g sightread
```
