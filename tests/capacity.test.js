'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, issue } = require('./helpers');

test('capacity: claims plus local agents under agents_max, load1 under load_hold, memory above mem_min_gb', () => {
  const inProgress = [1, 2, 3].map((n) => issue(n, { labels: ['status:in-progress'] }));
  const t = setup({ fixture: { issues: [...inProgress, issue(4)] } });
  const cap = (local, load, mem) => t.run(['capacity', '--local', String(local), '--json'], { FOREMAN_LOAD1: String(load), FOREMAN_MEM_GB: String(mem) });

  const ok = cap(2, 19.9, 4.1);
  assert.equal(ok.code, 0, ok.stdout);
  assert.deepEqual([ok.json.claims, ok.json.agents, ok.json.slots, ok.json.may_spawn], [3, 5, 1, true]);

  const full = cap(3, 1, 32);
  assert.equal(full.code, 1);
  assert.match(full.json.holds[0], /6 agents running, max 6/);
  assert.equal(cap(0, 20, 32).code, 1, 'load1 at load_hold holds');
  assert.equal(cap(0, 1, 4).code, 1, 'memory at mem_min_gb holds');
});
