'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, issue, ago, claimBody, SIGNED } = require('./helpers');

const HEAD = 'a'.repeat(40);
const M1 = '1'.repeat(40); const M2 = '2'.repeat(40); const M3 = '3'.repeat(40);

function prFixture(over = {}) {
  return {
    number: 7, title: 'Fix the widget', state: 'OPEN', headRefOid: HEAD, headRefName: 'foreman/20', baseRefName: 'main',
    mergeable: 'MERGEABLE', headCommittedDate: ago(3), comments: [],
    commits: [{ oid: HEAD, messageHeadline: 'Fix the widget', messageBody: 'Body line.\n\nCo-Authored-By: Someone <x@y>' }],
    checkRuns: [
      { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { app: 'revuto-review', name: 'revuto-review', status: 'COMPLETED', conclusion: 'SUCCESS', title: 'Revuto review passed' }
    ],
    reviews: [{ databaseId: 1, author: { login: 'revuto-review' }, state: 'APPROVED', body: `${SIGNED}\n\n---\n\nRevuto completed the review and found no evidence-backed concerns.`, submittedAt: ago(2), commit: { oid: HEAD } }],
    reviewThreads: [],
    ...over
  };
}

const finding = (over = {}) => ({
  isResolved: false, isOutdated: false, path: 'src/w.js', line: 12, originalLine: 12,
  comments: [{ databaseId: 50, author: { login: 'revuto-review' }, body: `${SIGNED}\n\n---\n\n[P1] The loop never exits.`, createdAt: ago(2), originalCommit: { oid: HEAD }, pullRequestReview: { databaseId: 1 } }],
  ...over
});

const CAPPED = { app: 'revuto-review', name: 'revuto-review', status: 'COMPLETED', conclusion: 'FAILURE', title: 'Revuto did not review this pull request', summary: 'Reason: PR #7 reached the 3-round review limit (3 prior rounds). This is not an approval.' };

function landSetup({ pr = {}, refs = [M1], config = {}, fixture = {} } = {}) {
  const t = setup({
    fixture: {
      issues: [issue(20, { labels: ['status:review'], assignees: ['owner'], comments: [{ createdAt: ago(5), body: claimBody('a1', 'foreman/20', ago(5)) }] })],
      prs: [prFixture(pr)], refs: { main: refs }, ...fixture
    },
    config: null
  });
  const cfg = { scratch: path.join(t.dir, 'scratch', '{issue}'), land: 'echo ran >> "$FOREMAN_RECEIPTS/runs"', ...config };
  fs.writeFileSync(path.join(t.dir, '.foreman.json'), JSON.stringify(cfg));
  t.runs = () => { try { return fs.readFileSync(path.join(t.dir, 'scratch', '20', 'evidence', 'land-aaaaaaa', 'runs'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  t.comment = (text) => { fs.writeFileSync(path.join(t.dir, 'comment.md'), text); return path.join(t.dir, 'comment.md'); };
  return t;
}

const land = (t, ...extra) => t.run(['land', '20', '--pr', '7', '--head', HEAD.slice(0, 7), ...extra]);

test('land: green head merges at the exact SHA with no attribution trailer, then closes the issue', () => {
  const t = landSetup();
  const r = land(t, '--comment-file', t.comment('Reviewed: no findings.'));
  assert.equal(r.code, 0, r.stderr);
  const fx = t.fx();
  assert.equal(fx.merged.pr, 7);
  assert.ok(fx.merged.args.includes('--match-head-commit') && fx.merged.args.includes(HEAD));
  assert.equal(fx.merged.subject, 'Fix the widget (#7)');
  assert.doesNotMatch(fx.merged.body, /co-authored-by/i);
  assert.equal(fx.prs[0].comments[0].body, 'Reviewed: no findings.');
  assert.equal(fx.issues[0].state, 'CLOSED');
  assert.deepEqual(fx.issues[0].labels, []);
  assert.match(fx.issues[0].comments.at(-1).body, /Landed by #7 as f00dfeed/);
  assert.equal(t.runs(), 1);
});

test('land: refuses a moved head, a cancelled check, a red check; waits on pending and on no checks', () => {
  const moved = landSetup();
  const r = moved.run(['land', '20', '--pr', '7', '--head', 'bbbbbbb']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /head is a{40}, not bbbbbbb/);

  const ci = (conclusion, status = 'COMPLETED') => landSetup({ pr: { checkRuns: [{ name: 'ci', status, conclusion }, prFixture().checkRuns[1]] } });
  for (const [t, code, want] of [
    [ci('CANCELLED'), 2, /ci=CANCELLED/], [ci('FAILURE'), 2, /ci=FAILURE/], [ci('', 'IN_PROGRESS'), 1, /pending: ci=IN_PROGRESS/],
    [landSetup({ pr: { checkRuns: [prFixture().checkRuns[1]] } }), 2, /no checks at aaaaaaa.*allow_no_checks/]
  ]) {
    const x = land(t);
    assert.equal(x.code, code, x.stderr);
    assert.match(x.stderr, want);
    assert.equal(t.fx().merged, undefined);
    assert.equal(t.runs(), 0);
  }
});

test('land: allow_no_checks lands a PR with zero checks on the land command and findings', () => {
  const t = landSetup({ config: { allow_no_checks: true }, pr: { checkRuns: [prFixture().checkRuns[1]] } });
  const r = land(t);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(t.runs(), 1);
  const red = landSetup({ config: { allow_no_checks: true }, pr: { checkRuns: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }, prFixture().checkRuns[1]] } });
  assert.equal(land(red).code, 2, 'a red check still refuses');
});

test('land: the squash body drops only attribution trailers and the Claude Code footer', () => {
  const t = landSetup({
    pr: {
      commits: [{
        oid: HEAD, messageHeadline: 'Regenerate the API docs',
        messageBody: [
          'Docs generated with gen-docs from the schema.', '',
          '\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)',
          'Generated with [Claude Code](https://claude.com/claude-code)',
          'Generated with Claude Code',
          '  co-authored-by: Someone <x@y>',
          'Co-Authored-By: Claude <noreply@anthropic.com>'
        ].join('\n')
      }]
    }
  });
  assert.equal(land(t).code, 0);
  assert.equal(t.fx().merged.body, 'Regenerate the API docs\n\nDocs generated with gen-docs from the schema.');
});

test('land: merge_admin adds --admin to the merge; the other guards still apply', () => {
  const plain = landSetup();
  assert.equal(land(plain).code, 0);
  assert.ok(!plain.fx().merged.args.includes('--admin'));
  const admin = landSetup({ config: { merge_admin: true } });
  assert.equal(land(admin).code, 0);
  assert.ok(admin.fx().merged.args.includes('--admin'));
  const guarded = landSetup({ config: { merge_admin: true }, pr: { reviewThreads: [finding()] } });
  assert.equal(land(guarded).code, 2);
  assert.equal(guarded.fx().merged, undefined);
});

test('land: an unaddressed Revuto finding refuses; a reply addresses it', () => {
  const t = landSetup({ pr: { reviewThreads: [finding()] } });
  const r = land(t);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /1 unaddressed revuto-review finding\(s\): P1 src\/w\.js:12/);
  assert.equal(t.fx().merged, undefined);

  const replied = finding();
  replied.comments.push({ databaseId: 51, author: { login: 'owner' }, body: 'Fixed in the loop guard.', createdAt: ago(1) });
  assert.equal(land(landSetup({ pr: { reviewThreads: [replied] } })).code, 0);
});

test('land: forbidden words in the review comment refuse before the land command runs', () => {
  const t = landSetup({ config: { comment_allowed: ['owner-workers'] } });
  const r = land(t, '--comment-file', t.comment('Checked by the Opus reviewer.\nowner-workers is fine.'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /line 1 "Opus"/);
  assert.doesNotMatch(r.stderr, /owner-workers/);
  assert.equal(t.runs(), 0);
  assert.equal(t.fx().prs[0].comments.length, 0);
  const allowed = landSetup({ config: { comment_allowed: ['owner-workers'] } });
  assert.equal(land(allowed, '--comment-file', allowed.comment('The owner-workers gauge is fixed.')).code, 0);
});

test('land: main moving during the check reruns it once, and twice refuses', () => {
  const once = landSetup({ refs: [M1, M2, M2] });
  assert.equal(land(once).code, 0);
  assert.equal(once.runs(), 2);

  const twice = landSetup({ refs: [M1, M2, M2, M3] });
  const r = land(twice);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /moved during the land check twice/);
  assert.equal(twice.runs(), 2);
  assert.equal(twice.fx().merged, undefined);
});

test('land: a failing land command and a head pushed during the check refuse', () => {
  const failing = landSetup({ config: { land: 'echo boom; exit 4' } });
  const r = land(failing);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /land command exit 4[\s\S]*boom/);

  const pushed = landSetup({ fixture: { headMovesTo: 'c'.repeat(40) } });
  const p = land(pushed);
  assert.equal(p.code, 2);
  assert.match(p.stderr, /head moved to c{40} during the land check/);
});

test('land --decided-by-session: refused unless Revuto is capped or unavailable and a self-review follows the head', () => {
  const open = landSetup({ pr: { reviewThreads: [finding()] } });
  const notCapped = land(open, '--decided-by-session');
  assert.equal(notCapped.code, 2);
  assert.match(notCapped.stderr, /allowed only when revuto-review is capped or unavailable/);

  const capped = landSetup({ pr: { reviewThreads: [finding()], checkRuns: [prFixture().checkRuns[0], CAPPED] } });
  const plain = land(capped);
  assert.equal(plain.code, 2);
  assert.match(plain.stderr, /capped .*self-review the diff and land with --decided-by-session/);
  const noMarker = land(capped, '--decided-by-session');
  assert.equal(noMarker.code, 2);
  assert.match(noMarker.stderr, /needs a self-review recorded/);

  fs.writeFileSync(path.join(capped.dir, 'review.md'), 'Read the full diff; fixed the loop guard.');
  const sr = capped.run(['self-review', '7', '--findings', '2', '--fixed', '2', '--body', path.join(capped.dir, 'review.md')]);
  assert.equal(sr.code, 0, sr.stderr);
  assert.match(capped.fx().prs[0].comments[0].body, /^<!-- foreman:self-review findings=2 fixed=2 -->/);
  const ok = land(capped, '--decided-by-session');
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(capped.fx().issues[0].comments.at(-1).body, /the session judged it from the land check and the diff/);

  // Capped with every finding addressed, but the head itself unreviewed: the session reviews it.
  const unreviewed = landSetup({
    pr: {
      reviewThreads: [finding({ isOutdated: true })], checkRuns: [prFixture().checkRuns[0], CAPPED],
      reviews: [{ ...prFixture().reviews[0], state: 'COMMENTED', commit: { oid: 'b'.repeat(40) } }]
    }
  });
  const u = land(unreviewed);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /capped .* aaaaaaa is unreviewed/);

  // A self-review older than the head's last push does not count.
  const old = landSetup({
    pr: {
      reviewThreads: [finding()], checkRuns: [prFixture().checkRuns[0], CAPPED], headCommittedDate: ago(1),
      comments: [{ author: { login: 'owner' }, body: '<!-- foreman:self-review findings=1 fixed=1 -->\nx', createdAt: ago(2) }]
    }
  });
  assert.equal(land(old, '--decided-by-session').code, 2);
});

test('land: after a round with real findings the next head waits for a round, unless --trivial', () => {
  const fixedThread = finding({ isOutdated: true });
  const prev = 'b'.repeat(40);
  const t = landSetup({
    pr: {
      reviewThreads: [fixedThread],
      reviews: [{ databaseId: 1, author: { login: 'revuto-review' }, state: 'COMMENTED', body: `${SIGNED}\n\n---\n\nOne concern.`, submittedAt: ago(4), commit: { oid: prev } }],
      checkRuns: [prFixture().checkRuns[0]], headCommittedDate: ago(0.1)
    }
  });
  const wait = land(t);
  assert.equal(wait.code, 1, wait.stderr);
  assert.match(wait.stderr, /has not started|had real findings/);
  assert.equal(land(t, '--trivial').code, 0);
});
