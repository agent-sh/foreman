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
  assert.equal(cap(0, 1, 4).code, 0, 'memory at mem_min_gb is not below it');
  assert.equal(cap(0, 1, 3.9).code, 1, 'memory below mem_min_gb holds');
});

test('capacity: CPU pressure at cpu_pressure_hold holds; without PSI that gate is skipped and says so', () => {
  const t = setup({ fixture: { issues: [] } });
  const cap = (psi, config) => t.run(['capacity', '--json'], { FOREMAN_CPU_PRESSURE: psi });
  const held = cap('60');
  assert.equal(held.code, 1);
  assert.deepEqual(held.json.holds, ['cpu pressure 60 >= 60']);
  const ok = cap('59.9');
  assert.equal(ok.code, 0);
  assert.deepEqual([ok.json.cpu_pressure, ok.json.cpu_pressure_hold, ok.json.cpu_pressure_gate], [59.9, 60, 'on']);
  const none = cap('none');
  assert.equal(none.code, 0);
  assert.equal(none.json.cpu_pressure, null);
  assert.match(none.json.cpu_pressure_gate, /skipped: no \/proc\/pressure\/cpu/);
  assert.match(t.run(['capacity'], { FOREMAN_CPU_PRESSURE: 'none' }).stdout, /cpu pressure skipped/);

  const custom = setup({ config: { cpu_pressure_hold: 30 }, fixture: { issues: [] } });
  assert.equal(custom.run(['capacity'], { FOREMAN_CPU_PRESSURE: '30' }).code, 1);
});
