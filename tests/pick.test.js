'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, issue, ago, claimBody } = require('./helpers');

test('pick: urgent first, then the oldest; never held, decision or claimed', () => {
  const t = setup({
    fixture: {
      issues: [
        issue(1, { createdAt: ago(50) }),
        issue(2, { createdAt: ago(10), labels: ['status:ready', 'priority:urgent'] }),
        issue(3, { createdAt: ago(5), labels: ['status:ready', 'priority:urgent'] }),
        issue(4, { createdAt: ago(90), labels: ['status:ready', 'status:held', 'priority:urgent'] }),
        issue(5, { createdAt: ago(90), labels: ['status:ready', 'decision', 'priority:urgent'] }),
        issue(6, { createdAt: ago(90), labels: ['status:ready', 'status:in-progress', 'priority:urgent'] })
      ]
    }
  });
  const r = t.run(['pick', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.picked.number, 2);
  assert.match(r.json.why, /^urgent, oldest of 2 urgent ready/);
  assert.deepEqual({ held: r.json.skipped.held, decision: r.json.skipped.decision, claimed: r.json.skipped.claimed }, { held: 1, decision: 1, claimed: 1 });

  const fx = t.fx();
  for (const i of fx.issues) i.labels = i.labels.filter((l) => l !== 'priority:urgent');
  require('node:fs').writeFileSync(`${t.dir}/fixture.json`, JSON.stringify(fx));
  assert.equal(t.run(['pick', '--json']).json.picked.number, 1);
});

test('pick: dependencies gate - open issue, unmerged PR and unknown reference block; closed, merged and "(done)" pass', () => {
  const t = setup({
    fixture: {
      issues: [
        issue(10, { createdAt: ago(80), body: 'Depends on: #11' }),
        issue(11, { labels: ['status:blocked'] }),
        issue(12, { createdAt: ago(20), body: 'x\nDepends on: #13, T5 (done)\n' }),
        issue(13, { state: 'CLOSED', labels: [] }),
        issue(14, { createdAt: ago(90), body: 'Depends on: T7' }),
        issue(15, { createdAt: ago(30), body: 'Depends on: #16' }),
        issue(17, { createdAt: ago(85), body: 'Depends on: #18' })
      ],
      prs: [{ number: 16, state: 'MERGED' }, { number: 18, state: 'CLOSED' }]
    }
  });
  const r = t.run(['pick', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.picked.number, 15);
  assert.equal(r.json.ready, 2);
  const waiting = Object.fromEntries(r.json.waiting.map((w) => [w.number, w.open || w.unresolved]));
  assert.deepEqual(waiting, { 10: ['#11'], 14: ['T7'], 17: ['#18'] });
});

test('pick: nothing ready exits 1 with counts by reason; rework issues are pickable', () => {
  const t = setup({ fixture: { issues: [issue(1, { labels: ['status:ready', 'status:held'] }), issue(2, { body: 'Depends on: #1' })] } });
  const r = t.run(['pick']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /nothing ready: 1 held, 1 waiting on dependencies/);

  const t2 = setup({ fixture: { issues: [issue(3, { labels: ['status:rework'] })] } });
  assert.equal(t2.run(['pick', '--json']).json.picked.number, 3);
});

test('pick: skips a ready issue with an open PR - closing reference, its claim branch, or foreman/N - in one query', () => {
  const t = setup({
    fixture: {
      issues: [
        issue(1, { createdAt: ago(90) }),
        issue(2, { createdAt: ago(80) }),
        issue(3, { createdAt: ago(70), comments: [
          { createdAt: ago(60), body: claimBody('a1', 'tc/t3', ago(60)) },
          { createdAt: ago(50), body: '<!-- foreman:release {"to":"ready"} -->\nMoved to status:ready: requeued' }
        ] }),
        issue(4, { createdAt: ago(60) }),
        issue(5, { createdAt: ago(10) })
      ],
      prs: [
        { number: 961, state: 'OPEN', headRefName: 'kv-078', closes: [1] },
        { number: 962, state: 'OPEN', headRefName: 'foreman/2' },
        { number: 963, state: 'OPEN', headRefName: 'tc/t3' },
        { number: 964, state: 'MERGED', headRefName: 'old', closes: [4] },
        { number: 965, state: 'CLOSED', headRefName: 'foreman/4' }
      ]
    }
  });
  const r = t.run(['pick', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.picked.number, 4);
  assert.equal(r.json.skipped.has_open_pr, 3);
  assert.deepEqual(r.json.linked.map((l) => [l.number, l.reason]), [[1, 'has open PR #961'], [2, 'has open PR #962'], [3, 'has open PR #963']]);
  assert.match(t.run(['pick']).stdout, /#1 has open PR #961/);
  const graphql = t.fx().calls.filter((c) => c.startsWith('api graphql'));
  assert.equal(graphql.length, 2, 'one batched query per pick, not one per issue');
});

test('pick: a fork PR on foreman/N or the claim branch does not link issue N; a same-repo one does, and a closing reference counts from a fork', () => {
  const t = setup({
    fixture: {
      issues: [
        issue(1, { createdAt: ago(90) }),
        issue(2, { createdAt: ago(80), comments: [
          { createdAt: ago(60), body: claimBody('a1', 'tc/t2', ago(60)) },
          { createdAt: ago(50), body: '<!-- foreman:release {"to":"ready"} -->\nMoved to status:ready: requeued' }
        ] }),
        issue(3, { createdAt: ago(70) }),
        issue(4, { createdAt: ago(60) }),
        issue(5, { createdAt: ago(50) })
      ],
      prs: [
        { number: 971, state: 'OPEN', headRefName: 'foreman/1', headRepository: 'stranger/widgets' },
        { number: 972, state: 'OPEN', headRefName: 'tc/t2', headRepository: 'stranger/widgets' },
        { number: 973, state: 'OPEN', headRefName: 'foreman/3', headRepository: null },
        { number: 974, state: 'OPEN', headRefName: 'foreman/4' },
        { number: 975, state: 'OPEN', headRefName: 'fix-5', headRepository: 'stranger/widgets', closes: [5] }
      ]
    }
  });
  const r = t.run(['pick', '--json']);
  assert.deepEqual(r.json.linked.map((l) => [l.number, l.reason]), [[4, 'has open PR #974'], [5, 'has open PR #975']]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.picked.number, 1);
  assert.equal(t.fx().calls.filter((c) => c.startsWith('api graphql')).length, 1, 'one batched query per pick, not one per issue');
});
