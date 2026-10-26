#!/usr/bin/env node
'use strict';
// Fake gh: serves and mutates the JSON fixture at $FAKE_FIXTURE.
// It implements only the calls foreman makes, and logs every call to fixture.calls.

const fs = require('node:fs');

const file = process.env.FAKE_FIXTURE;
const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
fx.calls = fx.calls || [];
const stdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const now = () => new Date().toISOString();

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function flags(name) {
  const out = [];
  argv.forEach((a, i) => { if (a === name) out.push(argv[i + 1]); });
  return out;
}
function save() { fs.writeFileSync(file, JSON.stringify(fx, null, 2)); }
function out(v) { process.stdout.write(`${JSON.stringify(v)}\n`); }
function fail(msg, code = 1) { process.stderr.write(`${msg}\n`); save(); process.exit(code); }
function pick(obj, fields) {
  const o = {};
  for (const f of fields.split(',')) o[f] = obj[f] === undefined ? null : obj[f];
  return o;
}
const issue = (n) => fx.issues.find((i) => i.number === Number(n)) || fail(`issue ${n} not found`);
const pr = (n) => fx.prs.find((p) => p.number === Number(n)) || fail(`pull request ${n} not found`);

function issueView(i) {
  return {
    ...i,
    labels: i.labels.map((name) => ({ name })),
    assignees: (i.assignees || []).map((login) => ({ login })),
    comments: (i.comments || []).map((c) => ({ author: { login: c.author || fx.user }, body: c.body, createdAt: c.createdAt })),
    url: `https://github.com/${fx.repo}/issues/${i.number}`
  };
}

function rollup(p) {
  return (p.checkRuns || []).map((c) => ({ __typename: 'CheckRun', name: c.name, status: c.status, conclusion: c.conclusion || '' }));
}

const [a0, a1] = argv;
fx.calls.push(argv.filter((a) => !a.startsWith('query=')).join(' '));

if (a0 === '--version') { process.stdout.write('gh version 2.99.0 (fake)\n'); save(); process.exit(0); }
if (a0 === 'auth' && a1 === 'status') { save(); process.exit(fx.auth === false ? 1 : 0); }
if (a0 === 'repo' && a1 === 'view') { out({ nameWithOwner: fx.repo }); save(); process.exit(0); }

if (a0 === 'label' && a1 === 'list') { out(fx.labels.map((name) => ({ name }))); save(); process.exit(0); }
if (a0 === 'label' && a1 === 'create') {
  if (fx.labels.includes(argv[2])) fail(`label "${argv[2]}" already exists`);
  fx.labels.push(argv[2]);
  save(); process.exit(0);
}

if (a0 === 'issue' && a1 === 'list') {
  const state = flag('--state') || 'open';
  const label = flag('--label');
  const rows = fx.issues
    .filter((i) => state === 'all' || i.state.toLowerCase() === state)
    .filter((i) => !label || i.labels.includes(label))
    .map((i) => pick(issueView(i), flag('--json')));
  out(rows); save(); process.exit(0);
}
if (a0 === 'issue' && a1 === 'view') { out(pick(issueView(issue(argv[2])), flag('--json'))); save(); process.exit(0); }
if (a0 === 'issue' && a1 === 'edit') {
  const i = issue(argv[2]);
  for (const l of flags('--remove-label').flatMap((s) => s.split(','))) {
    if (!i.labels.includes(l)) fail(`label ${l} not on issue`);
    i.labels = i.labels.filter((x) => x !== l);
  }
  for (const l of flags('--add-label').flatMap((s) => s.split(','))) {
    if (!fx.labels.includes(l)) fail(`'${l}' not found`);
    if (!i.labels.includes(l)) i.labels.push(l);
  }
  for (const a of flags('--add-assignee')) { const who = a === '@me' ? fx.user : a; i.assignees = [...new Set([...(i.assignees || []), who])]; }
  for (const a of flags('--remove-assignee').flatMap((s) => s.split(','))) i.assignees = (i.assignees || []).filter((x) => x !== a);
  save(); process.exit(0);
}
if (a0 === 'issue' && a1 === 'comment') {
  const i = issue(argv[2]);
  const body = stdin();
  i.comments = i.comments || [];
  // A racing session posts its claim a moment before ours.
  if (fx.raceClaim && body.includes('foreman:claim')) {
    const r = fx.raceClaim; delete fx.raceClaim;
    i.comments.push({ author: fx.user, createdAt: now(), body: `<!-- foreman:claim ${JSON.stringify({ agent: r.agent, branch: r.branch, at: now() })} -->` });
  }
  i.comments.push({ author: fx.user, body, createdAt: now() });
  save(); process.exit(0);
}
if (a0 === 'issue' && a1 === 'close') { issue(argv[2]).state = 'CLOSED'; save(); process.exit(0); }

if (a0 === 'pr' && a1 === 'view') {
  const p = pr(argv[2]);
  const view = { ...p, url: `https://github.com/${fx.repo}/pull/${p.number}`, statusCheckRollup: rollup(p) };
  // A push during the land check: the second view shows the new head.
  if (fx.headMovesTo && fx.prViews === undefined) fx.prViews = 0;
  if (fx.headMovesTo && ++fx.prViews > 1) view.headRefOid = fx.headMovesTo;
  out(pick(view, flag('--json'))); save(); process.exit(0);
}
if (a0 === 'pr' && a1 === 'comment') {
  const p = pr(argv[2]);
  p.comments = p.comments || [];
  p.comments.push({ author: { login: fx.user }, body: stdin(), createdAt: now() });
  save(); process.exit(0);
}
if (a0 === 'pr' && a1 === 'merge') {
  const p = pr(argv[2]);
  if (flag('--match-head-commit') !== p.headRefOid) fail('head commit does not match');
  p.state = 'MERGED';
  p.mergeCommit = { oid: 'f00dfeed'.padEnd(40, '0') };
  fx.merged = { pr: p.number, subject: flag('--subject'), body: stdin(), args: argv.slice(1) };
  save(); process.exit(0);
}

if (a0 === 'api' && a1 === 'graphql') {
  const query = (argv.find((a) => a.startsWith('query=')) || '').slice(6);
  const vars = {};
  argv.forEach((a, i) => { if ((a === '-f' || a === '-F') && !argv[i + 1].startsWith('query=')) { const [k, ...v] = argv[i + 1].split('='); vars[k] = v.join('='); } });
  const fakeState = (repo, n) => {
    const all = [...fx.issues.map((i) => ({ ...i, repo: i.repo || fx.repo, kind: 'Issue' })), ...fx.prs.map((p) => ({ ...p, repo: p.repo || fx.repo, kind: 'PullRequest' }))];
    const x = all.find((i) => i.repo === repo && i.number === n);
    if (!x) return null;
    return x.kind === 'Issue' ? { __typename: 'Issue', state: x.state } : { __typename: 'PullRequest', state: x.state, merged: x.state === 'MERGED' };
  };
  if (query.includes('issueOrPullRequest')) {
    const data = {};
    const heads = [...query.matchAll(/(r\d+): repository\(owner:"([^"]+)",name:"([^"]+)"\)/g)];
    for (const [k, m] of heads.entries()) {
      const [, alias, o, n] = m;
      const body = query.slice(m.index, k + 1 < heads.length ? heads[k + 1].index : query.length);
      data[alias] = {};
      for (const [, num] of body.matchAll(/i(\d+): issueOrPullRequest/g)) data[alias][`i${num}`] = fakeState(`${o}/${n}`, Number(num));
    }
    out({ data }); save(); process.exit(0);
  }
  if (query.includes('closedByPullRequestsReferences')) {
    const repo = {};
    repo.prs = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: fx.prs.filter((p) => p.state === 'OPEN').map((p) => {
      const head = p.headRepository === undefined ? fx.repo : p.headRepository;
      const node = { number: p.number, headRefName: p.headRefName };
      if (/\bheadRepository\s*\{\s*nameWithOwner\s*\}/.test(query)) node.headRepository = head && { nameWithOwner: head };
      if (query.includes('isCrossRepository')) node.isCrossRepository = head !== fx.repo;
      return node;
    }) };
    for (const [, n] of query.matchAll(/c(\d+): issue\(number:/g)) {
      const i = issue(n);
      repo[`c${n}`] = {
        closedByPullRequestsReferences: { nodes: fx.prs.filter((p) => (p.closes || []).includes(Number(n)) && p.state === 'OPEN').map((p) => ({ number: p.number, state: p.state })) },
        comments: { nodes: (i.comments || []).map((c) => ({ body: c.body })) }
      };
    }
    out({ data: { repository: repo } }); save(); process.exit(0);
  }
  if (query.includes('reviewThreads')) {
    const p = pr(vars.pr);
    out({
      data: {
        repository: {
          pullRequest: {
            headRefOid: p.headRefOid,
            commits: { nodes: [{ commit: { oid: p.headRefOid, committedDate: p.headCommittedDate, checkSuites: { nodes: checkSuites(p) } } }] },
            reviews: { nodes: p.reviews || [] },
            comments: { nodes: p.comments || [] },
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: (p.reviewThreads || []).map((t) => ({ ...t, comments: { nodes: t.comments } })) }
          }
        }
      }
    });
    save(); process.exit(0);
  }
  if (query.includes('parents{totalCount}')) {
    // A PR's commits with their parent counts; a fixture commit sets parents (default 1).
    const p = pr(vars.pr);
    const nodes = (p.commits || []).map((c) => ({ commit: { oid: c.oid, messageHeadline: c.messageHeadline, messageBody: c.messageBody || '', parents: { totalCount: c.parents || 1 } } }));
    out({ data: { repository: { pullRequest: { commits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } }); save(); process.exit(0);
  }
  if (query.includes('search(')) {
    const since = /updated:>=(\S+)/.exec(vars.q);
    const nodes = fx.prs.filter((p) => !since || (p.updatedAt || '9999') >= since[1]).map((p) => ({
      number: p.number,
      comments: { nodes: p.comments || [] },
      reviews: { nodes: p.reviews || [] },
      commits: { nodes: [{ commit: { checkSuites: { nodes: checkSuites(p) } } }] }
    }));
    out({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }); save(); process.exit(0);
  }
  fail(`fake gh: unknown graphql query: ${query.slice(0, 80)}`, 3);
}

function checkSuites(p) {
  const bySlug = new Map();
  for (const c of p.checkRuns || []) {
    const slug = c.app || 'github-actions';
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push({ name: c.name, status: c.status, conclusion: c.conclusion || null, title: c.title || null, summary: c.summary || null });
  }
  return [...bySlug].map(([slug, runs]) => ({ app: { slug }, checkRuns: { nodes: runs } }));
}

if (a0 === 'api' && /^repos\/[^/]+\/[^/]+\/branches\//.test(a1)) {
  const b = decodeURIComponent(a1.split('/branches/')[1]);
  const br = (fx.branches || {})[b];
  if (!br) fail('gh: Branch not found (HTTP 404)');
  out({ name: b, commit: { sha: br.sha || 'abc', commit: { committer: { date: br.date } } } }); save(); process.exit(0);
}

fail(`fake gh: unsupported call: ${argv.join(' ')}`, 3);
