---
description: Work this repo's GitHub issue queue with native subagents, from pick to land.
codex-description: 'Use when user asks to "work the queue", "run foreman", "pick the next issue", "land the ready PRs", "foreman status". Runs the foreman loop: capacity, pick, claim, worktree worker, Revuto findings, land.'
argument-hint: "[status|stats|ISSUE]"
allowed-tools: Bash(node:*), Bash(gh:*), Bash(git:*), Bash(waitfor:*), Read, Write, Edit, Agent, Task
---

# /foreman

Read the skill at ${CLAUDE_PLUGIN_ROOT}/skills/foreman/SKILL.md and follow it literally. F below is node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.js".

## Arguments

Validate `$ARGUMENTS` first. It must be empty, `status`, `stats` or one issue number. For anything else, stop and say what is accepted.
- empty: run the loop until nothing is ready and no worker is running.
- `status`: run `F status` and report it. Change nothing.
- `stats`: run `F stats` and report it. Change nothing.
- an issue number: run the loop for that issue only. Skip `pick` and start at `claim`, or at `adopt` when it is already in progress with no foreman claim. Stop when it lands or is released.

## Report format

Plain text, no tables:
- each landed issue: `#N -> PR #P merged as <sha7>`
- each issue released, held or refused: `#N -> <status>: <reason>`
- the `F status` summary at the end, verbatim

### Example

```
#974 -> PR #961 merged as 4be21c0
#992 -> status:rework: check.py failed in test_reclaim (log in the brief's scratch dir)
#1002 -> status:held: needs the owner's call on the meta split
avifenesh/ginza: 41 open
  ready 30, blocked 2, in_progress 3, rework 1, review 2, held 3, urgent 6, decision 5
  claims: #997 #1000 #1003
  quiet 6 h+: none
  capacity: 3 slot(s), load1 6.2, mem 40.1 GB
```

## Verify

Before reporting, check that:
- every PR this run landed is merged at the head its gate passed, and its issue is closed
- `F status` lists no stale claims with this session's tag
