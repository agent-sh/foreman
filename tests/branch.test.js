'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, issue } = require('./helpers');

const LOCAL = 'd'.repeat(40); const REMOTE = 'e'.repeat(40);
const markerOf = (i) => JSON.parse(/<!-- foreman:claim (\{.*?\}) -->/.exec(i.comments.at(-1).body)[1]);

test('claim and adopt: the branch defaults to the issue body\'s Branch: line, else foreman/N, and says why', () => {
  const t = setup({
    fixture: {
      issues: [
        issue(1, { body: 'Intro.\n\nBranch: `tower-crane/T108-reclaim`\n' }),
        issue(2, { body: 'Branch: tc/plain-name\n' }),
        issue(3, { body: 'No branch here.' }),
        issue(4, { body: 'Branch: `tc/given`' }),
        issue(5, { labels: ['status:review'], body: 'Branch: `tc/T99`' })
      ]
    }
  });
  const one = t.run(['claim', '1', '--agent', 'k-1', '--json']);
  assert.equal(one.code, 0, one.stderr);
  assert.deepEqual([one.json.branch, one.json.branch_source], ['tower-crane/T108-reclaim', 'the issue body\'s Branch: line']);
  assert.match(t.run(['claim', '1', '--agent', 'k-1']).stdout, /already claimed by k-1 on tower-crane\/T108-reclaim \(from the existing claim\)/);
  assert.match(t.run(['claim', '2', '--agent', 'k-2']).stdout, /claimed by k-2 on tc\/plain-name \(from the issue body's Branch: line\)/);
  const three = t.run(['claim', '3', '--agent', 'k-3', '--json']);
  assert.deepEqual([three.json.branch, three.json.branch_source], ['foreman/3', 'default foreman/N']);
  const four = t.run(['claim', '4', '--agent', 'k-4', '--branch', 'tc/override', '--json']);
  assert.deepEqual([four.json.branch, four.json.branch_source], ['tc/override', '--branch']);
  assert.equal(t.run(['adopt', '5', '--agent', 'k-5', '--status', 'review', '--json']).json.branch, 'tc/T99');
  const fx = t.fx();
  assert.deepEqual(fx.issues.map((i) => markerOf(i).branch), ['tower-crane/T108-reclaim', 'tc/plain-name', 'foreman/3', 'tc/override', 'tc/T99']);
});

test('claim and adopt: refuse a branch whose commits are only local, unless --allow-unpushed', () => {
  const t = setup({
    fixture: {
      issues: [issue(1, { body: 'Branch: `tc/T108`' }), issue(2, { body: 'Branch: `tc/T109`' }), issue(3, { labels: ['status:in-progress'], body: 'Branch: `tc/T110`' }), issue(4, { body: 'Branch: `tc/T111`' })],
      git: {
        local: { 'tc/T108': LOCAL, 'tc/T109': LOCAL, 'tc/T110': LOCAL, 'tc/T111': REMOTE },
        worktrees: [{ path: '/work/old-T108', branch: 'tc/T108', head: LOCAL }],
        unpushed: { [LOCAL]: 14 }, ahead: { [`${REMOTE}..${LOCAL}`]: 2 }
      },
      refs: { main: ['1'.repeat(40)], 'tc/T109': [REMOTE], 'tc/T111': [REMOTE] }
    }
  });
  const noRemote = t.run(['claim', '1', '--agent', 'k-1']);
  assert.equal(noRemote.code, 2);
  assert.match(noRemote.stderr, /unpushed work for tc\/T108 in \/work\/old-T108: push it first \(git -C \/work\/old-T108 push -u origin tc\/T108\)/);
  const ahead = t.run(['claim', '2', '--agent', 'k-2', '--json']);
  assert.equal(ahead.code, 2);
  assert.match(ahead.json.error, /unpushed work for tc\/T109 in local branch tc\/T109: push it first/);
  assert.equal(ahead.json.unpushed.count, 2, 'counted against the remote branch tip');
  assert.equal(t.run(['adopt', '3', '--agent', 'k-3']).code, 2);
  assert.deepEqual(t.fx().issues.map((i) => i.comments.length), [0, 0, 0, 0], 'nothing posted on a refusal');

  assert.equal(t.run(['claim', '4', '--agent', 'k-4']).code, 0, 'local equal to the remote is fine');
  const forced = t.run(['claim', '1', '--agent', 'k-1', '--allow-unpushed', '--json']);
  assert.equal(forced.code, 0, forced.stderr);
  const m = markerOf(t.fx().issues[0]);
  assert.deepEqual([m.allow_unpushed, m.unpushed], [true, 14]);
});
