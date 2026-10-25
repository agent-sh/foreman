# foreman

> GitHub issues as a task queue for native agents

## Overview

An agentsys plugin. `scripts/foreman.js` holds every deterministic step of the queue in one file: plain CommonJS, Node 22+, no npm dependencies. The prompts are `skills/foreman/SKILL.md` and `commands/foreman.md`. GitHub is the only state, and the CLI never caches.

## Skills

- foreman

## Commands

- foreman

## Conventions

- Output is plain text, or JSON with `--json`. Refusals go to stderr as `[REFUSED]`, `[WAIT]` or `[ERROR]`. No emojis.
- Exit codes are a contract the skill and `waitfor` depend on: 0 done, 1 not now, 2 refused, 3 error.
- Talk to GitHub only through `gh`, with one call per kind of read. Never add a loop that polls.
- Every comment foreman posts goes through the `comment_forbidden` scan.
- A new `gh` or `git` call needs matching support in `tests/fakes/`. A behavior change needs a test that fails without it.
- SKILL.md names exact commands. When a CLI flag or exit code changes, update SKILL.md and README.md in the same change.
- In prose, write a spaced single dash (` - `), never an em dash.
- No Co-Authored-By trailers or "Generated with" lines in commits or PRs.
- Changes reach main through a PR.

## Dev commands

```bash
npm test                              # node --test tests/*.test.js
node scripts/foreman.js doctor        # against the repo in the current directory
agnix --config .agnix.toml .          # agent config lint
```

## References

- Part of the [agentsys](https://github.com/agent-sh/agentsys) ecosystem
