# Changelog

## [0.1.5] - 2026-10-26

### Fixed
- `comment_allowed` phrases match across line breaks and any run of whitespace, so an allowed phrase that a commit message wraps (for example "user\nmanager's control directory") no longer trips the forbidden-word scan. Line numbers in refusals still point at the original text.

## [0.1.4] - Unreleased

### Fixed

- `land` leaves merge commits (more than one parent) out of the squash body. A merge made in a worker's checkout defaults to "Merge remote-tracking branch 'origin/main' into worktree-agent-<id>", and that line reached main. The commits now come from one paginated GraphQL query that reads each commit's parent count, since `gh pr view --json commits` has none (#7).
- `land` scans the squash subject and body with `comment_forbidden` and `comment_allowed`, as it does the landing comment. A hit refuses with exit 2 and names the word and the PR title or the commit's SHA and headline. The scan runs in the gates, so `--gate` refuses too, and a refusal posts no comment and merges nothing (#7).

### Changed

- `brief` and the skill tell workers to name merges plainly: `git merge -m "Merge origin/main" origin/main` (#7).

## [0.1.3] - Unreleased

### Fixed

- `run-long` no longer reports a failed command as a success. The unit runs the command through a wrapper script whose EXIT trap writes the exit code to `LOG.rc` beside the log (to `LOG.rc.tmp`, then a rename), on success, failure, and HUP, INT or TERM. The new `run-long --status --unit U --log L` reads it: exit 0 success, 1 running, 2 failed with the exit code and signal, 3 unknown when the unit is gone and no exit code was recorded. The printed wait and result hints use it instead of `systemctl show`, which reports `Result=success` once `--collect` drops the unit. A start removes any stale `LOG.rc` (#5).
- `run-long` keeps `$` literal in the command and the log path. The command now lives in the wrapper script, off the unit's command line, and a `systemd-run` template gets `$` doubled, since systemd expands variables there. Template substitution no longer reads `$$` or `$&` in a path as a replacement pattern.

## [0.1.2] - Unreleased

### Changed

- The README no longer compares foreman with the retired ship and gate-and-ship plugins.

### Fixed

- `pick` counts an open PR on an issue's claim branch or `foreman/N` only when the PR's head is in this repository. Before, a fork PR whose head branch had the same name marked the issue as linked, and pick skipped it. A closing reference still counts from any repository. The batched query now also reads `headRepository` and `isCrossRepository`, and stays one query per pick (#2).

## [0.1.1] - 2026-10-26

### Added

- `adopt N --agent ID --branch B [--status in-progress|review]` claims an issue that is already in progress, in review or in rework with no foreman claim. Before, this took release to ready, claim, and release to review.

- `claim` and `adopt` take `--branch` as optional. The default is the issue body's `Branch:` line (new config `branch_pattern`), else `foreman/N`, and the output names the source.
- `claim` and `adopt` refuse a branch whose commits exist only on this machine. That means no remote branch but a local branch or worktree holds it, or a local branch ahead of the remote. The refusal names the worktree or branch and the push command. `--allow-unpushed` overrides it and records that in the claim marker. Before, a claim could start a new branch beside unpushed earlier work.

### Changed

- `pick` skips a ready issue that already has an open PR, and lists it under `linked` as "has open PR #P". The link is a closing reference, or an open PR on the issue's last claim branch or `foreman/N`. One batched GraphQL query covers all candidates. Before, pick could choose an issue whose PR was approved and in a land check.
- The foreman skill sets `disable-model-invocation: true`: the loop claims, comments and merges, so only an explicit `/foreman` starts it. Its description gains a "Use when user asks" trigger.
- `/foreman` validates its arguments, and states its report format, with an example, and what it checks before reporting.
- The land and doctor tests run their commands through node, not `sh` or `python3`, so they pass on Windows CI.
- `.agnix.toml` turns off CC-SK-017 (the `version` frontmatter field), as the other agent-sh plugins do. agnix and agentsys's enhance analyzers report no findings on the plugin.

## [0.1.0] - 2026-10-26

### Added

- `scripts/foreman.js`: one Node 22+ CLI with no npm dependencies. Commands: `doctor`, `pick`, `claim`, `release`, `stale`, `capacity`, `brief`, `findings`, `self-review`, `revuto-ask`, `land`, `status`, `stats`, `run-long` and `scan`. GitHub labels, assignees and comments are the only state.
- `land` carries Tower Crane's merge rules:
  - checks green at the exact head; a cancelled or missing check is not green
  - no unaddressed Revuto finding
  - squash with `--match-head-commit` and no attribution trailers
  - the land command reruns once when main moves
  - comment text is scanned for forbidden words
- Revuto review support:
  - `findings` reads severity, addressed state, rounds, cap and outage from Revuto's signed comments and its check run.
  - `self-review` and `revuto-ask` record the session's review and manual requests as comment markers.
  - `stats` counts them.
- `skills/foreman/SKILL.md` and `/foreman`: the loop a main session follows, with worktree workers and no reviewer subagent.
- `.foreman.example.json`, and tests that run against fake `gh` and `git`.
- Config `cpu_pressure_hold` (default 60). `capacity` holds at CPU pressure (PSI `some avg10`) at or above it, and skips that gate on hosts without PSI.
- Config `allow_no_checks` (default false). A PR with zero checks lands only when it is true. Otherwise land refuses it instead of waiting.
- Config `merge_admin` (default false). When true, land merges with `--admin`, and every other guard still applies.

### Changed

- `review.rounds_max` defaults to 3, Revuto's deployed cap.
- `capacity` holds only when memory is below `mem_min_gb`, not at it.

### Fixed

- The squash body keeps commit lines that say "generated with", such as "docs generated with gen-docs". Only Co-Authored-By trailers and the Claude Code footer are dropped.
