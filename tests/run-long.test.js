'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

test('run-long: the command and log survive quoting inside the long_runs template', { skip: process.platform === 'win32' && 'needs sh' }, () => {
  // Stand-in for systemd-run: run the shell line in the foreground.
  const t = setup({ config: { long_runs: "UNIT={unit} sh -c '{cmd} > {log} 2>&1'" } });
  const log = path.join(t.dir, 'logs dir', "it's.log");
  const r = t.run(['run-long', '--unit', 'u1', '--log', log, '--', 'node', '-e', "console.log(\"it's $HOME\")"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(log, 'utf8'), "it's $HOME\n");
});
