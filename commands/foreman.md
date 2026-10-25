---
description: Work this repo's GitHub issue queue with native subagents, from pick to land.
codex-description: 'Use when user asks to "work the queue", "run foreman", "pick the next issue", "land the ready PRs", "foreman status". Runs the foreman loop: capacity, pick, claim, worktree worker, Revuto findings, land.'
argument-hint: "[status|stats|ISSUE]"
allowed-tools: Bash(node:*), Bash(gh:*), Bash(git:*), Bash(waitfor:*), Read, Write, Edit, Agent, Task
---

# /foreman

Read `${CLAUDE_PLUGIN_ROOT}/skills/foreman/SKILL.md` and follow it literally.

Arguments (`$ARGUMENTS`):
- empty: run the loop until nothing is ready and no worker is running.
- `status`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.js" status` and report it. Change nothing.
- `stats`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.js" stats` and report it. Change nothing.
- an issue number: run the loop for that issue only. Skip `pick`, start at `claim`, and stop when it lands or is released.
