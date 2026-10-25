# Changelog

## [Unreleased]

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
