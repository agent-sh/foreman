'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, issue, ago, claimBody } = require('./helpers');

test('adopt: claims an in-progress, review or rework issue with no foreman claim, and sets the status', () => {
  const t = setup({
    fixture: {
      issues: [
        issue(1, { labels: ['status:in-progress', 'kind:code'] }),
        issue(2, { labels: ['status:in-progress'] }),
        issue(3, { labels: ['status:rework'] })
      ],
      labels: ['status:ready', 'status:blocked', 'status:in-progress', 'status:rework', 'status:review', 'status:held', 'priority:urgent', 'decision', 'kind:code']
    }
  });
  const r = t.run(['adopt', '1', '--agent', 'k3f9-1', '--branch', 'tc/t41', '--json']);
  assert.equal(r.code, 0, r.stderr);
  let [i1] = t.fx().issues;
  assert.deepEqual(i1.labels, ['status:in-progress', 'kind:code']);
  assert.deepEqual(i1.assignees, ['owner']);
  assert.equal(i1.comments.length, 1);
  assert.match(i1.comments[0].body, /<!-- foreman:claim \{"agent":"k3f9-1","branch":"tc\/t41",.*"adopted":true\} -->/);

  const again = t.run(['adopt', '1', '--agent', 'k3f9-1', '--branch', 'tc/t41', '--json']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.already, true);
  [i1] = t.fx().issues;
  assert.equal(i1.comments.length, 1, 'a repeat posts nothing');

  assert.equal(t.run(['adopt', '2', '--agent', 'k3f9-2', '--branch', 'foreman/2', '--status', 'review']).code, 0);
  assert.equal(t.run(['adopt', '3', '--agent', 'k3f9-3', '--branch', 'foreman/3']).code, 0);
  const [, i2, i3] = t.fx().issues;
  assert.deepEqual([i2.labels, i3.labels], [['status:review'], ['status:in-progress']]);

  // The adopted claim is a normal claim: brief and stale read its branch.
  assert.match(t.run(['brief', '1']).stdout, /HEAD:refs\/heads\/tc\/t41/);
});

test('adopt: refuses a live claim by another agent, a ready issue, a held issue and a bad --status', () => {
  const t = setup({
    fixture: {
      issues: [
        issue(1, { labels: ['status:in-progress'], comments: [{ createdAt: ago(1), body: claimBody('a1', 'foreman/1', ago(1)) }] }),
        issue(2),
        issue(3, { labels: ['status:in-progress', 'status:held'] })
      ]
    }
  });
  const other = t.run(['adopt', '1', '--agent', 'b2', '--branch', 'foreman/1']);
  assert.equal(other.code, 2);
  assert.match(other.stderr, /claimed by a1 on foreman\/1/);
  const ready = t.run(['adopt', '2', '--agent', 'b2', '--branch', 'foreman/2']);
  assert.equal(ready.code, 2);
  assert.match(ready.stderr, /is status:ready; use claim/);
  assert.equal(t.run(['adopt', '3', '--agent', 'b2', '--branch', 'foreman/3']).code, 2);
  assert.equal(t.run(['adopt', '1', '--agent', 'a1', '--branch', 'foreman/1', '--status', 'ready']).code, 3);
  assert.deepEqual(t.fx().issues.map((i) => i.comments.length), [1, 0, 0]);
});
