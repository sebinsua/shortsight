# `shortsight`

Two tools for coding agents working on TypeScript and JavaScript repositories:

- `shorthand` lets an agent change a repository by writing a small program, so a change that touches many files is one step instead of many.
- `sightread` shows how a codebase fits together, so an agent reads only the code it needs.

Each works on its own.

## `shorthand`

![A shorthand call in Pi](https://raw.githubusercontent.com/sebinsua/shortsight/main/docs/shorthand.png)

Instead of a patch, the agent writes a Bun program that can search, rewrite syntax, and rename or move TypeScript symbols. The program edits a private copy of the repository, and the agent sees the diff of what it changed. Agents are good at improving things a step at a time, so changes are applied a whole file at a time and the agent is told which worked and which didn't.

### Install

Install [Bun](https://bun.sh) 1.4 or later:

```sh
curl -fsSL https://bun.sh/install | bash
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

Then install it for [Pi](https://github.com/earendil-works/pi), which gives Pi a `shorthand` tool:

```sh
pi install npm:pi-shorthand
```

Or install the `shorthand` command, for other agents and scripts:

```sh
npm i -g shorthand-code
```

Usage is in [pi-shorthand's README](packages/pi-shorthand/README.md) and [shorthand-code's README](packages/shorthand-code/README.md).

## `sightread`

![What a change to getMimeType affects in hono](https://raw.githubusercontent.com/sebinsua/shortsight/main/docs/sightread.png)

`sightread` shows what calls what in a TypeScript codebase, and the exact lines each piece of code spans. It asks the TypeScript compiler, so it follows imports, aliases and re-exports that text search misses.

### Install

Install [Bun](https://bun.sh) 1.4 or later, then:

```sh
npm i -g sightread
```

Usage is in [`sightread`'s README](packages/sightread/README.md).

## Together

With `sightread` installed, `shorthand` programs can ask the same questions, then edit what they find in the same step.
