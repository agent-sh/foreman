'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

test('doctor: reports missing labels, and --fix creates exactly those', () => {
  const t = setup({ fixture: { labels: ['status:ready', 'bug'] } });
  const r = t.run(['doctor']);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /\[ERROR\] labels: missing status:blocked, status:in-progress, status:rework, status:review, status:held, priority:urgent, decision/);

  const fixed = t.run(['doctor', '--fix']);
  assert.equal(fixed.code, 0, fixed.stdout);
  assert.match(fixed.stdout, /\[OK\] labels: created status:blocked/);
  assert.equal(t.fx().labels.length, 9);
  assert.match(t.run(['doctor']).stdout, /\[OK\] labels: all 8 exist/);
});

test('doctor: fails on gh auth and on a check command that does not resolve', () => {
  const t = setup({ fixture: { auth: false }, config: { check: 'node tools/missing.js', land: 'no-such-binary-xyz {issue}' } });
  const r = t.run(['doctor', '--json']);
  assert.equal(r.code, 2);
  const by = Object.fromEntries(r.json.checks.map((c) => [c.what, c]));
  assert.equal(by['gh auth'].level, 'ERROR');
  assert.match(by.check.msg, /tools\/missing\.js not found/);
  assert.match(by.land.msg, /no-such-binary-xyz not found on PATH/);
});
