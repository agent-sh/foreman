'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, issue, ago, claimBody } = require('./helpers');

test('claim: assigns, swaps ready for in-progress, posts the claim; a repeat is a no-op', () => {
  const t = setup({ fixture: { issues: [issue(1)] } });
  const r = t.run(['claim', '1', '--agent', 'a1', '--branch', 'foreman/1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  let i = t.fx().issues[0];
  assert.deepEqual(i.labels, ['status:in-progress']);
  assert.deepEqual(i.assignees, ['owner']);
  assert.equal(i.comments.length, 1);
  assert.match(i.comments[0].body, /foreman:claim \{"agent":"a1","branch":"foreman\/1"/);

  const again = t.run(['claim', '1', '--agent', 'a1', '--branch', 'foreman/1', '--json']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.already, true);
  i = t.fx().issues[0];
  assert.equal(i.comments.length, 1);
});

test('claim: refuses a live claim by another agent, a second branch, a held issue and forbidden words', () => {
  const t = setup({
    fixture: {
      issues: [
        issue(1, { labels: ['status:in-progress'], comments: [{ createdAt: ago(1), body: claimBody('a1', 'foreman/1', ago(1)) }] }),
        issue(2, { labels: ['status:ready', 'status:held'] }),
        issue(3)
      ]
    }
  });
  const other = t.run(['claim', '1', '--agent', 'a2', '--branch', 'foreman/1b']);
  assert.equal(other.code, 2);
  assert.match(other.stderr, /claimed by a1 on foreman\/1/);
  assert.equal(t.run(['claim', '1', '--agent', 'a1', '--branch', 'other']).code, 2);
  assert.equal(t.run(['claim', '2', '--agent', 'a1', '--branch', 'foreman/2']).code, 2);
  const bad = t.run(['claim', '3', '--agent', 'a1', '--branch', 'worktree-agent-x']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /forbidden words/);
  assert.equal(t.fx().issues[2].comments.length, 0);
});

test('claim: the first claim comment wins a race', () => {
  const t = setup({ fixture: { issues: [issue(1)], raceClaim: { agent: 'b7', branch: 'foreman/1x' } } });
  const r = t.run(['claim', '1', '--agent', 'a1', '--branch', 'foreman/1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /lost the claim race to b7/);
});
