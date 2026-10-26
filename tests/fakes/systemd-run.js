#!/usr/bin/env node
'use strict';
// Fake systemd-run: run the unit's command in the foreground, marking the
// unit active in <fixture dir>/units/<unit> meanwhile. Like --collect, the
// unit is gone once it ends. Exits 0 once the command ran, whatever its exit
// code, as systemd-run does once the unit has started. Like systemd, it expands
// ${VAR} anywhere in an argument and reads "$$" as a literal "$".

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const withValue = new Set(['-E', '--setenv', '-p', '--property', '-u', '--unit', '--description']);
let unit = null;
let i = 0;
for (; i < argv.length && argv[i].startsWith('-'); i++) {
  const a = argv[i];
  if (a.startsWith('--unit=')) unit = a.slice(7);
  else if (withValue.has(a)) { if (a === '-u' || a === '--unit') unit = argv[i + 1]; i++; }
}
const cmd = argv.slice(i).map((a) => a.replace(/\$\$|\$\{(\w+)\}/g, (m, name) => (name ? process.env[name] || '' : '$')));
if (!unit || !cmd.length) { process.stderr.write(`fake systemd-run: unsupported call: ${argv.join(' ')}\n`); process.exit(3); }
const dir = path.join(path.dirname(process.env.FAKE_FIXTURE), 'units');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, unit), 'active');
const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
fs.rmSync(path.join(dir, unit), { force: true });
process.exit(r.error ? 1 : 0);
