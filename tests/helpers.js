'use strict';
// Test harness: a scratch repo dir with a JSON fixture, and foreman run with
// fake gh and git first on PATH. Work dirs live under tests/.work, not /tmp.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'foreman.js');
const FAKES = path.join(__dirname, 'fakes');
const WORK = process.env.FOREMAN_TEST_DIR || path.join(__dirname, '.work');

const LABELS = ['status:ready', 'status:blocked', 'status:in-progress', 'status:rework', 'status:review', 'status:held', 'priority:urgent', 'decision'];
const SIGNED = '<!-- revuto-signed -->\n*This is an auto review done by [revuto](https://github.com/avifenesh/revuto).*';

let seq = 0;
const ago = (hours) => new Date(Date.now() - hours * 3600e3).toISOString();

function claimBody(agent, branch, at) {
  return `<!-- foreman:claim ${JSON.stringify({ agent, branch, at })} -->\nClaimed by ${agent}.`;
}

function issue(number, extra = {}) {
  return { number, title: `Issue ${number}`, state: 'OPEN', labels: ['status:ready'], assignees: [], body: '', createdAt: ago(100 - number), updatedAt: ago(1), comments: [], ...extra };
}

/** A repo dir with .foreman.json (when config is given) and a fixture. */
function setup({ fixture = {}, config } = {}) {
  const dir = path.join(WORK, `${process.pid}-${++seq}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const fx = { repo: 'acme/widgets', user: 'owner', labels: [...LABELS], issues: [], prs: [], branches: {}, refs: { main: ['1111111111111111111111111111111111111111'] }, ...fixture };
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(fx, null, 2));
  if (config) fs.writeFileSync(path.join(dir, '.foreman.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return {
    dir,
    fx: () => JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8')),
    run: (args, env = {}, input) => run(dir, args, env, input)
  };
}

function run(dir, args, env, input) {
  const e = {
    ...process.env,
    PATH: `${path.join(FAKES, 'bin')}${path.delimiter}${process.env.PATH}`,
    FAKE_FIXTURE: path.join(dir, 'fixture.json'),
    FOREMAN_LOAD1: '1', FOREMAN_MEM_GB: '32', FOREMAN_CPU_PRESSURE: '0',
    ...env
  };
  if (process.platform === 'win32') { e.FOREMAN_GH = path.join(FAKES, 'gh.js'); e.FOREMAN_GIT = path.join(FAKES, 'git.js'); }
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: e, encoding: 'utf8', input });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

module.exports = { setup, issue, ago, claimBody, SIGNED, LABELS, WORK };
