#!/usr/bin/env node
'use strict';
/**
 * foreman - GitHub issues as a task queue for native agents.
 *
 * The deterministic half of the foreman loop: pick, claim, stale, release,
 * capacity, brief, findings, self-review, revuto-ask, land, status, stats,
 * run-long, doctor and scan.
 * GitHub is the only state: labels, assignees and comments. No cache, no daemon,
 * so every command reads GitHub live.
 *
 * Node 22+, no npm dependencies. Talks to GitHub through `gh` and to the repo
 * through `git`. FOREMAN_GH and FOREMAN_GIT override the binaries (a .js path
 * runs under this node).
 *
 * Exit codes: 0 done or yes, 1 not now (nothing ready, no capacity, pending),
 * 2 refused by a rule, 3 error (usage, config, gh or git failure).
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXIT = { OK: 0, NOT_NOW: 1, REFUSED: 2, ERROR: 3 };

class Refusal extends Error {
  constructor(message, code = EXIT.REFUSED, data = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------- config

const DEFAULTS = Object.freeze({
  labels: {
    ready: 'status:ready', blocked: 'status:blocked', in_progress: 'status:in-progress',
    rework: 'status:rework', review: 'status:review', held: 'status:held',
    urgent: 'priority:urgent', decision: 'decision'
  },
  depends_pattern: 'Depends on: (.*)',
  agents_max: 6,
  load_hold: 20,
  mem_min_gb: 4,
  stale_claim_hours: 6,
  scratch: '~/.cache/{repo}/{issue}',
  check: null,
  land: null,
  required_checks: [],
  review: {
    app: 'revuto-review', rounds_max: 4, no_new_round_for_lows: true,
    trivial_merge: ['title', 'docs', 'small clear fix'],
    // Revuto polls every 30 minutes besides its webhook, so a head with no
    // review check after 45 minutes is taken as unavailable.
    wait_minutes: 45
  },
  comment_forbidden: 'worker|claude|fable|opus|worktree|manager|/home/',
  comment_allowed: [],
  // --same-dir keeps the repo as the working directory; -E PATH carries the
  // caller's PATH, since a user unit starts with the manager's minimal one.
  long_runs: "systemd-run --user --collect --same-dir -E PATH --unit={unit} sh -c '{cmd} > {log} 2>&1'"
});

const LABEL_COLORS = {
  ready: '0E8A16', blocked: 'B60205', in_progress: '1D76DB', rework: 'D93F0B',
  review: '5319E7', held: 'FBCA04', urgent: 'B60205', decision: 'C5DEF5'
};

const LABEL_DESCRIPTIONS = {
  ready: 'foreman: ready to pick', blocked: 'foreman: waiting on something outside the queue',
  in_progress: 'foreman: claimed by an agent', rework: 'foreman: needs another pass',
  review: 'foreman: PR open, under review', held: 'foreman: held by the owner or manager',
  urgent: 'foreman: picked first', decision: 'foreman: needs an owner decision, never picked'
};

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Validate a parsed config object and merge it over the defaults.
 * Every error names the key. Unknown keys are refused.
 */
function validateConfig(raw, source = '.foreman.json') {
  const errors = [];
  const err = (key, msg) => errors.push(`${source}: ${key} ${msg}`);
  if (!isObj(raw)) throw new Refusal(`${source}: must be a JSON object`, EXIT.ERROR);

  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULTS)) err(key, 'is not a foreman key');
  }
  const out = JSON.parse(JSON.stringify(DEFAULTS));

  const nested = (key, check) => {
    if (!(key in raw)) return;
    if (!isObj(raw[key])) return err(key, 'must be an object');
    for (const [k, v] of Object.entries(raw[key])) {
      if (!(k in DEFAULTS[key])) { err(`${key}.${k}`, 'is not a foreman key'); continue; }
      const msg = check(k, v);
      if (msg) err(`${key}.${k}`, msg); else out[key][k] = v;
    }
  };
  nested('labels', (k, v) => (typeof v === 'string' && v.trim() ? null : 'must be a non-empty string'));
  nested('review', (k, v) => {
    if (k === 'app') return typeof v === 'string' && /^[\w.-]+$/.test(v) ? null : 'must be a GitHub app slug';
    if (k === 'rounds_max') return Number.isInteger(v) && v >= 1 ? null : 'must be an integer >= 1';
    if (k === 'no_new_round_for_lows') return typeof v === 'boolean' ? null : 'must be true or false';
    if (k === 'wait_minutes') return typeof v === 'number' && v > 0 ? null : 'must be a number > 0';
    return Array.isArray(v) && v.every((s) => typeof s === 'string') ? null : 'must be a list of strings';
  });

  const num = (key, test, msg) => {
    if (!(key in raw)) return;
    if (typeof raw[key] !== 'number' || !test(raw[key])) err(key, `${msg} (got ${JSON.stringify(raw[key])})`);
    else out[key] = raw[key];
  };
  num('agents_max', (v) => Number.isInteger(v) && v >= 1, 'must be an integer >= 1');
  num('load_hold', (v) => v > 0, 'must be a number > 0');
  num('mem_min_gb', (v) => v >= 0, 'must be a number >= 0');
  num('stale_claim_hours', (v) => v > 0, 'must be a number > 0');

  const str = (key, nullable, extra) => {
    if (!(key in raw)) return;
    const v = raw[key];
    if (v === null && nullable) { out[key] = null; return; }
    if (typeof v !== 'string' || !v.trim()) return err(key, nullable ? 'must be a string or null' : 'must be a non-empty string');
    const msg = extra && extra(v);
    if (msg) return err(key, msg);
    out[key] = v;
  };
  const regex = (groups) => (v) => {
    let re;
    try { re = new RegExp(v); } catch (e) { return `is not a valid regex: ${e.message}`; }
    if (groups && new RegExp(`${re.source}|`).exec('').length - 1 < 1) return 'needs one capture group for the dependency list';
    return null;
  };
  str('depends_pattern', false, regex(true));
  str('comment_forbidden', false, regex(false));
  str('scratch', false, (v) => (v.includes('{issue}') ? null : 'must contain {issue}'));
  str('check', true);
  str('land', true);
  str('long_runs', false, (v) => (['{unit}', '{cmd}', '{log}'].every((p) => v.includes(p)) ? null : 'must contain {unit}, {cmd} and {log}'));

  for (const key of ['comment_allowed', 'required_checks']) {
    if (!(key in raw)) continue;
    if (!Array.isArray(raw[key]) || !raw[key].every((s) => typeof s === 'string' && s)) err(key, 'must be a list of non-empty strings');
    else out[key] = raw[key];
  }
  if (errors.length) throw new Refusal(errors.join('\n'), EXIT.ERROR);
  return out;
}

function loadConfig(root, explicit) {
  const file = explicit ? path.resolve(explicit) : path.join(root, '.foreman.json');
  if (!fs.existsSync(file)) {
    if (explicit) throw new Refusal(`config not found: ${file}`, EXIT.ERROR);
    return { config: validateConfig({}), file: null };
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new Refusal(`${path.basename(file)}: not valid JSON: ${e.message}`, EXIT.ERROR);
  }
  return { config: validateConfig(raw, path.basename(file)), file };
}

// ---------------------------------------------------------------- processes

function resolveBin(name) {
  const override = process.env[`FOREMAN_${name.toUpperCase()}`];
  if (!override) return { cmd: name, pre: [] };
  if (override.endsWith('.js')) return { cmd: process.execPath, pre: [override] };
  return { cmd: override, pre: [] };
}

function run(name, args, { input, cwd, allowFail = false } = {}) {
  const { cmd, pre } = resolveBin(name);
  const r = spawnSync(cmd, [...pre, ...args], {
    encoding: 'utf8', input, cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true
  });
  if (r.error) {
    if (allowFail) return { status: 127, stdout: '', stderr: r.error.message };
    throw new Refusal(`${name} could not run: ${r.error.message}`, EXIT.ERROR);
  }
  if (r.status !== 0 && !allowFail) {
    const why = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ');
    throw new Refusal(`${name} ${args.slice(0, 2).join(' ')} failed (exit ${r.status}): ${why}`, EXIT.ERROR);
  }
  return r;
}

const gh = (args, opts) => run('gh', args, opts).stdout;
const ghJson = (args, opts) => JSON.parse(gh(args, opts) || 'null');
const git = (args, opts) => run('git', args, opts).stdout.trim();

function which(cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/** POSIX single-quote a word when it has anything outside a safe set. */
function shQuote(s) {
  s = String(s);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function runShell(command, { cwd, logFile, env } = {}) {
  const fd = logFile ? fs.openSync(logFile, 'w') : 'inherit';
  const stdio = ['ignore', fd, fd];
  const opts = { cwd, stdio, env: { ...process.env, ...env }, windowsHide: true };
  const r = process.platform === 'win32'
    ? spawnSync(command, { ...opts, shell: true })
    : spawnSync('sh', ['-c', command], opts);
  if (typeof fd === 'number') fs.closeSync(fd);
  return r.error ? 127 : r.status;
}

// ---------------------------------------------------------------- context

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseRemote(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function context(opts) {
  const top = run('git', ['rev-parse', '--show-toplevel'], { allowFail: true });
  const root = top.status === 0 ? top.stdout.trim() : process.cwd();
  const { config, file } = loadConfig(root, opts.config);
  let repo = opts.repo || null;
  if (!repo) {
    const r = run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFail: true });
    if (r.status === 0) repo = parseRemote(r.stdout);
  }
  if (!repo) repo = ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Refusal(`not a GitHub repo name: ${repo}`, EXIT.ERROR);
  const [owner, name] = repo.split('/');
  return { root, config, configFile: file, repo, owner, name, R: ['-R', repo] };
}

function scratchDir(ctx, issue) {
  return expandHome(ctx.config.scratch.replaceAll('{repo}', ctx.name).replaceAll('{issue}', String(issue)));
}

// ---------------------------------------------------------------- comment markers

const MARK = /<!-- foreman:(claim|release) (\{.*?\}) -->/;

function marker(kind, data) { return `<!-- foreman:${kind} ${JSON.stringify(data)} -->`; }

function events(comments) {
  const out = [];
  for (const c of comments || []) {
    const m = MARK.exec(c.body || '');
    if (!m) continue;
    try { out.push({ kind: m[1], ...JSON.parse(m[2]), commentAt: c.createdAt }); } catch { /* hand-edited marker */ }
  }
  return out;
}

const names = (issue) => (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

/**
 * The live claim: the first claim after the last release, while the issue
 * still carries in_progress or review. The first one wins a claim race.
 */
function currentClaim(issue, L) {
  const has = names(issue);
  if (!has.includes(L.in_progress) && !has.includes(L.review)) return null;
  const ev = events(issue.comments);
  let start = 0;
  ev.forEach((e, i) => { if (e.kind === 'release') start = i + 1; });
  return ev.slice(start).find((e) => e.kind === 'claim') || null;
}

/** Scan text with comment_forbidden after removing comment_allowed phrases. */
function scanText(text, config) {
  const re = new RegExp(config.comment_forbidden, 'gi');
  const hits = [];
  text.split('\n').forEach((line, i) => {
    let l = line;
    for (const a of config.comment_allowed) l = l.replace(new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
    for (const m of l.matchAll(re)) if (m[0]) hits.push({ line: i + 1, match: m[0], text: line.trim().slice(0, 120) });
  });
  return hits;
}

function assertClean(text, config, what) {
  const hits = scanText(text, config);
  if (hits.length) {
    throw new Refusal(`${what} has forbidden words: ${hits.map((h) => `line ${h.line} "${h.match}"`).join(', ')}`,
      EXIT.REFUSED, { forbidden: hits });
  }
}

// ---------------------------------------------------------------- issues

const ISSUE_FIELDS = 'number,title,state,labels,assignees,body,createdAt,updatedAt,url';

function listIssues(ctx, label, fields = ISSUE_FIELDS, state = 'open') {
  const args = ['issue', 'list', ...ctx.R, '--state', state, '--limit', '1000', '--json', fields];
  if (label) args.push('--label', label);
  return ghJson(args) || [];
}

function viewIssue(ctx, n, fields = `${ISSUE_FIELDS},comments`) {
  return ghJson(['issue', 'view', String(n), ...ctx.R, '--json', fields]);
}

function comment(ctx, kind, n, body) {
  assertClean(body.replace(MARK, ''), ctx.config, 'comment');
  gh([kind, 'comment', String(n), ...ctx.R, '--body-file', '-'], { input: body });
}

/** Set the status labels of an issue to exactly `to` (plus non-status labels). */
function setStatus(ctx, issue, to, { assign, unassign } = {}) {
  const L = ctx.config.labels;
  const status = [L.ready, L.blocked, L.in_progress, L.rework, L.review, L.held];
  const has = names(issue);
  const remove = has.filter((l) => status.includes(l) && l !== to);
  const args = ['issue', 'edit', String(issue.number), ...ctx.R];
  if (to && !has.includes(to)) args.push('--add-label', to);
  if (remove.length) args.push('--remove-label', remove.join(','));
  if (assign) args.push('--add-assignee', '@me');
  if (unassign && (issue.assignees || []).length) args.push('--remove-assignee', issue.assignees.map((a) => a.login).join(','));
  if (args.length > 5) gh(args);
}

// ---------------------------------------------------------------- dependencies

/**
 * Parse "Depends on" lines. A part is a list of issue refs (#N or owner/repo#N),
 * a reference marked "(done)" (satisfied), "none", or anything else (unresolved,
 * so it blocks: an unknown reference is never assumed done).
 */
function parseDepends(body, pattern) {
  const re = new RegExp(pattern, 'gmi');
  const refs = []; const unresolved = [];
  for (const m of (body || '').matchAll(re)) {
    for (const raw of (m[1] || '').split(/[,;]|\band\b/i)) {
      const part = raw.trim().replace(/[.\s]+$/, '');
      if (!part || /^(none|n\/a|-)$/i.test(part)) continue;
      const found = [...part.matchAll(/(?:([\w.-]+\/[\w.-]+))?#(\d+)/g)];
      if (found.length) found.forEach((f) => refs.push({ repo: f[1] || null, number: Number(f[2]) }));
      else if (!/\(done\)/i.test(part)) unresolved.push(part);
    }
  }
  return { refs, unresolved };
}

/** One GraphQL call for the state of every referenced issue or PR. */
function depStates(ctx, refs) {
  const byRepo = new Map();
  for (const r of refs) {
    const repo = r.repo || ctx.repo;
    if (!byRepo.has(repo)) byRepo.set(repo, new Set());
    byRepo.get(repo).add(r.number);
  }
  if (!byRepo.size) return new Map();
  const parts = [];
  const repos = [...byRepo.keys()];
  repos.forEach((repo, i) => {
    const [o, n] = repo.split('/');
    if (!/^[\w.-]+$/.test(o) || !/^[\w.-]+$/.test(n)) throw new Refusal(`bad repo in a dependency: ${repo}`, EXIT.ERROR);
    const items = [...byRepo.get(repo)].map((num) =>
      `i${num}: issueOrPullRequest(number:${num}){__typename ... on Issue{state} ... on PullRequest{state merged}}`);
    parts.push(`r${i}: repository(owner:"${o}",name:"${n}"){${items.join(' ')}}`);
  });
  const data = ghJson(['api', 'graphql', '-f', `query=query{${parts.join(' ')}}`]).data || {};
  const out = new Map();
  repos.forEach((repo, i) => {
    for (const num of byRepo.get(repo)) {
      const node = data[`r${i}`] && data[`r${i}`][`i${num}`];
      const done = !!node && (node.__typename === 'PullRequest' ? node.merged === true : node.state === 'CLOSED');
      out.set(`${repo}#${num}`, { done, found: !!node });
    }
  });
  return out;
}

// ---------------------------------------------------------------- pick

function cmdPick(ctx) {
  const L = ctx.config.labels;
  const seen = new Map();
  for (const label of [L.ready, L.rework]) for (const i of listIssues(ctx, label)) seen.set(i.number, i);
  const skipped = { held: 0, decision: 0, blocked: 0, claimed: 0, waiting_on_dependencies: 0, unresolved_dependency: 0 };
  const open = [];
  for (const issue of seen.values()) {
    const has = names(issue);
    if (has.includes(L.held)) skipped.held++;
    else if (has.includes(L.decision)) skipped.decision++;
    else if (has.includes(L.blocked)) skipped.blocked++;
    else if (has.includes(L.in_progress) || has.includes(L.review)) skipped.claimed++;
    else open.push({ issue, deps: parseDepends(issue.body, ctx.config.depends_pattern) });
  }
  const states = depStates(ctx, open.flatMap((c) => c.deps.refs));
  const candidates = []; const waiting = [];
  for (const c of open) {
    const notDone = c.deps.refs.map((r) => `${r.repo || ctx.repo}#${r.number}`).filter((k) => !states.get(k).done)
      .map((k) => (k.startsWith(`${ctx.repo}#`) ? k.slice(ctx.repo.length) : k));
    if (c.deps.unresolved.length) { skipped.unresolved_dependency++; waiting.push({ number: c.issue.number, unresolved: c.deps.unresolved }); }
    else if (notDone.length) { skipped.waiting_on_dependencies++; waiting.push({ number: c.issue.number, open: notDone }); }
    else candidates.push(c.issue);
  }
  const urgent = (i) => (names(i).includes(L.urgent) ? 0 : 1);
  candidates.sort((a, b) => urgent(a) - urgent(b) || a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
  const picked = candidates[0] || null;
  let why = null;
  if (picked) {
    const u = urgent(picked) === 0;
    const peers = candidates.filter((c) => urgent(c) === urgent(picked)).length;
    why = `${u ? 'urgent, ' : (candidates.some((c) => urgent(c) === 0) ? '' : 'no urgent issue ready, ')}oldest of ${peers} ${u ? 'urgent ' : ''}ready (created ${picked.createdAt})`;
  }
  const result = {
    picked: picked && { number: picked.number, title: picked.title, url: picked.url, labels: names(picked), created: picked.createdAt },
    why, ready: candidates.length, skipped, waiting
  };
  const counts = Object.entries(skipped).filter(([, v]) => v).map(([k, v]) => `${v} ${k.replaceAll('_', ' ')}`).join(', ');
  const text = picked
    ? `#${picked.number} ${picked.title}\n  why: ${why}${counts ? `\n  skipped: ${counts}` : ''}`
    : `nothing ready${counts ? `: ${counts}` : ' (no ready issues)'}`;
  return { code: picked ? EXIT.OK : EXIT.NOT_NOW, result, text };
}

// ---------------------------------------------------------------- claim, release, stale

function staleness(ctx, issue, claim) {
  let last = Date.parse(claim.at || claim.commentAt);
  for (const c of issue.comments || []) last = Math.max(last, Date.parse(c.createdAt));
  let pushed = null;
  if (claim.branch) {
    const r = run('gh', ['api', `repos/${ctx.repo}/branches/${encodeURIComponent(claim.branch)}`], { allowFail: true });
    if (r.status === 0) {
      const b = JSON.parse(r.stdout);
      pushed = b.commit && b.commit.commit && b.commit.commit.committer && b.commit.commit.committer.date;
      if (pushed) last = Math.max(last, Date.parse(pushed));
    }
  }
  const idleHours = (Date.now() - last) / 3600e3;
  return { idleHours, stale: idleHours >= ctx.config.stale_claim_hours, lastActivity: new Date(last).toISOString(), pushed };
}

function cmdClaim(ctx, opts) {
  const n = needInt(opts._[0], 'issue number');
  const agent = need(opts.agent, '--agent');
  const branch = need(opts.branch, '--branch');
  if (!/^[\w.-]+$/.test(agent)) throw new Refusal('--agent must be letters, digits, ".", "_" or "-"', EXIT.ERROR);
  const L = ctx.config.labels;
  const issue = viewIssue(ctx, n);
  if (issue.state !== 'OPEN') throw new Refusal(`#${n} is ${issue.state.toLowerCase()}`);
  const has = names(issue);
  for (const k of ['held', 'decision', 'blocked']) if (has.includes(L[k])) throw new Refusal(`#${n} is ${L[k]}`);
  const cur = currentClaim(issue, L);
  if (cur) {
    if (cur.agent !== agent) {
      const s = staleness(ctx, issue, cur);
      throw new Refusal(`#${n} is claimed by ${cur.agent} on ${cur.branch} since ${cur.at}` +
        (s.stale ? `; idle ${s.idleHours.toFixed(1)} h, release it with: stale --retake` : ''), EXIT.REFUSED, { claim: cur });
    }
    if (cur.branch !== branch) throw new Refusal(`#${n} is already claimed by ${agent} on branch ${cur.branch}`);
    if (!has.includes(L.in_progress) && !has.includes(L.review)) setStatus(ctx, issue, L.in_progress, { assign: true });
    return { result: { issue: n, agent, branch, already: true }, text: `#${n} already claimed by ${agent} on ${branch}` };
  }
  if (has.includes(L.in_progress) || has.includes(L.review)) throw new Refusal(`#${n} is in progress with no foreman claim; release it first`);
  if (!has.includes(L.ready) && !has.includes(L.rework)) throw new Refusal(`#${n} is not ${L.ready} or ${L.rework}`);
  const at = new Date().toISOString();
  comment(ctx, 'issue', n, `${marker('claim', { agent, branch, at })}\nClaimed by ${agent} on branch \`${branch}\` at ${at}.`);
  setStatus(ctx, issue, L.in_progress, { assign: true });
  // Two sessions can claim at once. The first claim comment wins; re-read to see who.
  const after = currentClaim(viewIssue(ctx, n, 'number,labels,comments'), L);
  if (!after || after.agent !== agent || after.at !== at) {
    throw new Refusal(`#${n} lost the claim race to ${after ? after.agent : 'a release'}`, EXIT.REFUSED, { claim: after });
  }
  return { result: { issue: n, agent, branch, at, already: false }, text: `#${n} claimed by ${agent} on ${branch}` };
}

const RELEASE_TARGETS = ['ready', 'rework', 'held', 'blocked', 'review'];

function release(ctx, issue, to, reason, extra = {}) {
  const L = ctx.config.labels;
  const label = L[to];
  // review keeps the claim: the same session still owns the PR. Every other target ends it.
  const ends = to !== 'review';
  const body = `${ends ? `${marker('release', { to, at: new Date().toISOString(), ...extra })}\n` : ''}Moved to ${label}: ${reason}`;
  comment(ctx, 'issue', issue.number, body);
  setStatus(ctx, issue, label, { unassign: ends });
}

function cmdRelease(ctx, opts) {
  const n = needInt(opts._[0], 'issue number');
  const to = need(opts.to, '--to');
  if (!RELEASE_TARGETS.includes(to)) throw new Refusal(`--to must be one of ${RELEASE_TARGETS.join(', ')}`, EXIT.ERROR);
  const reason = need(opts.reason, '--reason');
  const issue = viewIssue(ctx, n);
  if (issue.state !== 'OPEN') throw new Refusal(`#${n} is ${issue.state.toLowerCase()}`);
  if (to === 'review' && !currentClaim(issue, ctx.config.labels)) throw new Refusal(`#${n} has no live claim to move to review`);
  release(ctx, issue, to, reason);
  return { result: { issue: n, to: ctx.config.labels[to], reason }, text: `#${n} -> ${ctx.config.labels[to]}` };
}

function cmdStale(ctx, opts) {
  const L = ctx.config.labels;
  const fields = 'number,title,labels,assignees,comments,updatedAt';
  const byNumber = new Map();
  for (const label of [L.in_progress, L.review]) for (const i of listIssues(ctx, label, fields)) byNumber.set(i.number, i);
  const issues = [...byNumber.values()];
  const rows = [];
  for (const issue of issues) {
    const claim = currentClaim(issue, L);
    if (!claim) { rows.push({ number: issue.number, title: issue.title, claim: null, stale: true, note: 'no foreman claim' }); continue; }
    rows.push({ number: issue.number, title: issue.title, claim, ...staleness(ctx, issue, claim), issue });
  }
  const stale = rows.filter((r) => r.stale && r.claim);
  const retaken = [];
  if (opts.retake) {
    // --keep TAG spares this session's own agents (IDs "<tag>-<issue>"): it knows they are alive.
    for (const r of stale.filter((x) => !opts.keep || !x.claim.agent.startsWith(`${opts.keep}-`))) {
      // A claim in review already has a PR, so it goes to rework, not back to the start.
      const to = names(r.issue).includes(L.review) ? 'rework' : 'ready';
      release(ctx, r.issue, to, `claim by ${r.claim.agent} on \`${r.claim.branch}\` had no push or comment for ${r.idleHours.toFixed(1)} h (limit ${ctx.config.stale_claim_hours} h).`, { retaken: r.claim.agent });
      retaken.push({ number: r.number, to: L[to] });
    }
  }
  const clean = rows.map(({ issue, ...r }) => r);
  const lines = clean.map((r) => (r.claim
    ? `#${r.number} ${r.claim.agent} on ${r.claim.branch}: idle ${r.idleHours.toFixed(1)} h${r.stale ? ' STALE' : ''}`
    : `#${r.number}: ${r.note}`));
  if (retaken.length) lines.push(`retaken: ${retaken.map((r) => `#${r.number} -> ${r.to}`).join(', ')}`);
  return {
    code: stale.length && !opts.retake ? EXIT.NOT_NOW : EXIT.OK,
    result: { claims: clean, stale: stale.map((r) => r.number), retaken },
    text: lines.join('\n') || 'no claims'
  };
}

// ---------------------------------------------------------------- capacity

function memAvailableGb() {
  if (process.env.FOREMAN_MEM_GB) return Number(process.env.FOREMAN_MEM_GB);
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) / 1024 / 1024;
  } catch { /* not Linux */ }
  return os.freemem() / 1024 ** 3;
}

function load1() {
  if (process.env.FOREMAN_LOAD1) return Number(process.env.FOREMAN_LOAD1);
  return os.loadavg()[0];
}

function cpuPressure() {
  try {
    const m = /^some avg10=([\d.]+)/m.exec(fs.readFileSync('/proc/pressure/cpu', 'utf8'));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function capacityFrom(config, claims, local) {
  const load = load1(); const mem = memAvailableGb();
  const agents = claims + local;
  const holds = [];
  if (agents >= config.agents_max) holds.push(`${agents} agents running, max ${config.agents_max}`);
  if (load >= config.load_hold) holds.push(`load1 ${load.toFixed(1)} >= ${config.load_hold}`);
  if (mem <= config.mem_min_gb) holds.push(`${mem.toFixed(1)} GB available <= ${config.mem_min_gb} GB`);
  return {
    load1: Number(load.toFixed(2)), load_hold: config.load_hold,
    mem_available_gb: Number(mem.toFixed(2)), mem_min_gb: config.mem_min_gb,
    cpu_pressure_avg10: cpuPressure(),
    claims, local, agents, agents_max: config.agents_max,
    slots: Math.max(0, config.agents_max - agents),
    may_spawn: holds.length === 0, holds
  };
}

function cmdCapacity(ctx, opts) {
  const local = opts.local === undefined ? 0 : needInt(opts.local, '--local');
  const claims = listIssues(ctx, ctx.config.labels.in_progress, 'number').length;
  const c = capacityFrom(ctx.config, claims, local);
  const text = `${c.may_spawn ? 'spawn ok' : 'hold'}: load1 ${c.load1}/${c.load_hold}, mem ${c.mem_available_gb} GB (min ${c.mem_min_gb}), agents ${c.agents}/${c.agents_max} (${c.claims} claims + ${c.local} local)` +
    (c.holds.length ? `\n  hold: ${c.holds.join('; ')}` : '');
  return { code: c.may_spawn ? EXIT.OK : EXIT.NOT_NOW, result: c, text };
}

// ---------------------------------------------------------------- brief

function section(body, heading) {
  const re = new RegExp(`^#{1,6}\\s*${heading}\\s*$([\\s\\S]*?)(?=^#{1,6}\\s|$(?![\\s\\S]))`, 'mi');
  const m = re.exec(body || '');
  return m ? m[1].trim() : null;
}

function cmdBrief(ctx, opts) {
  const n = needInt(opts._[0], 'issue number');
  const issue = viewIssue(ctx, n);
  const claim = currentClaim(issue, ctx.config.labels);
  const branch = opts.branch || (claim && claim.branch);
  if (!branch) throw new Refusal(`#${n} has no live claim; claim it first or pass --branch`);
  const scratch = scratchDir(ctx, n);
  const acceptance = section(issue.body, 'Acceptance');
  const notes = (issue.comments || []).filter((c) => !MARK.test(c.body || '')).slice(-3)
    .map((c) => `- ${c.createdAt}: ${c.body.trim().slice(0, 2000)}`);
  const lastRelease = events(issue.comments).filter((e) => e.kind === 'release').pop();
  const releaseNote = lastRelease && (issue.comments || []).find((c) => c.createdAt === lastRelease.commentAt);
  const check = ctx.config.check;
  const foreman = path.resolve(__filename);
  const lines = [
    `Implement issue #${n} in ${ctx.repo}: ${issue.title}`,
    '',
    '## Acceptance (done means every item holds)',
    acceptance || 'The issue has no Acceptance section. Treat the whole issue below as the acceptance.',
    '',
    '## Issue body',
    issue.body || '(empty)',
    ''
  ];
  if (releaseNote) lines.push('## Why it came back', releaseNote.body.replace(MARK, '').trim(), '');
  if (notes.length) lines.push('## Recent comments', ...notes, '');
  if (opts.pr) {
    const f = readFindings(ctx, needInt(opts.pr, '--pr'));
    const open = f.findings.filter((x) => !x.addressed);
    lines.push(`## Review findings to fix on PR #${f.pr} (head ${f.head.slice(0, 7)})`,
      open.length ? 'Fix each one in this change. If one is wrong, say why in your report instead of changing the code.' : 'None open.',
      ...open.map((x) => `- ${x.severity || 'unrated'} ${x.path}:${x.line || '?'}: ${x.detail.replace(/\n+/g, ' ')}`), '');
  }
  lines.push(
    '## Rules',
    `- Work only in your worktree. Commit there and push to branch \`${branch}\`: \`git push origin HEAD:refs/heads/${branch}\`.`,
    `- Scratch: ${scratch}. Put only artifacts you cite in ${path.join(scratch, 'evidence')}. Nothing goes in /tmp.`,
    check ? `- Before you report, run \`${check}\` from the worktree root. Report its exit code and log path. A failing check is a failed task, not a note.`
      : '- The repo has no foreman check command. Run the tests your change touches and report them.',
    '- Run only the tests your change touches. The full suite runs once at merge.',
    '- No attribution: no Co-Authored-By trailer and no "Generated with" line in commits or PR text. Check `git log -1 --format=%B` before you push.',
    '- Scope is frozen. Anything outside the acceptance goes in your report as a follow-up, not in this change.',
    '- Do not run host-only steps (user systemd bus, hardware, cloud CLIs, anything outside the worktree). Write the exact commands and the receipts they should produce in your report.',
    `- Commands longer than 10 minutes: \`node ${foreman} run-long --unit <name> --log ${path.join(scratch, '<name>.log')} -- <cmd>\`, then wait with \`waitfor --until '! systemctl --user is-active -q <name>' --every 1m --timeout 2h\`. Never \`nohup\` or \`&\`.`,
    `- You share the host with ${ctx.config.agents_max - 1} other agents. Keep parallel builds and tests small. If a process of yours is killed, say so; do not report it as an unknown exit.`,
    '',
    '## Report (your final message)',
    `- branch \`${branch}\` and the pushed head SHA (\`git rev-parse HEAD\`), or "not pushed" and why`,
    `- ${check ? `\`${check}\`` : 'tests run'}: exit code and log path`,
    '- what changed, one line per file group',
    '- each acceptance item: met or not, with the evidence',
    '- host-only steps as exact commands, and follow-ups'
  );
  const text = lines.join('\n');
  return { result: { issue: n, branch, scratch, brief: text }, text };
}

// ---------------------------------------------------------------- findings

// Revuto signs every comment and review with this marker. Its finding text
// follows the first "---" line. It writes no structured severity; a model may
// put "[P0]".."[P3]" or HIGH/MEDIUM/LOW in the text, which is all there is.
const SIGNED = '<!-- revuto-signed -->';
const CAP_RE = /reached the (\d+)-round review limit|round cap reached/i;
const SELF_RE = /<!-- foreman:self-review findings=(\d+) fixed=(\d+) -->/;
const ASK_RE = /<!-- foreman:revuto-ask -->/;
const LOW = new Set(['P3', 'LOW']);

const login = (a) => ((a && a.login) || '').replace(/^app\//, '').replace(/\[bot\]$/, '').toLowerCase();

function findingText(body) {
  const i = body.indexOf('\n---\n');
  return (i >= 0 ? body.slice(i + 5) : body.replace(SIGNED, '')).trim();
}

function severityOf(text) {
  const m = /\[(P[0-3])\]|\b(HIGH|MEDIUM|LOW)\b(?=\s*[:\]-])/.exec(text);
  return m ? (m[1] || m[2]).toUpperCase() : null;
}

const FINDINGS_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){
headRefOid
commits(last:1){nodes{commit{oid committedDate checkSuites(first:50){nodes{app{slug} checkRuns(first:20){nodes{name status conclusion title summary}}}}}}}
reviews(first:100){nodes{databaseId author{login} state body submittedAt commit{oid}}}
comments(last:100){nodes{author{login} body createdAt}}
reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated path line originalLine comments(first:50){nodes{databaseId author{login} body createdAt originalCommit{oid} pullRequestReview{databaseId}}}}}
}}}`;

function fetchFindingsData(ctx, pr) {
  let after = null; let first = null; const threads = [];
  do {
    const args = ['api', 'graphql', '-f', `query=${FINDINGS_QUERY}`, '-f', `owner=${ctx.owner}`, '-f', `name=${ctx.name}`, '-F', `pr=${pr}`];
    if (after) args.push('-f', `after=${after}`);
    const d = ghJson(args);
    const p = d && d.data && d.data.repository && d.data.repository.pullRequest;
    if (!p) throw new Refusal(`PR #${pr} not found in ${ctx.repo}`, EXIT.ERROR);
    if (!first) first = p;
    threads.push(...p.reviewThreads.nodes);
    after = p.reviewThreads.pageInfo && p.reviewThreads.pageInfo.hasNextPage ? p.reviewThreads.pageInfo.endCursor : null;
  } while (after);
  return { ...first, threads };
}

/**
 * Revuto's state on a PR. A finding is addressed when its thread is resolved,
 * GitHub marks it outdated (a later commit changed those lines), or someone
 * other than Revuto replied in the thread.
 */
function readFindings(ctx, pr) {
  const app = ctx.config.review.app.toLowerCase();
  const d = fetchFindingsData(ctx, pr);
  const head = d.headRefOid;
  const headCommit = (d.commits.nodes[0] || {}).commit || {};
  const runs = (headCommit.checkSuites ? headCommit.checkSuites.nodes : [])
    .filter((s) => s.app && s.app.slug && s.app.slug.toLowerCase() === app)
    .flatMap((s) => s.checkRuns.nodes);
  const check = runs[runs.length - 1] || null;
  const isApp = (a) => login(a) === app;
  const reviews = d.reviews.nodes.filter((r) => isApp(r.author) && (r.body || '').includes(SIGNED) && r.submittedAt);
  const roundOf = new Map(reviews.map((r, i) => [r.databaseId, i + 1]));
  const rounds = reviews.length;
  const roundsMax = ctx.config.review.rounds_max;

  const findings = [];
  for (const t of d.threads) {
    const c0 = t.comments.nodes[0];
    if (!c0 || !isApp(c0.author)) continue;
    const text = findingText(c0.body);
    const reply = t.comments.nodes.slice(1).find((c) => !isApp(c.author));
    const how = t.isResolved ? 'resolved' : t.isOutdated ? 'outdated' : reply ? 'reply' : null;
    findings.push({
      id: c0.databaseId, round: (c0.pullRequestReview && roundOf.get(c0.pullRequestReview.databaseId)) || null,
      severity: severityOf(text), path: t.path, line: t.line || t.originalLine || null,
      commit: c0.originalCommit && c0.originalCommit.oid, addressed: !!how, how,
      text: text.split('\n')[0].slice(0, 200), detail: text.slice(0, 4000)
    });
  }

  const capText = [check && check.summary, check && check.title, ...reviews.map((r) => r.body),
    ...d.comments.nodes.filter((c) => isApp(c.author)).map((c) => c.body)].filter(Boolean).find((s) => CAP_RE.test(s));
  const capped = !!capText || rounds >= roundsMax;
  const capReason = capText ? capText.match(CAP_RE)[0] : capped ? `${rounds} rounds used, rounds_max ${roundsMax}` : null;
  const reviewedHead = reviews.some((r) => r.commit && r.commit.oid === head) || !!(check && check.conclusion === 'SUCCESS');

  let pending = null; let unavailable = null;
  if (!capped && !reviewedHead) {
    if (check && check.status !== 'COMPLETED') pending = `${ctx.config.review.app} review in progress at ${head.slice(0, 7)}`;
    else if (check && check.conclusion !== 'SUCCESS' && !/found review concerns/i.test(check.title || '')) unavailable = check.title || `check ${check.conclusion}`;
    else if (!check) {
      const age = (Date.now() - Date.parse(headCommit.committedDate || 0)) / 60e3;
      if (age < ctx.config.review.wait_minutes) pending = `${ctx.config.review.app} has not started on ${head.slice(0, 7)} (${Math.round(age)} of ${ctx.config.review.wait_minutes} min)`;
      else unavailable = `no ${ctx.config.review.app} check at ${head.slice(0, 7)} after ${ctx.config.review.wait_minutes} min`;
    }
  }

  const pushed = Date.parse(headCommit.committedDate || 0);
  const selfReviews = d.comments.nodes.map((c) => ({ c, m: SELF_RE.exec(c.body || '') })).filter((x) => x.m)
    .map((x) => ({ at: x.c.createdAt, findings: Number(x.m[1]), fixed: Number(x.m[2]), after_head: Date.parse(x.c.createdAt) >= pushed }));
  const lastRound = findings.filter((f) => f.round === rounds);
  return {
    pr, head, app: ctx.config.review.app, rounds, rounds_max: roundsMax, capped, cap_reason: capReason,
    unavailable: !!unavailable, unavailable_reason: unavailable, pending, reviewed_head: reviewedHead,
    check: check && { status: check.status, conclusion: check.conclusion, title: check.title },
    findings, unaddressed: findings.filter((f) => !f.addressed).length,
    lows_only_last_round: lastRound.length > 0 && lastRound.every((f) => LOW.has(f.severity)),
    self_review: selfReviews.filter((s) => s.after_head).pop() || null,
    revuto_asks: d.comments.nodes.filter((c) => ASK_RE.test(c.body || '')).length
  };
}

function renderFindings(f) {
  const state = f.capped ? `capped (${f.cap_reason})` : f.unavailable ? `unavailable (${f.unavailable_reason})` : f.pending || (f.reviewed_head ? 'reviewed the head' : 'has not reviewed the head');
  const lines = [`PR #${f.pr} at ${f.head.slice(0, 7)}: ${f.app} ${state}; rounds ${f.rounds}/${f.rounds_max}; ${f.unaddressed} of ${f.findings.length} finding(s) unaddressed`];
  for (const x of f.findings) lines.push(`  ${x.addressed ? `[${x.how}]` : '[OPEN]'} r${x.round || '?'} ${x.severity || 'unrated'} ${x.path}:${x.line || '?'} ${x.text}`);
  if (f.lows_only_last_round) lines.push('  last round is lows only: fix them, no new round');
  if (f.self_review) lines.push(`  self-review after the head: ${f.self_review.findings} found, ${f.self_review.fixed} fixed`);
  return lines.join('\n');
}

function cmdFindings(ctx, opts) {
  const pr = needInt(opts._[0], 'PR number');
  const f = readFindings(ctx, pr);
  return { result: f, text: renderFindings(f) };
}

function cmdSelfReview(ctx, opts) {
  const pr = needInt(opts._[0], 'PR number');
  const found = needInt(opts.findings, '--findings');
  const fixed = needInt(opts.fixed, '--fixed');
  if (fixed > found) throw new Refusal('--fixed cannot exceed --findings', EXIT.ERROR);
  const body = fs.readFileSync(need(opts.body, '--body'), 'utf8').trim();
  if (!body) throw new Refusal('--body file is empty; write what you checked and what you fixed', EXIT.ERROR);
  const f = readFindings(ctx, pr);
  if (!f.capped && !f.unavailable) {
    throw new Refusal(`${ctx.config.review.app} is neither capped nor unavailable on PR #${pr} (rounds ${f.rounds}/${f.rounds_max}); fix its findings instead`);
  }
  comment(ctx, 'pr', pr, `<!-- foreman:self-review findings=${found} fixed=${fixed} -->\nSession review of ${f.head.slice(0, 7)} (${f.capped ? 'review cap reached' : 'review unavailable'}): ${found} found, ${fixed} fixed.\n\n${body}`);
  return { result: { pr, head: f.head, findings: found, fixed }, text: `PR #${pr}: self-review recorded at ${f.head.slice(0, 7)} (${found} found, ${fixed} fixed)` };
}

function cmdRevutoAsk(ctx, opts) {
  const pr = needInt(opts._[0], 'PR number');
  const f = readFindings(ctx, pr);
  comment(ctx, 'pr', pr, `<!-- foreman:revuto-ask -->\nRequesting one more ${ctx.config.review.app} round at ${f.head.slice(0, 7)}.`);
  // Revuto takes no comment command; its operator runs the final round from its CLI.
  const cli = `revuto review ${ctx.repo} ${pr} --final`;
  return { result: { pr, head: f.head, operator_command: cli }, text: `PR #${pr}: request posted\n  operator runs: ${cli}` };
}

// ---------------------------------------------------------------- stats

const STATS_QUERY = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{
number
comments(last:100){nodes{author{login} body createdAt}}
reviews(first:100){nodes{author{login} body}}
commits(last:1){nodes{commit{checkSuites(first:50){nodes{app{slug} checkRuns(first:20){nodes{title summary}}}}}}}
}}}}`;

function cmdStats(ctx, opts) {
  const since = opts.since || null;
  if (since && Number.isNaN(Date.parse(since))) throw new Refusal(`--since must be a date (got ${since})`, EXIT.ERROR);
  const app = ctx.config.review.app.toLowerCase();
  const q = `repo:${ctx.repo} is:pr${since ? ` updated:>=${since.slice(0, 10)}` : ''}`;
  const prs = []; let after = null;
  do {
    const args = ['api', 'graphql', '-f', `query=${STATS_QUERY}`, '-f', `q=${q}`];
    if (after) args.push('-f', `after=${after}`);
    const s = ghJson(args).data.search;
    prs.push(...s.nodes.filter((n) => n && n.number));
    after = s.pageInfo.hasNextPage ? s.pageInfo.endCursor : null;
  } while (after);
  const inRange = (at) => !since || Date.parse(at) >= Date.parse(since);
  const capped = []; const selfReviews = []; const asks = [];
  for (const p of prs) {
    const runs = p.commits.nodes.flatMap((c) => c.commit.checkSuites.nodes)
      .filter((s) => s.app && s.app.slug.toLowerCase() === app).flatMap((s) => s.checkRuns.nodes);
    const texts = [...runs.flatMap((r) => [r.title, r.summary]), ...p.reviews.nodes.filter((r) => login(r.author) === app).map((r) => r.body),
      ...p.comments.nodes.filter((c) => login(c.author) === app).map((c) => c.body)];
    if (texts.some((t) => t && CAP_RE.test(t))) capped.push(p.number);
    for (const c of p.comments.nodes) {
      if (!inRange(c.createdAt)) continue;
      const m = SELF_RE.exec(c.body || '');
      if (m) selfReviews.push({ pr: p.number, at: c.createdAt, findings: Number(m[1]), fixed: Number(m[2]) });
      if (ASK_RE.test(c.body || '')) asks.push({ pr: p.number, at: c.createdAt });
    }
  }
  const found = selfReviews.reduce((a, s) => a + s.findings, 0);
  const fixed = selfReviews.reduce((a, s) => a + s.fixed, 0);
  const result = {
    repo: ctx.repo, since, prs_scanned: prs.length, capped_prs: capped,
    self_reviews: selfReviews.length, self_review_findings: found, self_review_fixed: fixed,
    findings_per_self_review: selfReviews.length ? Number((found / selfReviews.length).toFixed(2)) : null,
    self_review_list: selfReviews, revuto_asks: asks.length, revuto_ask_list: asks
  };
  const text = [
    `${ctx.repo}${since ? ` since ${since}` : ''}: ${prs.length} PRs scanned`,
    `  hit the ${ctx.config.review.app} cap: ${capped.length}${capped.length ? ` (${capped.map((n) => `#${n}`).join(' ')})` : ''}`,
    `  self-reviews: ${selfReviews.length}, findings ${found}, fixed ${fixed}${selfReviews.length ? `, ${result.findings_per_self_review} per self-review` : ''}`,
    `  manual ${ctx.config.review.app} requests: ${asks.length}`
  ].join('\n');
  return { result, text };
}

// ---------------------------------------------------------------- land

const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'EXPECTED', 'WAITING', 'REQUESTED']);

/** Classify the status rollup at the head. A cancelled or never-run check is not green. */
function classifyChecks(rollup, config) {
  const app = config.review.app.toLowerCase();
  const out = { green: [], pending: [], bad: [], review: [] };
  for (const c of rollup || []) {
    const name = c.name || c.context || '?';
    const state = c.__typename === 'StatusContext' || c.state
      ? (c.state || '').toUpperCase()
      : (c.status || '').toUpperCase() !== 'COMPLETED' ? (c.status || 'PENDING').toUpperCase() : (c.conclusion || '').toUpperCase();
    const row = { name, state };
    // The review app's own check is judged by its findings, not by its colour.
    if (name.toLowerCase().includes(app)) { out.review.push(row); continue; }
    if (GREEN.has(state)) out.green.push(row);
    else if (PENDING.has(state)) out.pending.push(row);
    else out.bad.push(row);
  }
  for (const req of config.required_checks) {
    if (!out.green.some((c) => c.name === req) && !out.bad.some((c) => c.name === req) && !out.pending.some((c) => c.name === req)) {
      out.pending.push({ name: req, state: 'NOT_REPORTED' });
    }
  }
  return out;
}

function stripAttribution(text) {
  return text.split('\n')
    .filter((l) => !/^\s*co-authored-by:/i.test(l) && !/generated with/i.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function lsRemote(ctx, branch) {
  const out = git(['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: ctx.root });
  return out.split(/\s+/)[0] || null;
}

const PR_FIELDS = 'number,title,state,url,headRefOid,headRefName,baseRefName,mergeable,statusCheckRollup,commits';

/** Step 1: every gate that does not change anything. Returns the PR, or throws. */
function landGates(ctx, n, opts) {
  const pr = needInt(opts.pr, '--pr');
  const want = need(opts.head, '--head');
  if (!/^[0-9a-f]{7,40}$/i.test(want)) throw new Refusal('--head must be a commit SHA (7 to 40 hex digits)', EXIT.ERROR);
  const p = ghJson(['pr', 'view', String(pr), ...ctx.R, '--json', PR_FIELDS]);
  if (p.state !== 'OPEN') throw new Refusal(`PR #${pr} is ${p.state.toLowerCase()}`);
  if (!p.headRefOid.startsWith(want.toLowerCase())) throw new Refusal(`PR #${pr} head is ${p.headRefOid}, not ${want}`, EXIT.REFUSED, { head: p.headRefOid });
  const checks = classifyChecks(p.statusCheckRollup, ctx.config);
  const total = checks.green.length + checks.pending.length + checks.bad.length;
  if (checks.bad.length) throw new Refusal(`PR #${pr} checks not green at ${p.headRefOid.slice(0, 7)}: ${checks.bad.map((c) => `${c.name}=${c.state}`).join(', ')}`, EXIT.REFUSED, { checks });
  if (checks.pending.length) throw new Refusal(`PR #${pr} checks pending: ${checks.pending.map((c) => `${c.name}=${c.state}`).join(', ')}`, EXIT.NOT_NOW, { checks });
  if (!total) throw new Refusal(`PR #${pr} has no checks at ${p.headRefOid.slice(0, 7)}; CI may not have started`, EXIT.NOT_NOW, { checks });
  if (p.mergeable === 'CONFLICTING') throw new Refusal(`PR #${pr} conflicts with ${p.baseRefName}`);
  if (p.mergeable !== 'MERGEABLE') throw new Refusal(`PR #${pr} mergeable state is ${p.mergeable}; GitHub is still computing it`, EXIT.NOT_NOW);
  const findings = readFindings(ctx, pr);
  const app = ctx.config.review.app;
  const open = findings.findings.filter((f) => !f.addressed);
  const excused = findings.capped || findings.unavailable;
  const decided = !!opts['decided-by-session'];
  if (decided) {
    if (!excused) throw new Refusal(`--decided-by-session is allowed only when ${app} is capped or unavailable (rounds ${findings.rounds}/${findings.rounds_max}, ${findings.pending || 'available'})`);
    if (!findings.self_review) throw new Refusal(`--decided-by-session needs a self-review recorded on PR #${pr} after the head's last push: review the diff, fix, push, then run self-review`, EXIT.REFUSED, { findings });
  } else {
    const why = excused ? `${app} is ${findings.capped ? `capped (${findings.cap_reason})` : `unavailable (${findings.unavailable_reason})`}` : null;
    if (open.length) {
      throw new Refusal(`PR #${pr} has ${open.length} unaddressed ${app} finding(s): ${open.map((f) => `${f.severity || 'unrated'} ${f.path}:${f.line || '?'}`).join(', ')}` +
        (why ? `; ${why}, so self-review the diff and land with --decided-by-session` : ''), EXIT.REFUSED, { findings });
    }
    if (!findings.reviewed_head) {
      // No new round after a lows-only round, or for a title, doc or small clear fix (--trivial).
      const last = findings.findings.filter((f) => f.round === findings.rounds);
      const real = last.some((f) => !LOW.has(f.severity));
      const lowsPass = findings.lows_only_last_round && ctx.config.review.no_new_round_for_lows;
      if (!findings.rounds || (real && !lowsPass && !opts.trivial)) {
        // A head Revuto will never review (cap or outage) still gets a reviewer: the session.
        if (why) throw new Refusal(`PR #${pr}: ${why} and ${head7(p)} is unreviewed; self-review the diff and land with --decided-by-session`, EXIT.REFUSED, { findings });
        if (findings.pending) throw new Refusal(`PR #${pr}: ${findings.pending}`, EXIT.NOT_NOW, { findings });
        throw new Refusal(findings.rounds
          ? `PR #${pr}: round ${findings.rounds} had real findings and ${head7(p)} is not reviewed yet; wait for the next round, or pass --trivial for a ${ctx.config.review.trivial_merge.join(', ')}`
          : `PR #${pr}: ${app} has not reviewed it yet`, EXIT.NOT_NOW, { findings });
      }
    }
  }
  return { pr, p, checks, findings, open };
}

const head7 = (p) => p.headRefOid.slice(0, 7);

function cmdLand(ctx, opts) {
  const n = needInt(opts._[0], 'issue number');
  const commentText = opts['comment-file'] ? fs.readFileSync(opts['comment-file'], 'utf8') : (opts.comment || null);
  if (commentText) assertClean(commentText, ctx.config, 'review comment');
  const g = landGates(ctx, n, opts);
  const { pr, p } = g;
  const head = p.headRefOid;
  if (opts.gate) {
    return { result: { issue: n, pr, head, gate: 'pass', checks: g.checks.green.length }, text: `PR #${pr} at ${head.slice(0, 7)}: gates pass` };
  }

  // Step 2 and 5: the land command, rerun once when main moves under it.
  let landLog = null; let receipts = null;
  if (ctx.config.land) {
    const dir = scratchDir(ctx, n);
    receipts = path.join(dir, 'evidence', `land-${head.slice(0, 7)}`);
    fs.mkdirSync(receipts, { recursive: true });
    for (let attempt = 1; ; attempt++) {
      landLog = path.join(dir, `land-${head.slice(0, 7)}-${attempt}.log`);
      const before = lsRemote(ctx, p.baseRefName);
      const cmd = ctx.config.land
        .replaceAll('{issue}', String(n)).replaceAll('{pr}', String(pr)).replaceAll('{head}', head)
        .replaceAll('{base}', shQuote(p.baseRefName)).replaceAll('{receipts}', shQuote(receipts)).replaceAll('{log}', shQuote(landLog));
      const rc = runShell(cmd, { cwd: ctx.root, logFile: landLog, env: { FOREMAN_RECEIPTS: receipts, FOREMAN_ISSUE: String(n), FOREMAN_PR: String(pr), FOREMAN_HEAD: head } });
      if (rc !== 0) {
        const tail = fs.readFileSync(landLog, 'utf8').trim().split('\n').slice(-5).join('\n');
        throw new Refusal(`land command exit ${rc} (log ${landLog}):\n${tail}`, EXIT.REFUSED, { log: landLog, receipts });
      }
      const after = lsRemote(ctx, p.baseRefName);
      if (after === before) break;
      if (attempt >= 2) throw new Refusal(`${p.baseRefName} moved during the land check twice (${before.slice(0, 7)} -> ${after.slice(0, 7)}); land again later`, EXIT.REFUSED, { log: landLog });
    }
    const now = ghJson(['pr', 'view', String(pr), ...ctx.R, '--json', 'headRefOid']).headRefOid;
    if (now !== head) throw new Refusal(`PR #${pr} head moved to ${now} during the land check`);
  }

  // Step 3 and 4: post the review comment, then squash at the exact head.
  if (commentText) gh(['pr', 'comment', String(pr), ...ctx.R, '--body-file', '-'], { input: commentText });
  const body = stripAttribution((p.commits || []).map((c) => [c.messageHeadline, c.messageBody].filter(Boolean).join('\n\n')).join('\n\n'));
  gh(['pr', 'merge', String(pr), ...ctx.R, '--squash', '--match-head-commit', head,
    '--subject', `${p.title} (#${pr})`, '--body-file', '-'], { input: body });
  const merged = ghJson(['pr', 'view', String(pr), ...ctx.R, '--json', 'mergeCommit,state']);
  const mergeSha = merged.mergeCommit && merged.mergeCommit.oid;

  // Step 6: close the issue with a comment that links the merge.
  const issue = viewIssue(ctx, n, 'number,state,labels,assignees');
  const decided = opts['decided-by-session']
    ? ` ${ctx.config.review.app} was ${g.findings.capped ? 'capped' : 'unavailable'}; the session judged it from the land check and the diff.`
    : opts.trivial && !g.findings.reviewed_head ? ' No new review round: title, doc or small clear fix.' : '';
  comment(ctx, 'issue', n, `Landed by #${pr} as ${mergeSha || head}.${decided}`);
  setStatus(ctx, issue, null);
  if (issue.state === 'OPEN') gh(['issue', 'close', String(n), ...ctx.R]);
  return {
    result: { issue: n, pr, head, merge: mergeSha, log: landLog, receipts, decided_by_session: !!opts['decided-by-session'] },
    text: `#${n} landed: PR #${pr} merged as ${mergeSha ? mergeSha.slice(0, 7) : '?'}${landLog ? `\n  land log: ${landLog}\n  receipts: ${receipts}` : ''}`
  };
}

// ---------------------------------------------------------------- status

function cmdStatus(ctx, opts) {
  const L = ctx.config.labels;
  const all = listIssues(ctx, null, 'number,title,labels,updatedAt');
  const counts = {};
  for (const [k, label] of Object.entries(L)) counts[k] = all.filter((i) => names(i).includes(label)).length;
  const claimed = all.filter((i) => names(i).includes(L.in_progress));
  const cutoff = Date.now() - ctx.config.stale_claim_hours * 3600e3;
  const quiet = all.filter((i) => (names(i).includes(L.in_progress) || names(i).includes(L.review)) && Date.parse(i.updatedAt) < cutoff);
  const cap = capacityFrom(ctx.config, claimed.length, opts.local === undefined ? 0 : needInt(opts.local, '--local'));
  const result = { open: all.length, counts, claims: claimed.map((i) => i.number), maybe_stale: quiet.map((i) => i.number), capacity: cap };
  const text = [
    `${ctx.repo}: ${all.length} open`,
    `  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `  claims: ${claimed.map((i) => `#${i.number}`).join(' ') || 'none'}`,
    `  quiet ${ctx.config.stale_claim_hours} h+: ${quiet.map((i) => `#${i.number}`).join(' ') || 'none'}${quiet.length ? ' (run stale for the exact check)' : ''}`,
    `  capacity: ${cap.may_spawn ? `${cap.slots} slot(s)` : `hold (${cap.holds.join('; ')})`}, load1 ${cap.load1}, mem ${cap.mem_available_gb} GB`
  ].join('\n');
  return { result, text };
}

// ---------------------------------------------------------------- run-long

function cmdRunLong(ctx, opts) {
  const unit = need(opts.unit, '--unit');
  if (!/^[\w.@-]+$/.test(unit)) throw new Refusal('--unit must be letters, digits, ".", "_", "@" or "-"', EXIT.ERROR);
  const log = path.resolve(expandHome(need(opts.log, '--log')));
  if (!opts.cmd.length) throw new Refusal('run-long needs a command after --', EXIT.ERROR);
  if (process.platform === 'win32') throw new Refusal('run-long needs systemd user units; start the command detached yourself on this OS', EXIT.ERROR);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // {cmd} and {log} sit inside single quotes in the template, so escape for that.
  const inQuotes = (s) => s.replace(/'/g, `'\\''`);
  const cmd = opts.cmd.map(shQuote).join(' ');
  const line = ctx.config.long_runs.replaceAll('{unit}', unit).replaceAll('{cmd}', inQuotes(cmd)).replaceAll('{log}', inQuotes(shQuote(log)));
  const rc = runShell(line, { cwd: process.cwd() });
  if (rc !== 0) throw new Refusal(`long_runs command exit ${rc}: ${line}`, EXIT.ERROR);
  return {
    result: { unit, log, command: line },
    text: `started ${unit}\n  log: ${log}\n  wait: waitfor --until '! systemctl --user is-active -q ${unit}' --every 1m --timeout 2h\n  result: systemctl --user show -p Result,ExecMainStatus ${unit}`
  };
}

// ---------------------------------------------------------------- doctor

function attributionSetting(root) {
  const files = [path.join(os.homedir(), '.claude', 'settings.json'), path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')];
  let off = null;
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (s.includeCoAuthoredBy === false || (isObj(s.attribution) && s.attribution.commit === '')) off = f;
      if (s.includeCoAuthoredBy === true || (isObj(s.attribution) && s.attribution.commit)) off = null;
    } catch { /* missing or unreadable */ }
  }
  return off;
}

function commandResolves(command, root) {
  const words = command.trim().split(/\s+/);
  const exe = words[0];
  if (!which(exe) && !fs.existsSync(path.resolve(root, exe))) return `${exe} not found on PATH`;
  for (const w of words.slice(1)) {
    if (/^[\w./-]+\.(py|sh|js|mjs|ts|rb|pl)$/.test(w) && !w.includes('{') && !fs.existsSync(path.resolve(root, expandHome(w)))) return `${w} not found`;
  }
  return null;
}

function cmdDoctor(opts) {
  const rows = [];
  const add = (level, what, msg) => rows.push({ level, what, msg });
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'OK' : 'ERROR', 'node', `v${process.versions.node}${major >= 22 ? '' : ' (needs 22+)'}`);
  const ghv = run('gh', ['--version'], { allowFail: true });
  if (ghv.status !== 0) { add('ERROR', 'gh', 'not found'); return finishDoctor(rows); }
  add('OK', 'gh', ghv.stdout.split('\n')[0]);
  // Exit code only: gh auth status output is never printed.
  const authed = run('gh', ['auth', 'status'], { allowFail: true }).status === 0;
  add(authed ? 'OK' : 'ERROR', 'gh auth', authed ? 'logged in' : 'not logged in: run gh auth login');
  const gv = run('git', ['--version'], { allowFail: true });
  add(gv.status === 0 ? 'OK' : 'ERROR', 'git', gv.status === 0 ? gv.stdout.trim() : 'not found');

  let ctx;
  try { ctx = context(opts); } catch (e) { add('ERROR', 'config', e.message); return finishDoctor(rows); }
  add('OK', 'repo', `${ctx.repo} at ${ctx.root}`);
  add('OK', 'config', ctx.configFile ? `${path.relative(ctx.root, ctx.configFile) || ctx.configFile} valid` : 'no .foreman.json, using defaults');

  const r = run('gh', ['label', 'list', ...ctx.R, '--limit', '1000', '--json', 'name'], { allowFail: true });
  if (r.status !== 0) add('ERROR', 'labels', `cannot list labels: ${r.stderr.trim().split('\n').pop()}`);
  else {
    const have = new Set(JSON.parse(r.stdout).map((l) => l.name));
    const missing = Object.entries(ctx.config.labels).filter(([, v]) => !have.has(v));
    if (!missing.length) add('OK', 'labels', `all ${Object.keys(ctx.config.labels).length} exist`);
    else if (!opts.fix) add('ERROR', 'labels', `missing ${missing.map(([, v]) => v).join(', ')} (doctor --fix creates them)`);
    else {
      for (const [k, v] of missing) gh(['label', 'create', v, ...ctx.R, '--color', LABEL_COLORS[k], '--description', LABEL_DESCRIPTIONS[k]]);
      add('OK', 'labels', `created ${missing.map(([, v]) => v).join(', ')}`);
    }
  }
  for (const key of ['check', 'land']) {
    if (!ctx.config[key]) { add(key === 'land' ? 'WARN' : 'OK', key, key === 'land' ? 'no land command: land merges on checks and findings alone' : 'none configured'); continue; }
    const bad = commandResolves(ctx.config[key], ctx.root);
    add(bad ? 'ERROR' : 'OK', key, bad || ctx.config[key]);
  }
  const lr = ctx.config.long_runs.trim().split(/\s+/)[0];
  add(which(lr) ? 'OK' : 'WARN', 'long_runs', which(lr) ? lr : `${lr} not found; run-long will fail on this host`);
  add(which('waitfor') ? 'OK' : 'WARN', 'waitfor', which('waitfor') ? 'found' : 'not found; the skill waits on capacity and land --gate with it');
  const attr = attributionSetting(ctx.root);
  add(attr ? 'OK' : 'WARN', 'attribution', attr ? `off in ${attr}` : 'Claude Code adds Co-Authored-By unless includeCoAuthoredBy is false or attribution.commit is ""');
  return finishDoctor(rows);
}

function finishDoctor(rows) {
  const bad = rows.some((r) => r.level === 'ERROR');
  return {
    code: bad ? EXIT.REFUSED : EXIT.OK,
    result: { ok: !bad, checks: rows },
    text: rows.map((r) => `[${r.level}] ${r.what}: ${r.msg}`).join('\n')
  };
}

// ---------------------------------------------------------------- scan

function cmdScan(ctx, opts) {
  const src = opts._[0];
  const text = !src || src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  const hits = scanText(text, ctx.config);
  return {
    code: hits.length ? EXIT.REFUSED : EXIT.OK,
    result: { clean: !hits.length, hits },
    text: hits.length ? hits.map((h) => `line ${h.line}: "${h.match}" in: ${h.text}`).join('\n') : 'clean'
  };
}

// ---------------------------------------------------------------- cli

const USAGE = `usage: foreman <command> [--json] [--repo OWNER/NAME] [--config FILE]
  doctor [--fix]                          gh, git, repo, config, labels, commands
  pick                                    the next ready issue, or why none is
  claim N --agent ID --branch B           claim an issue for an agent
  release N --to ${RELEASE_TARGETS.join('|')} --reason R
  stale [--retake [--keep TAG]]           claims with no push or comment for stale_claim_hours
  capacity [--local K]                    may a spawn start now (exit 0) or not (exit 1)
  brief N [--branch B] [--pr P]           the worker subagent's brief; --pr adds the open findings
  findings P                              the review app's findings on PR P
  land N --pr P --head SHA [--comment-file F] [--gate] [--trivial] [--decided-by-session]
  self-review P --findings N --fixed M --body FILE   record the session's review when the app is capped or unavailable
  revuto-ask P                            post a request for one more review round
  stats [--since DATE]                    caps hit, self-reviews, findings per self-review, manual requests
  status [--local K]                      counts, claims, quiet claims, capacity
  run-long --unit U --log L -- CMD...     start CMD as a transient systemd user unit
  scan [FILE|-]                           check text against comment_forbidden
exit: 0 done, 1 not now, 2 refused, 3 error`;

const BOOL = new Set(['json', 'fix', 'retake', 'gate', 'decided-by-session', 'trivial', 'help']);

function parseArgs(argv) {
  const opts = { _: [], cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts.cmd = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (BOOL.has(key)) { opts[key] = true; continue; }
      const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (val === undefined) throw new Refusal(`${a} needs a value`, EXIT.ERROR);
      opts[key] = val;
    } else opts._.push(a);
  }
  return opts;
}

function need(v, what) {
  if (v === undefined || v === null || v === '') throw new Refusal(`missing ${what}`, EXIT.ERROR);
  return v;
}

function needInt(v, what) {
  const s = String(need(v, what)).replace(/^#/, '');
  if (!/^\d+$/.test(s)) throw new Refusal(`${what} must be a number (got ${v})`, EXIT.ERROR);
  return Number(s);
}

const COMMANDS = {
  pick: cmdPick, claim: cmdClaim, release: cmdRelease, stale: cmdStale, capacity: cmdCapacity,
  brief: cmdBrief, findings: cmdFindings, land: cmdLand, status: cmdStatus, 'run-long': cmdRunLong, scan: cmdScan,
  'self-review': cmdSelfReview, 'revuto-ask': cmdRevutoAsk, stats: cmdStats
};

function main(argv) {
  let opts = { json: argv.includes('--json') };
  try {
    const [name, ...rest] = argv;
    opts = parseArgs(rest);
    if (!name || name === 'help' || name === '--help' || opts.help) { process.stdout.write(`${USAGE}\n`); return EXIT.OK; }
    let out;
    if (name === 'doctor') out = cmdDoctor(opts);
    else if (COMMANDS[name]) out = COMMANDS[name](context(opts), opts);
    else throw new Refusal(`unknown command: ${name}\n${USAGE}`, EXIT.ERROR);
    const code = out.code === undefined ? EXIT.OK : out.code;
    process.stdout.write(opts.json ? `${JSON.stringify({ ok: code === EXIT.OK, exit: code, ...out.result }, null, 2)}\n` : `${out.text}\n`);
    return code;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, exit: e.code, error: e.message, ...e.data }, null, 2)}\n`);
    else process.stderr.write(`[${e.code === EXIT.NOT_NOW ? 'WAIT' : e.code === EXIT.REFUSED ? 'REFUSED' : 'ERROR'}] ${e.message}\n`);
    return e.code;
  }
}

module.exports = { validateConfig, parseDepends, scanText, classifyChecks, stripAttribution, DEFAULTS, EXIT };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
