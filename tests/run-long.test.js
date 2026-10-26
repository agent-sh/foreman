'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const skip = process.platform === 'win32' && 'needs sh and systemd';

// The default long_runs template runs the systemd-run fake, which runs the
// unit in the foreground and drops it afterwards, as --collect does.
function start(t, unit, cmd) {
  const log = path.join(t.dir, 'logs', `${unit}.log`);
  const r = t.run(['run-long', '--unit', unit, '--log', log, '--', ...cmd]);
  assert.equal(r.code, 0, r.stderr);
  return { log, r };
}
const status = (t, unit, log, extra = []) => t.run(['run-long', '--status', '--unit', unit, '--log', log, ...extra]);

test('run-long: a failing command reports its exit code once the unit is gone', { skip }, () => {
  const t = setup();
  const log = path.join(t.dir, 'logs', 'u-fail.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(`${log}.rc`, '0\n'); // a stale success from an earlier run with this log
  const r = t.run(['run-long', '--unit', 'u-fail', '--log', log, '--', 'sh', '-c', 'echo partial; exit 3']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /systemctl/);
  assert.match(r.stdout, /run-long --status --unit u-fail --log /);
  assert.equal(fs.readFileSync(`${log}.rc`, 'utf8'), '3\n');
  assert.equal(fs.existsSync(`${log}.rc.tmp`), false);
  assert.equal(fs.readFileSync(log, 'utf8'), 'partial\n');
  const s = status(t, 'u-fail', log);
  assert.equal(s.code, 2, s.stdout + s.stderr);
  assert.match(s.stdout, /^u-fail: failed \(exit 3\)/);
  const j = status(t, 'u-fail', log, ['--json']);
  assert.equal(j.code, 2);
  assert.equal(j.json.state, 'failed');
  assert.equal(j.json.exit_code, 3);
});

test('run-long: a passing command reports 0', { skip }, () => {
  const t = setup();
  const { log } = start(t, 'u-ok', ['sh', '-c', 'echo fine']);
  const s = status(t, 'u-ok', log);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /^u-ok: success \(exit 0\)/);
});

test('run-long: a killed command reports its signal exit', { skip }, () => {
  const t = setup();
  // The command killed by a signal.
  const a = start(t, 'u-kill', ['sh', '-c', 'kill -KILL $$']);
  const s1 = status(t, 'u-kill', a.log);
  assert.equal(s1.code, 2, s1.stdout + s1.stderr);
  assert.match(s1.stdout, /failed \(exit 137, signal KILL\)/);
  // The wrapper itself sent SIGTERM, as systemctl stop does: the trap still records it.
  const b = start(t, 'u-term', ['sh', '-c', 'kill -TERM $PPID']);
  const s2 = status(t, 'u-term', b.log);
  assert.equal(s2.code, 2, s2.stdout + s2.stderr);
  assert.match(s2.stdout, /failed \(exit 143, signal TERM\)/);
});

test('run-long: a gone unit with no rc file is unknown, never success', { skip }, () => {
  const t = setup();
  const s = status(t, 'u-gone', path.join(t.dir, 'logs', 'u-gone.log'));
  assert.equal(s.code, 3, s.stdout + s.stderr);
  assert.match(s.stdout, /^u-gone: unknown \(unit gone, no exit code recorded\)/);
});

test('run-long: an active unit with no rc file is running', { skip }, () => {
  const t = setup();
  fs.mkdirSync(path.join(t.dir, 'units'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'units', 'u-run'), 'active');
  const s = status(t, 'u-run', path.join(t.dir, 'logs', 'u-run.log'));
  assert.equal(s.code, 1, s.stdout + s.stderr);
  assert.match(s.stdout, /^u-run: running/);
});

test('run-long: spaces, quotes and $(...) in the command stay literal', { skip }, () => {
  const t = setup();
  const log = path.join(t.dir, 'logs dir', "it's \"a\" $(x) $$ $& ${HOME}.log");
  const words = ['a b', "it's", '"dq"', '$(touch pwned1)', '`touch pwned2`', '${HOME}', '$$', "'; touch pwned3; '"];
  const r = t.run(['run-long', '--unit', 'u-q', '--log', log, '--', 'printf', '%s\\n', ...words]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(log, 'utf8'), `${words.join('\n')}\n`);
  for (const f of ['pwned1', 'pwned2', 'pwned3']) assert.equal(fs.existsSync(path.join(t.dir, f)), false, f);
  const s = status(t, 'u-q', log);
  assert.equal(s.code, 0, s.stdout + s.stderr);
});

test('run-long: the command and log survive quoting inside a custom long_runs template', { skip }, () => {
  // Stand-in for systemd-run: run the shell line in the foreground.
  const t = setup({ config: { long_runs: "UNIT={unit} sh -c '{cmd} > {log} 2>&1'" } });
  const log = path.join(t.dir, 'logs dir', "it's.log");
  const r = t.run(['run-long', '--unit', 'u1', '--log', log, '--', 'node', '-e', "console.log(\"it's $HOME\")"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(log, 'utf8'), "it's $HOME\n");
  assert.equal(fs.readFileSync(`${log}.rc`, 'utf8'), '0\n');
});
