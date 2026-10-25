#!/usr/bin/env node
'use strict';
// Fake git: the repo root is the working directory, origin comes from the
// fixture, and ls-remote serves fixture.refs[branch] one value per call, so a
// test can move main while the land check runs.

const fs = require('node:fs');

const file = process.env.FAKE_FIXTURE;
const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(fx, null, 2));

if (argv[0] === '--version') { process.stdout.write('git version 2.99.0 (fake)\n'); process.exit(0); }
if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') { process.stdout.write(`${process.cwd()}\n`); process.exit(0); }
if (argv[0] === 'remote' && argv[1] === 'get-url') { process.stdout.write(`https://github.com/${fx.repo}.git\n`); process.exit(0); }
if (argv[0] === 'ls-remote') {
  const branch = argv[2].replace('refs/heads/', '');
  const list = (fx.refs || {})[branch] || [];
  const sha = list.length > 1 ? list.shift() : list[0];
  fx.lsRemoteCalls = (fx.lsRemoteCalls || 0) + 1;
  save();
  if (sha) process.stdout.write(`${sha}\trefs/heads/${branch}\n`);
  process.exit(0);
}
process.stderr.write(`fake git: unsupported call: ${argv.join(' ')}\n`);
process.exit(3);
