'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, ago, SIGNED } = require('./helpers');

const HEAD = 'a'.repeat(40);
const bot = { login: 'revuto-review' };
const review = (id, oid, at) => ({ databaseId: id, author: bot, state: 'COMMENTED', body: `${SIGNED}\n\n---\n\nSummary.`, submittedAt: at, commit: { oid } });
const thread = (id, round, text, over = {}, replies = []) => ({
  isResolved: false, isOutdated: false, path: `f${id}.js`, line: id, originalLine: id,
  comments: [{ databaseId: id, author: bot, body: `${SIGNED}\n\n---\n\n${text}`, createdAt: ago(3), originalCommit: { oid: HEAD }, pullRequestReview: { databaseId: round } }, ...replies],
  ...over
});

function prWith(over) {
  return {
    number: 7, state: 'OPEN', headRefOid: HEAD, headCommittedDate: ago(4), comments: [],
    reviews: [review(1, 'b'.repeat(40), ago(5)), review(2, HEAD, ago(3)),
      // Not Revuto's: unsigned, or another author. Neither is a round.
      { databaseId: 3, author: bot, state: 'COMMENTED', body: 'unsigned', submittedAt: ago(2), commit: { oid: HEAD } },
      { databaseId: 4, author: { login: 'someone' }, state: 'COMMENTED', body: `${SIGNED} pasted`, submittedAt: ago(2), commit: { oid: HEAD } }],
    checkRuns: [{ app: 'revuto-review', name: 'revuto-review', status: 'COMPLETED', conclusion: 'FAILURE', title: 'Revuto found review concerns' }],
    reviewThreads: [
      thread(1, 1, '[P1] Off by one.', { isOutdated: true }),
      thread(2, 1, '[P2] Missing await.', {}, [{ databaseId: 21, author: { login: 'owner' }, body: 'Not reachable: the caller awaits.', createdAt: ago(2) }]),
      thread(3, 2, '[P3] Rename x.', { isResolved: true }),
      thread(4, 2, '[P3] Typo in the log line.'),
      thread(5, 2, 'No severity tag here.', {}, [{ databaseId: 51, author: bot, body: `${SIGNED} still open`, createdAt: ago(1) }]),
      { ...thread(6, 2, 'human thread'), comments: [{ databaseId: 6, author: { login: 'someone' }, body: 'nit', createdAt: ago(1), originalCommit: { oid: HEAD }, pullRequestReview: { databaseId: 4 } }] }
    ],
    ...over
  };
}

test('findings: severity, addressed by outdated, reply or resolve, unaddressed, rounds from signed reviews only', () => {
  const t = setup({ fixture: { prs: [prWith()] } });
  const r = t.run(['findings', '7', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const f = r.json;
  assert.equal(f.rounds, 2);
  assert.equal(f.capped, false);
  assert.equal(f.reviewed_head, true);
  assert.deepEqual(f.findings.map((x) => [x.id, x.round, x.severity, x.how]),
    [[1, 1, 'P1', 'outdated'], [2, 1, 'P2', 'reply'], [3, 2, 'P3', 'resolved'], [4, 2, 'P3', null], [5, 2, null, null]]);
  assert.equal(f.unaddressed, 2);
  assert.equal(f.lows_only_last_round, false, 'an unrated finding is not a low');
});

test('findings: capped by the cap check summary, by the final-review heading, or by rounds_max', () => {
  const capCheck = { app: 'revuto-review', name: 'revuto-review', status: 'COMPLETED', conclusion: 'FAILURE', title: 'Revuto did not review this pull request', summary: 'Reason: PR #7 reached the 3-round review limit (3 prior rounds).' };
  const a = setup({ fixture: { prs: [prWith({ checkRuns: [capCheck] })] } }).run(['findings', '7', '--json']).json;
  assert.equal(a.capped, true);
  assert.match(a.cap_reason, /reached the 3-round review limit/);

  const final = prWith();
  final.reviews.push({ ...review(9, HEAD, ago(1)), body: `${SIGNED}\n\n---\n\n**Revuto final review (round cap reached)**\n\nDone.` });
  assert.equal(setup({ fixture: { prs: [final] } }).run(['findings', '7', '--json']).json.capped, true);

  const byMax = setup({ config: { review: { rounds_max: 2 } }, fixture: { prs: [prWith()] } }).run(['findings', '7', '--json']).json;
  assert.equal(byMax.capped, true);
  assert.equal(byMax.cap_reason, '2 rounds used, rounds_max 2');
});

test('findings: unavailable on a failed review check or a long silence; pending while it runs', () => {
  const unreviewed = (checkRuns, headCommittedDate = ago(4)) => prWith({ checkRuns, headCommittedDate, headRefOid: 'c'.repeat(40) });
  const failed = setup({ fixture: { prs: [unreviewed([{ app: 'revuto-review', name: 'revuto-review', status: 'COMPLETED', conclusion: 'FAILURE', title: 'Revuto review failed' }])] } }).run(['findings', '7', '--json']).json;
  assert.deepEqual([failed.unavailable, failed.unavailable_reason], [true, 'Revuto review failed']);
  const silent = setup({ fixture: { prs: [unreviewed([])] } }).run(['findings', '7', '--json']).json;
  assert.match(silent.unavailable_reason, /no revuto-review check at ccccccc after 45 min/);
  const fresh = setup({ fixture: { prs: [unreviewed([], ago(0.1))] } }).run(['findings', '7', '--json']).json;
  assert.equal(fresh.unavailable, false);
  assert.match(fresh.pending, /has not started/);
  const running = setup({ fixture: { prs: [unreviewed([{ app: 'revuto-review', name: 'revuto-review', status: 'IN_PROGRESS' }])] } }).run(['findings', '7', '--json']).json;
  assert.match(running.pending, /review in progress/);
});

test('self-review and revuto-ask post their markers; self-review is refused while Revuto can still review', () => {
  const capped = prWith({ checkRuns: [{ app: 'revuto-review', name: 'revuto-review', status: 'COMPLETED', conclusion: 'FAILURE', title: 'x', summary: 'reached the 3-round review limit' }] });
  const t = setup({ fixture: { prs: [capped, { ...prWith(), number: 8 }] } });
  const body = path.join(t.dir, 'r.md');
  fs.writeFileSync(body, 'Read the diff.');
  assert.equal(t.run(['self-review', '8', '--findings', '1', '--fixed', '1', '--body', body]).code, 2);
  assert.equal(t.run(['self-review', '7', '--findings', '3', '--fixed', '2', '--body', body]).code, 0);
  assert.equal(t.run(['revuto-ask', '7']).code, 0);
  const comments = t.fx().prs[0].comments.map((c) => c.body.split('\n')[0]);
  assert.deepEqual(comments, ['<!-- foreman:self-review findings=3 fixed=2 -->', '<!-- foreman:revuto-ask -->']);
});

test('stats: PRs that hit the cap, self-reviews with their findings, and manual requests', () => {
  const me = { login: 'owner' };
  const t = setup({
    fixture: {
      prs: [
        { number: 1, updatedAt: ago(1), checkRuns: [{ app: 'revuto-review', name: 'revuto-review', status: 'COMPLETED', conclusion: 'FAILURE', title: 'Revuto did not review this pull request', summary: 'Reason: PR #1 reached the 3-round review limit (3 prior rounds).' }],
          comments: [{ author: me, body: '<!-- foreman:self-review findings=3 fixed=2 -->\nx', createdAt: ago(1) }, { author: me, body: '<!-- foreman:revuto-ask -->\nx', createdAt: ago(1) }] },
        { number: 2, updatedAt: ago(1), reviews: [{ author: bot, body: `${SIGNED}\n\n---\n\n**Revuto final review (round cap reached)**` }],
          comments: [{ author: me, body: '<!-- foreman:self-review findings=1 fixed=1 -->', createdAt: ago(2) }, { author: me, body: '<!-- foreman:self-review findings=5 fixed=5 -->', createdAt: ago(24 * 40) }] },
        { number: 3, updatedAt: ago(1), comments: [{ author: { login: 'someone' }, body: 'reached the 3-round review limit', createdAt: ago(1) }] }
      ]
    }
  });
  const all = t.run(['stats', '--json']).json;
  assert.deepEqual(all.capped_prs, [1, 2], 'a human quoting the cap text is not a cap');
  assert.deepEqual([all.self_reviews, all.self_review_findings, all.self_review_fixed, all.revuto_asks], [3, 9, 8, 1]);
  const recent = t.run(['stats', '--since', ago(24 * 7), '--json']).json;
  assert.deepEqual([recent.self_reviews, recent.self_review_findings, recent.findings_per_self_review], [2, 4, 2]);
});
