# foreman

> GitHub issues as a task queue for native agents

foreman turns a repo's open issues into a work queue for one main Claude Code session and its worktree subagents. The session picks the next ready issue and claims it. A worktree worker implements it, and Revuto reviews the PR. foreman lands the PR at the exact head it checked.

There is no daemon and no state store. Labels, assignees and comments on GitHub are the state, so several sessions can share a queue. Every command reads GitHub live, and nothing is cached.

## How it differs from ship and gate-and-ship

[ship](https://github.com/agent-sh/ship) and gate-and-ship take one change from commit to merge. foreman runs a queue: which issue is next, who holds it, how many agents the host can take, and when a PR may land. It does not replace a repo's own check or merge script; it calls them.

## Install

Through the [agentsys](https://github.com/agent-sh/agentsys) marketplace:

```
/plugin marketplace add agent-sh/agentsys
/plugin install foreman@agentsys
```

Needs Node 22+, `gh` (logged in) and `git`. The skill waits with `waitfor`; `run-long` needs systemd user units (Linux).

## The loop

`/foreman` runs it. `skills/foreman/SKILL.md` has the exact steps.

1. `capacity`, then `pick`, then `claim`.
2. `brief N`, then one worktree subagent per issue, run in parallel up to `agents_max`.
3. On the worker's report, open the PR and move the issue to review.
4. `findings P`: fix every real finding. A lows-only round gets no new round. Title, doc and small clear fixes land with `--trivial`. When Revuto is capped or down, the session reviews the diff itself, records it with `self-review`, and lands with `--decided-by-session`.
5. `land`.

## CLI

`node scripts/foreman.js <command> [--json] [--repo OWNER/NAME] [--config FILE]`

| Command | What it does |
|---|---|
| `doctor [--fix]` | Checks node, gh auth, git, the repo, the config, the labels (`--fix` creates missing ones), the commands, and the attribution setting. |
| `pick` | The next ready issue: urgent first, then oldest. Skips held, decision, blocked and claimed issues, and any whose `Depends on` issues are open. Prints why, or why nothing is ready. |
| `claim N --agent ID --branch B` | Assigns, swaps ready for in-progress, and posts a claim comment. Idempotent for the same agent. Refuses a live claim by another agent; the first claim comment wins a race. |
| `release N --to ready\|rework\|held\|blocked\|review --reason R` | Moves the issue and comments why. Every target except review ends the claim. |
| `stale [--retake [--keep TAG]]` | Claims with no push and no comment for `stale_claim_hours`. `--retake` sends in-progress ones to ready and review ones to rework; `--keep TAG` spares agents named `TAG-*`. |
| `capacity [--local K]` | load1, CPU pressure (PSI), available memory, live claims plus K local agents. Exit 0 when a spawn may start, 1 when not. On a host without PSI the pressure gate is skipped and the output says so. |
| `brief N [--pr P]` | The worker brief: acceptance, issue body, why it came back, rules, report format. `--pr` adds the open findings. |
| `findings P` | Revuto's findings on the PR: severity, addressed or not, rounds used, capped, unavailable, pending. |
| `self-review P --findings N --fixed M --body FILE` | Records the session's own review when Revuto is capped or unavailable. |
| `revuto-ask P` | Posts a request for one more Revuto round and prints the operator command. |
| `land N --pr P --head SHA [--comment-file F] [--gate] [--trivial] [--decided-by-session]` | Gates, land command, comment, squash merge at SHA, issue close. `--gate` checks only. |
| `status [--local K]` | Counts by label, claims, quiet claims and capacity, from one `gh` call. |
| `stats [--since DATE]` | PRs that hit the Revuto cap, self-reviews and their findings, manual Revuto requests. |
| `run-long --unit U --log L -- CMD` | Starts CMD as a transient systemd user unit, so it outlives the session. |
| `scan [FILE\|-]` | Checks text against `comment_forbidden`. |

Exit codes: 0 done, 1 not now (nothing ready, no capacity, pending; `waitfor --until` keeps waiting), 2 refused by a rule, 3 error.

### Dependencies

`depends_pattern` finds the list on each matching line. Each part is one of:
- `#N` or `owner/repo#N`: satisfied when the issue is closed or the PR is merged.
- anything ending in `(done)`: satisfied.
- `none`: no dependency.
- anything else: unresolved. It blocks, because an unknown reference is never assumed done.

### land

1. Refuses unless the PR is open and its head is SHA.
2. Refuses unless every check at the head is green. A cancelled, failed or never-reported check is not green. Every name in `required_checks` must be among them. The review app's own check is judged by its findings instead. A PR with zero checks is refused unless `allow_no_checks` is true.
3. Refuses on a merge conflict, and on any unaddressed Revuto finding. A finding is addressed when its thread is resolved, outdated (a later commit changed those lines), or answered by someone other than Revuto.
4. After a round with real findings, the next head waits for a Revuto round, unless `--trivial`.
5. When Revuto is capped or unavailable, `--decided-by-session` replaces its review. land accepts it only with a self-review comment posted after the head commit.
6. Scans the landing comment before anything runs.
7. Runs the land command with its log under the scratch dir. If main moves meanwhile, it reruns the command once, then refuses.
8. Refuses if the head moved during the check.
9. Posts the comment, then runs `gh pr merge --squash --match-head-commit SHA` (plus `--admin` with `merge_admin`). The body is the PR's commit messages without Co-Authored-By trailers and the Claude Code "Generated with" footer. Other lines that say "generated with" stay.
10. Closes the issue with a comment naming the merge commit.

## Config: `.foreman.json`

Optional, in the repo root, version-controlled. Every key has a default. Unknown keys are refused, and errors name the key. See `.foreman.example.json`.

| Key | Default | Meaning |
|---|---|---|
| `labels` | `status:ready`, `status:blocked`, `status:in-progress`, `status:rework`, `status:review`, `status:held`, `priority:urgent`, `decision` | Label names for each role. |
| `depends_pattern` | `Depends on: (.*)` | Regex with one capture group for the dependency list. |
| `agents_max` | 6 | Live claims plus local agents. |
| `load_hold` | 20 | No spawn at load1 at or above this. |
| `cpu_pressure_hold` | 60 | No spawn at CPU pressure at or above this: the percent in `/proc/pressure/cpu` `some avg10`. Skipped on hosts without PSI. |
| `mem_min_gb` | 4 | No spawn below this much available memory. |
| `stale_claim_hours` | 6 | Idle hours before a claim is stale. |
| `scratch` | `~/.cache/{repo}/{issue}` | Per-issue scratch dir. Land logs go here, receipts under `evidence/`. |
| `check` | none | The worker's check command, named in the brief. |
| `land` | none | The land command. Placeholders: `{issue}`, `{pr}`, `{head}`, `{base}`, `{receipts}`, `{log}`. It also gets `FOREMAN_RECEIPTS`, `FOREMAN_ISSUE`, `FOREMAN_PR`, `FOREMAN_HEAD`. |
| `required_checks` | `[]` | Check names that must be reported and green. |
| `allow_no_checks` | false | When true, a PR with zero checks lands on the land command and findings alone. When false, land refuses it. |
| `merge_admin` | false | When true, land merges with `--admin`. Every other land guard still applies. |
| `review.app` | `revuto-review` | The review app's slug. |
| `review.rounds_max` | 3 | Rounds after which foreman treats the app as capped, even without its cap message. 3 matches Revuto's deployed cap; a repo may set 4. |
| `review.no_new_round_for_lows` | true | A lows-only round (P3 or LOW) needs no new round. |
| `review.trivial_merge` | `title`, `docs`, `small clear fix` | What `--trivial` covers. Shown in refusals. |
| `review.wait_minutes` | 45 | Minutes without a review check on a head before the app counts as unavailable. Revuto also polls every 30 minutes. |
| `comment_forbidden` | `worker\|claude\|fable\|opus\|worktree\|manager\|/home/` | Case-insensitive regex. Every comment foreman posts is scanned with it. |
| `comment_allowed` | `[]` | Phrases removed before the scan, such as a product name. |
| `long_runs` | `systemd-run --user --collect --same-dir -E PATH --unit={unit} sh -c '{cmd} > {log} 2>&1'` | `{cmd}` and `{log}` are escaped to sit inside single quotes. |

Environment: `FOREMAN_GH` and `FOREMAN_GIT` point at other binaries (a `.js` path runs under node). `FOREMAN_LOAD1`, `FOREMAN_CPU_PRESSURE` (a number, or `none` for no PSI) and `FOREMAN_MEM_GB` override the host numbers, for containers and tests.

## Tests

`npm test` runs `node --test`. `tests/fakes/` puts fake `gh` and `git` first on PATH. They serve and change a JSON fixture of issues, PRs, checks, reviews and refs, so no test touches GitHub.

## License

MIT
