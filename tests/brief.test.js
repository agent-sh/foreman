'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, issue, ago, claimBody, SIGNED } = require('./helpers');

const bot = { login: 'revuto-review' };
const thread = (id, text, over = {}) => ({
  isResolved: false, isOutdated: false, path: 'src/a.js', line: id, originalLine: id,
  comments: [{ databaseId: id, author: bot, body: `${SIGNED}\n\n---\n\n${text}`, createdAt: ago(1), pullRequestReview: { databaseId: 1 } }], ...over
});

test('brief: acceptance section, claim branch, check command, why it came back, and only the open findings', () => {
  const body = 'Intro.\n\n## Acceptance\n\n- the gauge reports writers\n\n## Brief\n\nDo the thing.';
  const t = setup({
    config: { check: 'python3 tools/check.py' },
    fixture: {
      issues: [issue(5, {
        labels: ['status:in-progress'], body,
        comments: [
          { createdAt: ago(9), body: claimBody('a1', 'foreman/5', ago(9)) },
          { createdAt: ago(8), body: '<!-- foreman:release {"to":"rework"} -->\nMoved to status:rework: the gauge never resets' },
          { createdAt: ago(7), body: claimBody('a2', 'foreman/5', ago(7)) }
        ]
      })],
      prs: [{ number: 9, state: 'OPEN', headRefOid: 'a'.repeat(40), headCommittedDate: ago(2), comments: [], reviews: [{ databaseId: 1, author: bot, body: SIGNED, submittedAt: ago(1), commit: { oid: 'a'.repeat(40) } }], checkRuns: [],
        reviewThreads: [thread(3, '[P1] Reset is never called.'), thread(4, '[P2] Old.', { isOutdated: true })] }]
    }
  });
  const r = t.run(['brief', '5', '--pr', '9']);
  assert.equal(r.code, 0, r.stderr);
  const b = r.stdout;
  assert.match(b, /## Acceptance \(done means every item holds\)\n- the gauge reports writers\n\n## Issue body/);
  assert.match(b, /git push origin HEAD:refs\/heads\/foreman\/5/);
  assert.match(b, /run `python3 tools\/check\.py`/);
  assert.match(b, /## Why it came back\nMoved to status:rework: the gauge never resets/);
  assert.match(b, /- P1 src\/a\.js:3: \[P1\] Reset is never called\./);
  assert.doesNotMatch(b, /Old\./);
  assert.match(b, /Name merges plainly: `git merge -m "Merge origin\/main" origin\/main`/);

  assert.equal(setup({ fixture: { issues: [issue(6)] } }).run(['brief', '6']).code, 2, 'no claim, no brief');
});
