'use strict';
// land against real git: a local bare repo stands in for origin, so the pushed
// commit's parent, tree, message and identity are checked as git stores them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setup, issue, ago, claimBody, SIGNED } = require('./helpers');

const LANDER = { name: 'Lander', email: 'lander@example.com' };
const OTHER = { name: 'Other', email: 'other@example.com' };

function git(cwd, args, who) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  if (who) Object.assign(env, { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email });
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * origin (bare) with main at BASE holding a.txt and b.txt; the PR at
 * refs/pull/7/head. `pr` is a list of commits, each { files, who, message }, made
 * on BASE. `main` is an optional commit on main made after the PR branched.
 */
function realSetup({ pr = [{ files: { 'a.txt': 'a2\n' }, who: OTHER, message: 'Change a' }], main = null, config = {}, fixture = {}, shallow = false } = {}) {
  const t = setup({ config: null });
  const remote = path.join(t.dir, 'remote.git');
  const dev = path.join(t.dir, 'dev');
  git(t.dir, ['init', '--quiet', '--bare', '-b', 'main', remote]);
  git(t.dir, ['init', '--quiet', '-b', 'main', dev]);
  const commit = (files, who, message) => {
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dev, f), text);
    git(dev, ['add', '-A']);
    git(dev, ['commit', '--quiet', '-m', message], who);
    return git(dev, ['rev-parse', 'HEAD']);
  };
  const base = commit({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' }, OTHER, 'Base');
  let head = base;
  for (const c of pr) head = commit(c.files, c.who || OTHER, c.message || 'Change a');
  git(dev, ['update-ref', 'refs/pull/7/head', head]);
  let tip = base;
  if (main) { git(dev, ['checkout', '--quiet', '-b', 'trunk', base]); tip = commit(main, OTHER, 'Change on main'); }
  git(dev, ['push', '--quiet', remote, `${tip}:refs/heads/main`, 'refs/pull/7/head:refs/pull/7/head']);

  // The checkout foreman runs in: a clone with the lander's identity and untracked fixture files.
  git(t.dir, ['init', '--quiet', '-b', 'main']);
  git(t.dir, ['config', 'user.name', LANDER.name]);
  git(t.dir, ['config', 'user.email', LANDER.email]);
  // A shallow checkout holds only the base tip, so the merge base is missing until land deepens it.
  git(t.dir, ['remote', 'add', 'origin', shallow ? `file://${remote}` : remote]);
  git(t.dir, ['fetch', '--quiet', ...(shallow ? ['--depth', '1'] : []), 'origin', 'main']);
  git(t.dir, ['checkout', '--quiet', '-b', 'main', 'FETCH_HEAD']);

  const messages = pr.map((c) => (c.message || 'Change a').split('\n\n'));
  const fx = {
    repo: 'acme/widgets', user: 'owner', labels: [], branches: {}, refs: {},
    issues: [issue(20, { labels: ['status:review'], assignees: ['owner'], comments: [{ createdAt: ago(5), body: claimBody('a1', 'foreman/20', ago(5)) }] })],
    prs: [{
      number: 7, title: 'Fix the widget', state: 'OPEN', headRefOid: head, headRefName: 'foreman/20', baseRefName: 'main',
      mergeable: 'MERGEABLE', headCommittedDate: ago(3), comments: [],
      commits: messages.map(([h, ...b], i) => ({ oid: i === messages.length - 1 ? head : `${i}`.repeat(40), messageHeadline: h, messageBody: b.join('\n\n') })),
      checkRuns: [
        { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { app: 'revuto-review', name: 'revuto-review', status: 'COMPLETED', conclusion: 'SUCCESS', title: 'Revuto review passed' }
      ],
      reviews: [{ databaseId: 1, author: { login: 'revuto-review' }, state: 'APPROVED', body: `${SIGNED}\n\n---\n\nNo concerns.`, submittedAt: ago(2), commit: { oid: head } }],
      reviewThreads: []
    }],
    git: { real: true },
    ...fixture
  };
  fs.writeFileSync(path.join(t.dir, 'fixture.json'), JSON.stringify(fx, null, 2));
  fs.writeFileSync(path.join(t.dir, '.foreman.json'), JSON.stringify({ scratch: path.join(t.dir, 'scratch', '{issue}'), ...config }));
  const refsNow = () => git(t.dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes']);
  const before = { head: git(t.dir, ['rev-parse', 'HEAD']), status: git(t.dir, ['status', '--porcelain']), refs: refsNow() };
  return {
    ...t, remote, dev, base, head, tip,
    land: (...extra) => t.run(['land', '20', '--pr', '7', '--head', head.slice(0, 7), '--json', ...extra]),
    remoteMain: () => git(remote, ['rev-parse', 'refs/heads/main']),
    show: (fmt, rev) => git(remote, ['show', '-s', `--format=${fmt}`, rev]),
    file: (rev, f) => git(remote, ['show', `${rev}:${f}`]),
    foremanRefs: () => git(t.dir, ['for-each-ref', 'refs/foreman']),
    untouched: (pushed = false) => {
      assert.equal(git(t.dir, ['rev-parse', 'HEAD']), before.head, 'the checkout HEAD stays');
      assert.equal(git(t.dir, ['status', '--porcelain']), before.status, 'the working tree stays');
      // A successful push moves refs/remotes/origin/main to what it pushed; nothing else changes.
      const main = git(remote, ['rev-parse', 'refs/heads/main']);
      const want = before.refs.replace(/^(refs\/remotes\/origin\/main) \S+$/m, (line, ref) => (pushed ? `${ref} ${main}` : line));
      assert.equal(refsNow(), want, 'branches and remote-tracking refs stay');
    }
  };
}

test('land squash: a commit on the current base with the merged tree, the git config identity, then the PR closes', () => {
  const t = realSetup({ main: { 'b.txt': 'b2\n' } });
  const r = t.land('--comment', 'Reviewed: no findings.');
  assert.equal(r.code, 0, r.stderr);
  const sha = t.remoteMain();
  assert.equal(r.json.merge, sha);
  assert.equal(r.json.method, 'squash');
  assert.equal(r.json.squash_reason, 'not one commit on the base tip');
  assert.equal(t.show('%P', sha), t.tip, 'the parent is the base at land time');
  assert.equal(t.show('%T', sha), git(t.dir, ['merge-tree', '--write-tree', t.tip, t.head]), 'the tree is the merged tree');
  assert.equal(t.file(sha, 'a.txt'), 'a2');
  assert.equal(t.file(sha, 'b.txt'), 'b2');
  assert.equal(t.show('%an <%ae>|%cn <%ce>', sha), 'Lander <lander@example.com>|Lander <lander@example.com>');
  assert.equal(t.show('%B', sha), 'Fix the widget (#7)\n\nChange a');
  const fx = t.fx();
  assert.equal(fx.prs[0].state, 'CLOSED');
  assert.equal(fx.prs[0].comments[1].body, 'Reviewed: no findings.');
  assert.equal(fx.prs[0].comments[0].body, `Landed on main as ${sha}, a squash of ${t.head}.`);
  assert.equal(fx.issues[0].state, 'CLOSED');
  assert.match(fx.issues[0].comments.at(-1).body, new RegExp(`Landed by #7 as ${sha}\\.`));
  assert.equal(t.foremanRefs(), '');
  t.untouched(true);
});

test('land squash: a conflict with the base refuses and pushes nothing', () => {
  const t = realSetup({ main: { 'a.txt': 'a3\n' } });
  const r = t.land('--comment', 'Reviewed.');
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.json.error, new RegExp(`PR #7 conflicts with main at ${t.tip.slice(0, 7)}: a\\.txt`));
  assert.equal(t.remoteMain(), t.tip);
  const fx = t.fx();
  assert.equal(fx.prs[0].state, 'OPEN');
  assert.equal(fx.prs[0].comments.length, 0);
  assert.equal(fx.issues[0].state, 'OPEN');
  assert.equal(t.foremanRefs(), '');
  t.untouched();
});

test('land: the base moving between the fetch and the push is not now, and nothing is posted', () => {
  const t = realSetup({ main: { 'b.txt': 'b2\n' } });
  const fx0 = t.fx();
  fx0.git.moveBaseBeforePush = { remote: t.remote, branch: 'main' };
  fs.writeFileSync(path.join(t.dir, 'fixture.json'), JSON.stringify(fx0));
  const r = t.land('--comment', 'Reviewed.');
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.json.error, new RegExp(`main moved during the push \\(${t.tip.slice(0, 7)} -> [0-9a-f]{7}\\): base moved; land again`));
  assert.equal(t.show('%s', t.remoteMain()), 'Another landing', 'the other landing stays on main');
  const fx = t.fx();
  assert.equal(fx.prs[0].state, 'OPEN');
  assert.equal(fx.prs[0].comments.length, 0);
  assert.equal(fx.issues[0].state, 'OPEN');
  assert.equal(t.foremanRefs(), '');
  t.untouched();
});

test('land: a base that moved after the land check is not now, and nothing is pushed or posted', () => {
  const t = realSetup({ main: { 'b.txt': 'b2\n' }, config: { land: 'true' } });
  const fx0 = t.fx();
  fx0.git.moveBaseBeforeFetch = { remote: t.remote, branch: 'main' };
  fs.writeFileSync(path.join(t.dir, 'fixture.json'), JSON.stringify(fx0));
  const r = t.land('--comment', 'Reviewed.');
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.json.error, new RegExp(`main moved after the land check \\(${t.tip.slice(0, 7)} -> [0-9a-f]{7}\\): base moved; land again`));
  assert.equal(t.show('%s', t.remoteMain()), 'Another landing', 'only the other landing reached main');
  const fx = t.fx();
  assert.equal(fx.prs[0].state, 'OPEN');
  assert.equal(fx.prs[0].comments.length, 0);
  assert.equal(fx.issues[0].state, 'OPEN');
  assert.equal(t.foremanRefs(), '');
});

test('land: a head that moved after the gates or before the push refuses and pushes nothing', () => {
  const fetched = realSetup();
  const other = git(fetched.dev, ['commit-tree', `${fetched.head}^{tree}`, '-p', fetched.head, '-m', 'Later push'], OTHER);
  git(fetched.dev, ['push', '--quiet', '--force', fetched.remote, `${other}:refs/pull/7/head`]);
  const r = fetched.land();
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.json.error, new RegExp(`PR #7 head moved to ${other} after the gates`));
  assert.equal(fetched.remoteMain(), fetched.base);
  assert.equal(fetched.foremanRefs(), '');

  const later = 'c'.repeat(40);
  const pushed = realSetup({ fixture: { headMovesTo: later } });
  const p = pushed.land();
  assert.equal(p.code, 2, p.stderr);
  assert.match(p.json.error, new RegExp(`PR #7 head moved to ${later} before the push`));
  assert.equal(pushed.remoteMain(), pushed.base);
  assert.equal(pushed.fx().prs[0].state, 'OPEN');
  assert.equal(pushed.foremanRefs(), '');
  pushed.untouched();
});

test('land fast-forward: one commit by user.email on the base tip lands as the head itself, and the PR shows merged', () => {
  const t = realSetup({ pr: [{ files: { 'a.txt': 'a2\n' }, who: LANDER, message: 'Change a\n\nWhy it changes.' }] });
  const r = t.land('--comment', 'Reviewed: no findings.');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(t.remoteMain(), t.head, 'main is the PR head');
  assert.equal(r.json.method, 'fast-forward');
  assert.equal(r.json.merge, t.head);
  assert.equal(r.json.pr_state, 'MERGED');
  const fx = t.fx();
  assert.equal(fx.prs[0].state, 'MERGED');
  assert.ok(!fx.calls.some((c) => c.startsWith('pr close')), 'the PR is not closed by foreman');
  assert.equal(fx.prs[0].comments.length, 1, 'only the landing comment');
  assert.equal(fx.issues[0].state, 'CLOSED');
  assert.match(fx.issues[0].comments.at(-1).body, new RegExp(`Landed by #7 as ${t.head}\\.`));
  assert.equal(t.foremanRefs(), '');
  t.untouched(true);
});

test('land fast-forward falls back to squash: two commits, a stale parent, a foreign author, a forbidden trailer', () => {
  const cases = [
    [{ pr: [{ files: { 'a.txt': 'a2\n' }, who: LANDER }, { files: { 'a.txt': 'a3\n' }, who: LANDER, message: 'More a' }] }, 'not one commit on the base tip'],
    [{ pr: [{ files: { 'a.txt': 'a2\n' }, who: LANDER }], main: { 'b.txt': 'b2\n' } }, 'not one commit on the base tip'],
    [{ pr: [{ files: { 'a.txt': 'a2\n' }, who: OTHER }] }, 'author or committer is not user.email'],
    [{ pr: [{ files: { 'a.txt': 'a2\n' }, who: LANDER, message: 'Change a\n\nCo-Authored-By: Claude <bot@example.com>' }] }, 'its message has forbidden words']
  ];
  for (const [opts, why] of cases) {
    const t = realSetup(opts);
    const r = t.land();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.method, 'squash', why);
    assert.equal(r.json.squash_reason, why);
    const sha = t.remoteMain();
    assert.notEqual(sha, t.head);
    assert.equal(t.show('%P', sha), t.tip);
    assert.equal(t.show('%s', sha), 'Fix the widget (#7)');
    assert.equal(t.show('%ae|%ce', sha), 'lander@example.com|lander@example.com');
    assert.equal(t.fx().prs[0].state, 'CLOSED');
    t.untouched(true);
  }
});

test('land squash: a shallow checkout gets the history it needs and lands the merged tree', () => {
  const t = realSetup({ main: { 'b.txt': 'b2\n' }, shallow: true });
  assert.equal(git(t.dir, ['rev-parse', '--is-shallow-repository']), 'true');
  const r = t.land();
  assert.equal(r.code, 0, r.stderr || (r.json && r.json.error));
  const sha = t.remoteMain();
  assert.equal(r.json.method, 'squash');
  assert.equal(t.show('%P', sha), t.tip);
  assert.equal(t.file(sha, 'a.txt'), 'a2');
  assert.equal(t.file(sha, 'b.txt'), 'b2');
  assert.equal(git(t.dir, ['rev-parse', '--is-shallow-repository']), 'false');
  t.untouched(true);
});
