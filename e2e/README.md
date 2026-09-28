# Session comparisons

This harness compares how Pi completes coding tasks with different editing interfaces. It records the whole
session, checks the result independently, and keeps evidence for human review.

## Results

Latest run, 2026-09-28 at bcfb74d: `openai-codex/gpt-5.6-sol`, high reasoning, `baseline` against `code` with
the skill, two attempts per cell, results in `results/main-sol-2026-09-28`. Times are means, with the previous
single run in brackets. The skill no longer has examples mirroring the tasks (3aa9d94), so these are the first
shorthand numbers free of that. The two attempts in a cell differed by up to 23s.

| Task                    | Prompt  | Files |           Stock |     Shorthand |
| ----------------------- | ------- | ----: | --------------: | ------------: |
| `rename-symbol`         | brief   |   100 |      91s (142s) | **37s** (55s) |
| `rename-symbol`         | outcome |   100 |      84s (129s) | **32s** (43s) |
| `options-migration`     | brief   |   100 |     115s (106s) | **87s** (75s) |
| `options-migration`     | outcome |   100 |  **68s** (140s) |    75s (107s) |
| `move-module`           | brief   |   100 |       44s (87s) | **41s** (52s) |
| `move-module`           | outcome |   100 |       53s (57s) | **39s** (47s) |
| `move-declaration`      | outcome |    40 | failed (failed) | **52s** (39s) |
| `logger-migration`      | brief   |   100 |   **64s** (60s) |     93s (79s) |
| `logger-migration`      | outcome |   100 |  **76s** (115s) |    124s (79s) |
| `rename-symbol`         | brief   |    10 |       41s (76s) | **21s** (35s) |
| `options-migration`     | brief   |    10 |   **38s** (50s) |     74s (63s) |
| `empty-average` (pilot) | outcome |     1 |   **18s** (24s) |     21s (24s) |

Stock `move-declaration` failed both attempts as before: it repointed the `src/utils` barrel's importers
instead of re-exporting the moved function from it. Every other attempt verified with zero drift, four of them
only after two checks were corrected in this round. Stock `options-migration` (outcome) destructured the
options, `{ retries = 0, timeoutMs = 1000 }: RequestOptions = {}`, which the signature check didn't accept; one
attempt per setup in `logger-migration` (outcome) wrote `logger.log("info", m)` rather than `logger.info(m)`.
Both keep behaviour and now count. The first run of this round lost 30 attempts to an expired sign-in (fixed in
e4a8645); those cells were run again, and the ones counted here all completed.

The pilot and guidance suites verified every task in both conditions, with shorthand 9–76% slower.

### sightread

Latest run, 2026-09-28 at bcfb74d (after v0.11.0): `openai-codex/gpt-5.6-sol`, high reasoning, outcome
prompts, two attempts per cell, `--skills shorthand`, results in `results/sightread-sol-2026-09-28`. All 32
attempts verified with zero drift. Times are means, with the previous round (2026-09-26) in brackets. The two
attempts in a cell differed by up to 42s, so only large gaps mean anything.

| Task               | Files |     Stock | Stock + sightread | Shorthand | Shorthand + sightread |
| ------------------ | ----: | --------: | ----------------: | --------: | --------------------: |
| `impact-report`    |    10 | 26s (19s) |         17s (18s) | 25s (29s) |             20s (19s) |
| `method-migration` |    10 | 39s (45s) |         50s (47s) | 56s (60s) |             49s (44s) |
| `impact-report`    |   100 | 35s (50s) |         53s (44s) | 70s (48s) |             39s (41s) |
| `method-migration` |   100 | 97s (67s) |        64s (134s) | 78s (71s) |             83s (52s) |

In the stock 100-file migration, sightread's `references` call and argument ranges now carry the whole edit:
agents script it from `--json` output instead of hunting for a TypeScript parser, halving the previous time.

The 100-file impact report is slower with sightread than without it in stock, and needs more turns in both
setups (8–8.5 against 5–7 before). `applyDiscount` has 46 direct callers, more than the graph's 32-symbol
limit, so since 8b14640 the default reverse trace stops at those callers and says `truncated; raise
trace.maxDepth`. In all four sightread attempts the agent then ran `sightread --help` to find the field and
traced again with `maxDepth` (8–50), adding two turns. The previous round answered it in one trace.

The shorthand + sightread 100-file migration has one slow attempt (104s): its program applied all 100 files in
one call, then the agent spent nine more shell calls checking the result, including reading truncated shell output
back from Pi's log. The other took 62s. The 10-file impact rows of the previous
round overlapped with another benchmark run, so their times are rough. Earlier rounds, and what each change
fixed, are in the commit history from 04f244d.

## Layout

| Path                                             | Contents                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| [tasks.ts](tasks.ts)                             | Suite registry, fixture materialization and the evaluator CLI         |
| [tasks/pilot.ts](tasks/pilot.ts)                 | `pilot`: the original six compact tasks                               |
| [tasks/guidance.ts](tasks/guidance.ts)           | `guidance`: three held-out fixtures for documentation comparisons     |
| [tasks/scale.ts](tasks/scale.ts)                 | `scale`: generated repository-scale refactors at 10, 40 and 100 files |
| [tasks/drift.ts](tasks/drift.ts)                 | Missed-site, over-match and unrelated-change measurement              |
| [suite.ts](suite.ts), [run.ts](run.ts)           | Planning/execution across tasks, and the per-task session runner      |
| [reference-edits.ts](reference-edits.ts)         | Human-authored shorthand programs replayed through the real backend   |
| [replay-edit-errors.ts](replay-edit-errors.ts)   | Replays of observed API failures and their minimal corrections        |
| [transaction-scaling.ts](transaction-scaling.ts) | Backend regression: untouched tree size must not expand observation   |

## Plan without calling a model

```sh
bun e2e/suite.ts
bun e2e/suite.ts --tasks status-options,shared-validation --documentation shipped,minimal
bun e2e/suite.ts --suite scale --prompts outcome,brief
```

The suite prints the tasks and conditions and exits. **Only `--execute` starts model sessions.** Tests use a fake
Pi executable and never call a model. The lower-level `run.ts` command retains its existing behaviour: invoking
it starts Pi immediately.

## Tasks and verification

`--suite pilot|guidance|scale` selects a suite (default `pilot`); `--tasks` accepts IDs from any suite. Each task
has versioned starting files, an outcome-only prompt, a reference solution and an evaluator. Evaluate a
working directory with `bun e2e/tasks.ts <task-id> <directory>`.
Starting files, a TypeScript configuration, and a package with a `check` script are copied into the agent's fixture. Reference solutions and
evaluators stay outside it. These are evaluation boundaries, not a security sandbox against a malicious agent.

| Task                   | Category               | Independent checks                                                                                  |
| ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `extract-quote`        | Method extraction      | Pricing, rounding, validation order, delegated callers, and history state                           |
| `empty-average`        | Small edit             | Empty/non-empty behaviour and public return type                                                    |
| `status-options`       | API migration          | Runtime equivalence, AST check for remaining numeric arguments, unchanged dynamic calls and strings |
| `concurrency-map`      | Implementation         | Ordered results, actual concurrency, limit validation, error identity and stopping new work         |
| `shared-validation`    | Extraction             | Shared module use, removed duplicate normalisation, state and error ordering                        |
| `request-cancellation` | Multi-file propagation | Signal identity through both requests, old callers and failure propagation                          |

Every task also runs TypeScript checking using this checkout's installed compiler. Fixtures link that same
compiler under ignored `node_modules` for `npm run check` and `npx tsc`; the runner puts the fixture's `.bin` on
PATH for every condition. Preparation creates a local
Git repository from the embedded revision; it needs no downloads. Content fingerprints identify the exact input.
The regression tests require each starting fixture to fail its evaluator and its reference solution to pass.
These compact tasks are a starting point; add larger repository tasks before interpreting small differences as
general performance gains.

The `guidance` suite contains three held-out fixtures for testing documentation changes: table-formatting
extraction, boolean-option migration with comment preservation, and request-header propagation. Paired
`--baseline-extension`/`--candidate-extension` runs with `--skills shorthand --runs 2` alternate old/new
guidance order; both snapshots should use identical execution code. These tasks test transfer beyond the
original fixtures, not general repository performance.

### Scale suite

Every earlier study passed 100% in both stock and shorthand conditions, so pass rate could not distinguish
them. The `scale` suite generates seven task families, each across 10, 40 and 100 consumer files, e.g.
`rename-symbol-40`:

| Family              | Change                                                           | Decoys that must stay unchanged                                             |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `rename-symbol`     | Rename an exported function, through a barrel and aliases        | Same-named legacy function and its importers, shadowing parameters, strings |
| `options-migration` | Positional `request(url, retries, timeoutMs)` to options         | `cache.request`, file-local `request` functions, strings                    |
| `move-module`       | Move a module, updating its own import, re-exports and imports   | Barrel importers and a same-named legacy module                             |
| `move-declaration`  | Move `formatDate` out of `src/utils/date.ts`, keeping its barrel | A same-named legacy `formatDate` and its importer                           |
| `logger-migration`  | Replace deprecated `log(level, …)` with `logger`, delete it      | `audit.log`, `Math.log`, strings                                            |
| `impact-report`     | Report direct and transitive feature callers of `applyDiscount`  | Legacy and local functions, class methods, strings                          |
| `method-migration`  | Add `{ fresh: true }` to every `Row.get` call                    | Other `get` methods, local functions, strings                               |

Consumers vary call shape (multi-line calls, variables, `undefined` placeholders, dynamic levels) and directory
depth. Evaluators check behaviour of every consumer, type-check the fixture, and require zero drift.

**Drift** is reported separately from pass/fail, so failed attempts still show how far they strayed:

- _missed_: intended sites that were not changed;
- _overmatched_: decoys that were changed;
- _unrelated_: files changed outside the expected set, including scratch files. Whitespace, quote style and
  trailing commas are ignored.

The evaluator prints `DRIFT {…}` before verifying; `run.ts` records it per attempt and averages it by condition
alongside tool calls and output tokens.

**Prompts.** Every scale task has two prompts, selected with `--prompts outcome,brief`. `outcome` states the goal
only; `brief` is a precise, tool-neutral instruction of the kind a parent agent writes after exploring. It names
the sites, the decoys and the check command. This follows CodeTaste's instructed and open tracks, where frontier
models scored about 70% with detailed instructions and under 8% without
([CodeTaste, arXiv:2603.04177](https://arxiv.org/abs/2603.04177)). The brief isolates editing mechanics from discovery.
Each prompt style is a separate `run.ts` experiment, recorded as `promptStyle`.

Start small: one family at 10 and 100 files, both prompts, `baseline` and `code`, before the full matrix.
Real-repository refactoring benchmarks with TypeScript instances, such as CodeTaste and
[SWE-Bench ProMax](https://arxiv.org/abs/2608.09802), are candidates for a later external suite once the generated
suite shows an effect.

## Conditions

| Dimension     | Values   | Default |
| ------------- | -------- | ------- |
| `--sightread` | `off,on` | `off`   |

`on` provides the sightread CLI and skill, and advertises `graph.query` in shorthand; it also works with the `baseline` setup. Each attempt gets a separate runtime directory, and its servers are stopped when the attempt ends.
`off` runs against a frozen copy of the extension with no `sightread` package, as if it weren't installed:
`sightread` answers "command not found" (a stand-in placed first on `PATH`, so tools installed beside it stay
available), `graph.query` isn't advertised, and a program can't reach the graph or import the package.

| `--setups` value | Enabled tools                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `baseline`       | `read,bash,edit,write` (stock coding tools)                                               |
| `code`           | Stock tools plus `code`; measures optional adoption                                       |
| `replace`        | `read,bash,code`; replaces dedicated editing tools, retaining exploration/test facilities |
| `read-code`      | `read,code`; a separately constrained workflow                                            |

Shell writes remain possible in `baseline`, `code`, and `replace`. The report exposes shell commands for review;
it does not assume every shell call writes files or that all successful changes used shorthand.

`--documentation shipped|minimal` accepts a comma-separated list. `shipped` uses the normal tool description,
snippet and workflow guidelines. `minimal` wraps registration with an API-only description and no workflow
guidelines; it preserves implementation and parameter schema. It does not modify the shipped extension.

`--skills none|shorthand` also accepts a list. `shorthand` explicitly makes the existing skill available; it does
not force the model to read it. The baseline runs only when `--setups` includes `baseline`, and then once,
without shorthand documentation or skill.
Other conditions are the product of setup, revision, documentation, and skill choices. Their order rotates on
each repetition. With two conditions this alternates the order; a full cycle requires as many repetitions as
conditions. Keep the initial matrix small.

Every attempt has a fresh agent directory. Authentication and custom model definitions are copied from the
configured Pi agent directory, with private permissions, then removed at the end. OAuth refresh tokens are single-use, so an `auth.json` that Pi refreshed during an attempt is copied back, or every later attempt would fail to sign in. Ambient settings, system
prompt files, context files, skills, templates, and extensions are excluded. Explicit extensions and skills are
the only exceptions. Environment variables still supply credentials and provider configuration. Reasoning is
explicitly `high` by default. `--offline` disables Pi startup network operations, not model requests.

## Execute deliberately

For example, after deciding to spend on model calls:

```sh
bun e2e/suite.ts --execute --tasks status-options,shared-validation \
  --setups baseline,replace,code --runs 3 --budget-seconds 600 --budget-dollars 2
```

For your own prepared repository:

```sh
bun e2e/run.ts --repo /path/to/fixture --task "Implement the requested feature" \
  --setups baseline,replace,code --check "bun test" --runs 3
```

`--setup` remains available for a single setup. The fixture is recorded once per experiment, including dirty,
untracked and ignored files; every attempt starts from a copy. Fingerprints cover Git-visible files. A URL is
cloned once and a JavaScript package is prepared with `bun install`; use a prepared local repository to pin its
dependencies and revision precisely.

For extension revision comparisons, add `--baseline-extension <path>` and `--candidate-extension <path>`.
Extension source is copied to frozen paths before attempts begin. Its workspace packages (`shorthand-code`,
`sightread`, `pi-shorthand`) resolve to the frozen copy, including through `node_modules/.bin`, so editing the
source during an experiment doesn't change what runs; freezing fails if a nested dependency links back into the
source. Other installed dependencies are symlinked, so don't update them during an experiment. Attempts with
`--sightread off` use a separate frozen copy without `sightread`. Model, reasoning, prompt, task/category IDs, enabled tools, documentation,
skill choice, fixture fingerprint and extension identity are recorded in summaries.

For a controlled recovery comparison, add `--seed-messages <file.json>`. The file maps extension labels
(`baseline` and `candidate` in paired mode) to Pi message arrays containing the original task, relevant reads,
the failed tool call and its error. Seeds must end with a failed tool result and contain complete tool exchanges;
private reasoning blocks are rejected. `{{fixture}}` and `{{extension}}` in string values are replaced with each
attempt's paths. The runner saves the seed and its fingerprint, then asks Pi to “Continue with the task.”
The stock `baseline` setup cannot use seeds. Seeded runs measure recovery from a constructed context, excluding
the initial failure's execution time; keep them separate from whole-session completion measurements.

## Budgets and results

A result is verified only when Pi exits successfully, the independent check passes, and the time/spending
limits are not exceeded. Without `--check`, a run cannot be verified. The time budget includes verification and
artifact capture. `--budget-dollars` stops Pi when reported cumulative cost exceeds the limit and disqualifies
that attempt. Usage arrives at response boundaries, so this is **not a hard billing cap**: an in-flight response
can overshoot. Costs depend on Pi's provider/model estimates, not invoices.

`--results-dir` defaults to `e2e/results/`. Each attempt produces:

- Raw Pi JSONL events and stderr.
- A second JSONL timeline with harness observation timestamps.
- A Markdown session report with programs/commands, results, per-response cost, subsequent actions, and review notes.
- An artifact directory containing `final.patch`, changed-file before/after contents, and `changes.json`.
- A `run` record in `summary.jsonl`; each experiment adds aggregates by condition, including failed-attempt cost
  in cost per verified completion. Task/category fields support later grouping across the suite.

An attempt that the model provider ends with an error (for example, "Unable to verify model access") records
`providerError`. It measures nothing about the tools, so it's left out of completion, latency, tool counts and
drift and counted as `providerErrors`; its cost still counts, and its failed tool calls still count in
`failedToolCalls`.

Artifacts are captured **before** evaluator execution and relative to the recorded working tree, not HEAD.
The JSON manifest preserves binary content (base64), permissions and symlink targets, including deletions and
untracked additions. The patch is a readable content comparison; the manifest is authoritative for modes and
symlinks. Original fixture and extension temporary copies are removed after the experiment.

To review an older log:

```sh
bun e2e/report.ts e2e/results/example.jsonl
```

Review interface mistakes separately from failed application tests: a transaction rolling back a bad application
change is not necessarily tool misuse. Reports identify timeout/conflict/no-change observations but leave
ambiguous failure causes and shell writes for human annotation. Inspect matched tasks and a random sample;
tool-call counts alone are not a fluency score.

## Local validation

```sh
bun test e2e/test
npm run check
```

These commands do not call a model. Legacy real-model results and synthetic smoke results can coexist in an old
results directory; do not combine them blindly with new experiments. Use a fresh `--results-dir` for a study.

## Local reference edits and recovery

[reference-programs](reference-programs) holds human-authored ast-grep, `refactor` and source-text
programs, named `<task-id>-<approach>.ts.txt`; scale references run at 100 files. Run
`bun e2e/reference-edits.ts` (`--only` selects some) to execute them, or `bun e2e/replay-edit-errors.ts` to
replay two observed API failures and their corrections. Both use temporary repositories and the real overlay
backend, evaluate independently afterwards, and never call a model.
