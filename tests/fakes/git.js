#!/usr/bin/env node
'use strict';
// Fake git: the repo root is the working directory, origin comes from the
// fixture, and ls-remote serves fixture.refs[branch] one value per call, so a
// test can move main while the land check runs.
//
// With fixture.git.real set, every call but `remote get-url` runs the real git
// in a real repo whose origin is a local bare repo. Before a push it can move
// the remote base (git.moveBaseBeforePush, git.moveBaseBeforeFetch), and after a push it marks a PR
// whose head reached a branch as merged, as GitHub does.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const file = process.env.FAKE_FIXTURE;
const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(fx, null, 2));

// `remote get-url --push --all` serves git.pushUrls when a test sets them.
if (argv[0] === 'remote' && argv[1] === 'get-url') {
  const push = argv.includes('--push') && fx.git && fx.git.pushUrls;
  process.stdout.write(`${(push || [`https://github.com/${fx.repo}.git`]).join('\n')}\n`); process.exit(0);
}

/** After a push, a PR head moves when git.headMovesAfterPush is { pr, to }: someone pushed to the PR meanwhile. */
function headMovesAfterPush() {
  const m = fx.git && fx.git.headMovesAfterPush;
  if (!m) return;
  const p = (fx.prs || []).find((x) => x.number === m.pr);
  if (p) p.headRefOid = m.to;
  delete fx.git.headMovesAfterPush;
}

/** A successful push of SHA to a branch merges every open PR whose head is SHA. */
function markMerged(sha) {
  if (fx.git && fx.git.noAutoMerge) return;
  for (const p of fx.prs || []) if (p.state === 'OPEN' && p.headRefOid === sha) p.state = 'MERGED';
}

if (fx.git && fx.git.real) {
  const fakes = path.resolve(__dirname, 'bin');
  const dirs = (process.env.PATH || '').split(path.delimiter).filter((d) => d && path.resolve(d) !== fakes);
  const exe = dirs.map((d) => path.join(d, 'git')).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  const real = (args, opts = {}) => spawnSync(exe, args, { encoding: 'utf8', ...opts });
  // Another session lands first: the remote base gains a commit just before this fetch or push.
  const hook = { fetch: 'moveBaseBeforeFetch', push: 'moveBaseBeforePush' }[argv[0]];
  if (hook && fx.git[hook]) {
    const { remote, branch } = fx.git[hook];
    delete fx.git[hook]; save();
    const tip = real(['rev-parse', `refs/heads/${branch}`], { cwd: remote }).stdout.trim();
    const moved = real(['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'Another landing'], { cwd: remote }).stdout.trim();
    real(['update-ref', `refs/heads/${branch}`, moved], { cwd: remote });
  }
  const input = ['commit-tree', 'hash-object'].includes(argv[0]) ? fs.readFileSync(0) : undefined;
  const r = real(argv, { input, encoding: 'buffer' });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  if (argv[0] === 'push' && r.status === 0) {
    headMovesAfterPush();
    markMerged(argv.at(-1).split(':')[0]);
    save();
  }
  process.exit(r.status === null ? 3 : r.status);
}

if (argv[0] === '--version') { process.stdout.write('git version 2.99.0 (fake)\n'); process.exit(0); }
if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') { process.stdout.write(`${process.cwd()}\n`); process.exit(0); }
if (argv[0] === 'ls-remote') {
  const branch = argv[2].replace('refs/heads/', '');
  const list = (fx.refs || {})[branch] || [];
  const sha = list.length > 1 ? list.shift() : list[0];
  fx.lsRemoteCalls = (fx.lsRemoteCalls || 0) + 1;
  save();
  if (sha) process.stdout.write(`${sha}\trefs/heads/${branch}\n`);
  process.exit(0);
}
const g = fx.git || {};

// Land plumbing on the fixture: fetch copies the remote base (refs[B][0]) and the PR
// head (pulls[N], else the PR's headRefOid) to local refs; merge-tree conflicts on
// git.conflicts; commit-tree records git.objects[sha]; push fast-forwards refs[B]
// when the commit's parent is the remote tip, and records fx.pushed.
const remoteTip = (b) => ((fx.refs || {})[b] || [])[0] || null;
const local = () => { fx.git = fx.git || {}; fx.git.refs = fx.git.refs || {}; fx.git.objects = fx.git.objects || {}; return fx.git; };
if (argv[0] === 'fetch') {
  const L = local();
  for (const spec of argv.filter((a) => a.startsWith('+refs/'))) {
    const [src, dst] = spec.slice(1).split(':');
    const pull = /^refs\/pull\/(\d+)\/head$/.exec(src);
    const sha = pull ? (fx.pulls || {})[pull[1]] || (fx.prs.find((p) => p.number === Number(pull[1])) || {}).headRefOid : remoteTip(src.replace('refs/heads/', ''));
    if (!sha) { process.stderr.write(`fatal: couldn't find remote ref ${src}\n`); process.exit(128); }
    L.refs[dst] = sha;
  }
  L.fetches = (L.fetches || 0) + 1;
  save(); process.exit(0);
}
if (argv[0] === 'rev-parse' && argv[1] === '--verify' && argv.at(-1).startsWith('refs/foreman/')) {
  const sha = (g.refs || {})[argv.at(-1)];
  if (sha) { process.stdout.write(`${sha}\n`); process.exit(0); }
  process.exit(128);
}
if (argv[0] === 'rev-parse' && argv[1] === '--is-shallow-repository') { process.stdout.write(`${g.shallow ? 'true' : 'false'}\n`); process.exit(0); }
if (argv[0] === 'update-ref' && argv[1] === '-d') { delete local().refs[argv[2]]; save(); process.exit(0); }
if (argv[0] === 'config' && argv[1] === 'user.email') {
  if (g.email) process.stdout.write(`${g.email}\n`);
  process.exit(g.email ? 0 : 1);
}
if (argv[0] === 'show' && argv[1] === '-s') {
  const o = (g.objects || {})[argv.at(-1)];
  if (!o) { process.stderr.write(`fatal: bad object ${argv.at(-1)}\n`); process.exit(128); }
  process.stdout.write([(o.parents || []).join(' '), o.ae || '', o.ce || '', o.message || ''].join('\0'));
  process.exit(0);
}
if (argv[0] === 'merge-tree') {
  const tree = 'e'.repeat(40);
  if (g.conflicts) { process.stdout.write(`${tree}\n${g.conflicts.join('\n')}\n`); process.exit(1); }
  process.stdout.write(`${tree}\n`); process.exit(0);
}
if (argv[0] === 'commit-tree') {
  const L = local();
  const sha = `c0${String(Object.keys(L.objects).length + 1).padStart(38, '0')}`;
  L.objects[sha] = { tree: argv[1], parents: [argv[argv.indexOf('-p') + 1]], message: fs.readFileSync(0, 'utf8') };
  save(); process.stdout.write(`${sha}\n`); process.exit(0);
}
if (argv[0] === 'push') {
  const [sha, dst] = argv.at(-1).split(':');
  const branch = dst.replace('refs/heads/', '');
  if (g.moveBaseBeforePush) { fx.refs[branch] = [g.moveBaseBeforePush]; delete g.moveBaseBeforePush; }
  const o = local().objects[sha] || {};
  if (!(o.parents || []).includes(remoteTip(branch))) {
    save(); process.stderr.write(` ! [rejected]        ${sha} -> ${branch} (fetch first)\n`); process.exit(1);
  }
  fx.refs[branch] = [sha];
  fx.pushed = { sha, branch, ...o };
  headMovesAfterPush();
  markMerged(sha);
  save(); process.exit(0);
}

if (argv[0] === 'rev-parse' && argv[1] === '--verify') {
  const sha = (g.local || {})[argv.at(-1).replace('refs/heads/', '')];
  if (sha) { process.stdout.write(`${sha}\n`); process.exit(0); }
  process.exit(1);
}
if (argv[0] === 'worktree' && argv[1] === 'list') {
  const main = `worktree ${process.cwd()}\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/main\n`;
  process.stdout.write([main, ...(g.worktrees || []).map((w) => `worktree ${w.path}\nHEAD ${w.head}\nbranch refs/heads/${w.branch}\n`)].join('\n'));
  process.exit(0);
}
if (argv[0] === 'rev-list' && argv[1] === '--count') {
  // rev-list --count REMOTE..LOCAL serves ahead["REMOTE..LOCAL"]; LOCAL --not --remotes serves unpushed[LOCAL].
  const n = argv[2].includes('..') ? (g.ahead || {})[argv[2]] : (g.unpushed || {})[argv[2]];
  process.stdout.write(`${n || 0}\n`);
  process.exit(0);
}
process.stderr.write(`fake git: unsupported call: ${argv.join(' ')}\n`);
process.exit(3);
