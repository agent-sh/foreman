#!/usr/bin/env node
'use strict';
// Fake systemctl: is-active reads <fixture dir>/units/<unit>, which the
// systemd-run fake or a test writes. A unit with no file is gone: like real
// systemctl it prints "inactive" and exits 3.

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2).filter((a) => a !== '--user');
if (argv[0] === 'is-active' && argv.length >= 2) {
  const quiet = argv.includes('-q') || argv.includes('--quiet');
  const unit = argv.filter((a) => !a.startsWith('-')).at(-1);
  let state = 'inactive';
  try { state = fs.readFileSync(path.join(path.dirname(process.env.FAKE_FIXTURE), 'units', unit), 'utf8').trim(); } catch { /* gone */ }
  if (!quiet) process.stdout.write(`${state}\n`);
  process.exit(state === 'active' ? 0 : 3);
}
process.stderr.write(`fake systemctl: unsupported call: ${process.argv.slice(2).join(' ')}\n`);
process.exit(3);
