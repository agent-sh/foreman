'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, issue, ago, claimBody } = require('./helpers');

const claimed = (n, extraComments = []) => issue(n, {
  labels: ['status:in-progress'], assignees: ['owner'],
  comments: [{ createdAt: ago(10), body: claimBody(`t1-${n}`, `foreman/${n}`, ago(10)) }, ...extraComments]
});

test('stale: only claims with no push and no comment for stale_claim_hours; --retake releases them to ready', () => {
  const t = setup({
    fixture: {
      issues: [claimed(1), claimed(2), claimed(3, [{ createdAt: ago(2), body: 'still on it' }])],
      branches: { 'foreman/1': { date: ago(9) }, 'foreman/2': { date: ago(1) } }
    }
  });
  const r = t.run(['stale', '--json']);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json.stale, [1]);

  const kept = t.run(['stale', '--retake', '--keep', 't1', '--json']);
  assert.deepEqual(kept.json.retaken, [], '--keep spares the session\'s own agents');
  const re = t.run(['stale', '--retake', '--json']);
  assert.equal(re.code, 0, re.stderr);
  assert.deepEqual(re.json.retaken, [{ number: 1, to: 'status:ready' }]);
  const [i1, i2, i3] = t.fx().issues;
  assert.deepEqual(i1.labels, ['status:ready']);
  assert.deepEqual(i1.assignees, []);
  assert.match(i1.comments.at(-1).body, /foreman:release .*"retaken":"t1-1"/);
  assert.deepEqual([i2.labels, i3.labels], [['status:in-progress'], ['status:in-progress']]);

  const next = t.run(['claim', '1', '--agent', 'a9', '--branch', 'foreman/1']);
  assert.equal(next.code, 0, next.stderr);
});
