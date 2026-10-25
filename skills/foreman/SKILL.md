---
name: foreman
description: "Use when working a repo's GitHub issue queue with native subagents: pick the next ready issue, claim it, spawn a worktree worker from its brief, read Revuto's findings, and land the PR. Driven by scripts/foreman.js; GitHub issues are the only state."
version: 0.1.0
argument-hint: "[status|stats|ISSUE]"
---

# foreman

The main session runs this loop. `scripts/foreman.js` does every deterministic step, and worktree subagents do the implementing. Review is Revuto's: never spawn a reviewer subagent.

`F` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.js"`. Run it from the repo root, and write it out in full inside `waitfor --until '...'`. Exit codes: 0 done, 1 not now, 2 refused (the message says why), 3 error. On exit 3, stop and report the message, so the tool gets fixed.

## Start
1. `F doctor`. If `[ERROR] labels`, run `F doctor --fix`. Any other `[ERROR]` stops the loop: report it.
2. Choose a session tag: 4 random hex digits. Agent IDs are `<tag>-<issue>`, for example `k3f9-992`.

## Loop
Repeat until `pick` exits 1 and no worker is running.
1. `F capacity`. On exit 1, do not spawn. Wait for a running worker's report, or run `waitfor --until 'F capacity' --every 2m --timeout 30m` in the background.
2. `F pick --json`. On exit 1, nothing is ready. If no worker is running, report the `skipped` counts and stop.
3. `F claim N --agent <tag>-N --branch foreman/N`. On exit 2, go back to step 2: the issue now counts as claimed. Stop after 3 refusals in a row.
4. `F brief N`. Spawn one Agent: `isolation: "worktree"`, `run_in_background: true`, and the prompt set to brief's stdout verbatim. Do not shorten it or add to it.
5. Go back to step 1 at once. Workers run in parallel. `capacity` counts every live claim, so all sessions together stay within `agents_max`.

Every hour of the loop, run `F stale --retake --keep <tag>`. It releases stale claims of other sessions and never your own.

## On a worker's report
- **Not pushed, check failed, or acceptance not met:** run `F release N --to rework --reason "<one line: what failed>"`. Then pick again.
- **Needs an owner decision:** run `F release N --to held --reason "<the question>"`.
- **Host-only steps** (user systemd bus, hardware, cloud CLIs): write them as exact commands to a file and run `F scan FILE`. Then post them with `gh issue comment N --body-file FILE`. The operator runs them and attaches the receipt paths.
- **Pushed, and the check passed:**
  1. Write the PR body: `Closes #N`, what changed, the check result. No attribution lines. Run `F scan FILE`.
  2. Open the PR: `gh pr create --head foreman/N --title "<issue title>" --body-file FILE`.
  3. Run `F release N --to review --reason "PR #P at <sha7>"`.
- **Follow-ups** in the report become new issues: `gh issue create --label status:ready --body-file FILE`, with a `Depends on: #N` line when they need this PR. They never go into the current PR.

## Review
Revuto reviews every push on its own. Its rounds are capped per PR (3 by default).
1. Wait for its round: `waitfor --until 'F land N --pr P --head SHA --gate' --every 3m --timeout 40m --fail-after 1`. Here SHA is the PR head. When waitfor fails, run the gate once without waitfor to read the refusal.
2. Read the round with `F findings P`. Then:
   - **Real finding** (P0-P2, or unrated): fix it. Run `F brief N --pr P` and spawn a worker as in Loop step 4, on the same branch. After the push, Revuto runs a new round. Go to step 1.
   - **Wrong finding:** reply in its thread with the reason. That marks it addressed. Run `F scan` on the text first, then post it with `gh api repos/OWNER/REPO/pulls/P/comments/ID/replies -f body="..."`.
   - **Lows-only round** (every finding P3 or LOW): fix them all and push. Land with no new round.
   - **Title, doc or small clear fix:** land with `--trivial`. No new round and no new tests.
3. **Revuto capped or unavailable** (`findings` shows `capped` or `unavailable`) while findings are open or the head is unreviewed. Do these in order:
   1. Read the whole diff yourself (`gh pr diff P`). Do not spawn a subagent for this.
   2. Fix what you find, and every open finding. Use a worker as above, or a direct commit on the branch. Push.
   3. Write what you checked and fixed to a file. Run `F self-review P --findings <found> --fixed <fixed> --body FILE`. Record it after the last push: land refuses a self-review older than the head.
   4. Optional: run `F revuto-ask P` to request one more round. Give the operator the command it prints, then wait as in step 1.
   5. Land with `--decided-by-session`.

## Land
1. Write the landing comment to `<scratch>/land-comment.md` (scratch is the path `brief` printed): what the PR does, the findings fixed or answered, the check result.
2. Run `F land N --pr P --head SHA --comment-file <scratch>/land-comment.md`, plus `--trivial` or `--decided-by-session` when step 2 or 3 of Review applies. Run it with `run_in_background: true` when the repo's land command takes minutes.
3. land runs the configured land command and reruns it once if main moves. Then it posts the comment, squash-merges at SHA and closes the issue. On exit 2:
   - **Head moved:** read `findings` again, then land with the new SHA.
   - **Check red:** run `F release N --to rework --reason "<check>: <failure>"`.
   - **Check cancelled:** rerun it once with `gh run rerun <run-id> --failed`. A cancelled check is never green.
   - **Unaddressed finding:** go to Review step 2.
   - **Forbidden words:** rewrite the comment.
   - **Main moved twice:** land again later.
   - **Land command failed:** read the log path it printed, then send the issue to rework.

## Rules
- GitHub is the only state. Keep no local queue, list or cache. Re-read with `F status`.
- Waits use `waitfor` with `--every 2m` or longer, because the GitHub quota is shared. Never write a sleep loop and never poll in a loop.
- Commands longer than 10 minutes go through `F run-long --unit U --log L -- CMD`. Never `nohup` or `&`.
- Commits, PRs and comments carry no Co-Authored-By trailer or "Generated with" line.
- Scope is frozen after the claim. Follow-ups are new issues.
- When the loop ends, run `F status` and report it.
