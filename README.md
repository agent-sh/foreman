# foreman

> GitHub issues as a task queue for native agents

foreman turns a repo's open issues into a work queue for one main Claude Code session and its worktree subagents. The session picks the next ready issue and claims it. A worktree worker implements it, and Revuto reviews the PR. foreman lands the PR at the exact head it checked, with a fast-forward push from the local git identity.

There is no daemon and no state store. Labels, assignees and comments on GitHub are the state, so several sessions can share a queue. Every command reads GitHub live, and nothing is cached.

## Scope

foreman runs a queue: which issue is next, who holds it, how many agents the host can take, and when a PR may land. It does not replace a repo's own check or merge script; it calls them.

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
| `pick` | The next ready issue: urgent first, then oldest. Skips held, decision, blocked and claimed issues, any whose `Depends on` issues are open, and any with an open PR (a closing reference from any repository, or an open PR from this repository on its last claim branch or `foreman/N`; one batched query). Prints why, or why nothing is ready. |
| `claim N --agent ID [--branch B] [--allow-unpushed]` | Assigns, swaps ready for in-progress, and posts a claim comment. The branch is `--branch`, else the issue body's `Branch:` line (`branch_pattern`), else `foreman/N`; the output names the source. Refuses when B's commits exist only locally: no remote branch, but a local branch or worktree holds it, or the local branch is ahead of the remote. The refusal prints the push command; `--allow-unpushed` overrides it and records that in the claim. Idempotent for the same agent. Refuses a live claim by another agent; the first claim comment wins a race. |
| `adopt N --agent ID [--branch B] [--status in-progress\|review] [--allow-unpushed]` | Claims an issue already in in-progress, review or rework that has no foreman claim (moved in from another queue, or started outside foreman). Same branch default and unpushed-work check as claim. Posts the claim marker, assigns, and sets the status (default in-progress). Idempotent for the same agent; refuses a live claim by another agent and a ready issue. |
| `release N --to ready\|rework\|held\|blocked\|review --reason R` | Moves the issue and comments why. Every target except review ends the claim. |
| `stale [--retake [--keep TAG]]` | Claims with no push and no comment for `stale_claim_hours`. `--retake` sends in-progress ones to ready and review ones to rework; `--keep TAG` spares agents named `TAG-*`. |
| `capacity [--local K]` | load1, CPU pressure (PSI), available memory, live claims plus K local agents. Exit 0 when a spawn may start, 1 when not. On a host without PSI the pressure gate is skipped and the output says so. |
| `brief N [--branch B] [--pr P]` | The worker brief: acceptance, issue body, why it came back, rules, report format. The branch is `--branch`, else the live claim's; with neither it refuses. `--pr` adds the open findings. |
| `findings P` | Revuto's findings on the PR: severity, addressed or not, rounds used, capped, unavailable, pending. |
| `self-review P --findings N --fixed M --body FILE` | Records the session's own review when Revuto is capped or unavailable. |
| `revuto-ask P` | Posts a request for one more Revuto round and prints the operator command. |
| `land N --pr P --head SHA [--comment-file F] [--gate] [--trivial] [--decided-by-session]` | Gates, land command, push of SHA or its squash to the base, comment, issue close. `--gate` checks only. |
| `status [--local K]` | Counts by label, claims, quiet claims and capacity, from one `gh` call. |
| `stats [--since DATE]` | PRs that hit the Revuto cap, self-reviews and their findings, manual Revuto requests. |
| `run-long --unit U --log L -- CMD` | Starts CMD as a transient systemd user unit, so it outlives the session. The unit runs CMD through a wrapper script (`L.run.sh`) whose EXIT trap writes CMD's exit code to `L.rc` (via `L.rc.tmp` and a rename), also when it fails or is stopped. Prints the `waitfor` line and the status command. |
| `run-long --status --unit U --log L` | Reads `L.rc`: exit 0 success, 1 running (no `L.rc` yet, unit active), 2 failed (prints the exit code and signal), 3 unknown (unit gone, no exit code recorded). Read the result here, never from systemctl: after `--collect` drops the unit, systemd reports success even for a failed command. |
| `scan [FILE\|-]` | Checks text against `comment_forbidden`. |

Exit codes: 0 done, 1 not now (nothing ready, no capacity, pending; `waitfor --until` keeps waiting), 2 refused by a rule, 3 error.

### Dependencies

`depends_pattern` finds the list on each matching line. Each part is one of:
- `#N` or `owner/repo#N`: satisfied when the issue is closed or the PR is merged. A PR that land closed after pushing its squash counts as merged when its last close comment from land (`Landed on BASE as SHA, a squash of HEAD.`) names the PR's base and its current head, was posted by the gh user running foreman (`gh api user`), and GitHub's compare shows SHA on that base. Any other closed PR blocks.
- anything ending in `(done)`: satisfied.
- `none`: no dependency.
- anything else: unresolved. It blocks, because an unknown reference is never assumed done.

### land

1. Refuses unless the PR is open and its head is SHA.
2. Refuses unless every check at the head is green. A cancelled, failed or never-reported check is not green. Every name in `required_checks` must be among them. The review app's own check is judged by its findings instead. A PR with zero checks is refused unless `allow_no_checks` is true.
3. Refuses on a merge conflict, and on any unaddressed Revuto finding. A finding is addressed when its thread is resolved, outdated (a later commit changed those lines), or answered by someone other than Revuto.
4. After a round with real findings, the next head waits for a Revuto round, unless `--trivial`.
5. When Revuto is capped or unavailable, `--decided-by-session` replaces its review. land accepts it only with a self-review comment posted after the head commit.
6. Scans the landing comment, the squash subject (the PR title) and the squash body before anything runs. A forbidden word refuses, naming the word and the PR title or the commit.
7. Runs the land command with its log under the scratch dir. If main moves meanwhile, it reruns the command once, then refuses.
8. Refuses if the head moved during the check.
9. Refuses unless every push URL of `origin` (`git remote get-url --push --all origin`) is this repo on github.com, since git pushes to `remote.origin.pushurl` when it is set. Only `https://github.com/O/R`, `git@github.com:O/R` and `ssh://git@github.com[:port]/O/R` count, each with an optional `.git`. Local paths, `file://`, other transports and other hosts refuse. Fetches the PR head (`refs/pull/P/head`) and the base into refs under `refs/foreman/`, with no checkout and no change to any branch or the working tree. In a shallow clone the fetch adds `--unshallow`, because the merge base may be missing. It refuses if the fetched head is not SHA. Then it lands one of two ways:
   - **fast-forward:** the PR is one non-merge commit whose parent is the base tip, its author and committer emails are the repo's `user.email`, and its whole message passes the `comment_forbidden` scan. land pushes SHA itself, and GitHub marks the PR merged. land reads the PR state once more if GitHub lags, and warns when it is still not merged.
   - **squash:** otherwise. `git merge-tree --write-tree` merges SHA into the base tip, and a merge conflict refuses with the conflicting files. `git commit-tree` makes one commit of that tree on the base tip. Author and committer come from the git config. The subject is the PR title with `(#P)`. The body is the messages of the PR's non-merge commits, without Co-Authored-By trailers and the Claude Code "Generated with" footer. Other lines that say "generated with" stay. A merge commit (more than one parent) is left out: its default message names the worker's checkout. After the push, land closes the PR with a comment naming the landed commit, since GitHub shows it closed, not merged.

   Before the push, land refuses if the PR head is no longer SHA. The push is a plain `git push origin SHA:refs/heads/BASE`, never forced. If it is rejected because the base moved, land exits 1: base moved; land again. The `refs/foreman/` refs are removed in every case. Needs git 2.38 or later.
10. Reads the PR head again after the push. A squash PR is closed only while its head is SHA, and the head is read again after the close. A fast-forward PR must show merged, or still have SHA as its head. If the head moved at any of these reads, the PR and the issue stay open, and land reopens the PR if it closed it: land posts a short note that the gated head landed and newer commits remain, and exits 2 naming both commits. Otherwise it posts the landing comment, then closes the issue with a comment naming the landed commit. `--json` output has `merge` (the landed commit), `method` (`fast-forward` or `squash`), `squash_reason`, `base` (the base tip it landed on) and `pr_state`.

## Config: `.foreman.json`

Optional, in the repo root, version-controlled. Every key has a default. Unknown keys are refused, and errors name the key. See `.foreman.example.json`.

| Key | Default | Meaning |
|---|---|---|
| `labels` | `status:ready`, `status:blocked`, `status:in-progress`, `status:rework`, `status:review`, `status:held`, `priority:urgent`, `decision` | Label names for each role. |
| `depends_pattern` | `Depends on: (.*)` | Regex with one capture group for the dependency list. |
| `branch_pattern` | ``^Branch:\s*`?([^`\s]+)`?`` | Regex with one capture group for the branch named in the issue body. claim and adopt default to it. |
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
| `review.app` | `revuto-review` | The review app's slug. |
| `review.rounds_max` | 3 | Rounds after which foreman treats the app as capped, even without its cap message. 3 matches Revuto's deployed cap; a repo may set 4. |
| `review.no_new_round_for_lows` | true | A lows-only round (P3 or LOW) needs no new round. |
| `review.trivial_merge` | `title`, `docs`, `small clear fix` | What `--trivial` covers. Shown in refusals. |
| `review.wait_minutes` | 45 | Minutes without a review check on a head before the app counts as unavailable. Revuto also polls every 30 minutes. |
| `comment_forbidden` | `worker\|claude\|fable\|opus\|worktree\|manager\|/home/` | Case-insensitive regex. Every comment foreman posts is scanned with it. |
| `comment_allowed` | `[]` | Phrases removed before the scan, such as a product name. A phrase matches across line breaks and any run of whitespace. |
| `long_runs` | `systemd-run --user --collect --same-dir -E PATH --unit={unit} sh -c '{cmd} > {log} 2>&1'` | `{cmd}` (the wrapper script) and `{log}` are escaped to sit inside single quotes. For a `systemd-run` template, `$` is doubled, since systemd expands variables on the unit's command line. |

Environment: `FOREMAN_GH` and `FOREMAN_GIT` point at other binaries (a `.js` path runs under node). `FOREMAN_LOAD1`, `FOREMAN_CPU_PRESSURE` (a number, or `none` for no PSI) and `FOREMAN_MEM_GB` override the host numbers, for containers and tests.

## Tests

`npm test` runs `node --test`. `tests/fakes/` puts fake `gh` and `git` first on PATH. They serve and change a JSON fixture of issues, PRs, checks, reviews and refs, so no test touches GitHub. The land push tests run real git against a local bare repo standing in for origin.

## License

MIT
