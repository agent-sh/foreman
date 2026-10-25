'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, issue, ago } = require('./helpers');

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
