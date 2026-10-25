'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, issue } = require('./helpers');

test('config: no file gives the default labels and caps', () => {
  const t = setup({ fixture: { issues: [issue(1, { labels: ['status:in-progress'] })] } });
  const r = t.run(['capacity', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.json.claims, r.json.agents_max, r.json.load_hold, r.json.mem_min_gb], [1, 6, 20, 4]);
});

test('config: a partial file merges over the defaults', () => {
  const t = setup({
    config: { labels: { ready: 'todo' }, agents_max: 2 },
    fixture: { labels: ['todo', 'status:in-progress'], issues: [issue(1, { labels: ['todo'] }), issue(2, { labels: ['status:in-progress'] })] }
  });
  assert.equal(t.run(['pick', '--json']).json.picked.number, 1);
  const cap = t.run(['capacity', '--local', '1', '--json']);
  assert.equal(cap.code, 1);
  assert.equal(cap.json.agents_max, 2);
  assert.equal(cap.json.claims, 1, 'labels.in_progress keeps its default');
});

test('config: errors name the key; unknown keys and bad values are refused', () => {
  const cases = [
    [{ agent_max: 6 }, /agent_max is not a foreman key/],
    [{ labels: { redy: 'x' } }, /labels\.redy is not a foreman key/],
    [{ agents_max: '6' }, /agents_max must be an integer >= 1 \(got "6"\)/],
    [{ load_hold: '20' }, /load_hold must be a number > 0 \(got "20"\)/],
    [{ depends_pattern: 'Depends on: .*' }, /depends_pattern needs one capture group/],
    [{ branch_pattern: '^Branch: .*' }, /branch_pattern needs one capture group/],
    [{ comment_forbidden: '(' }, /comment_forbidden is not a valid regex/],
    [{ review: { rounds_max: 0 } }, /review\.rounds_max must be an integer >= 1/],
    [{ long_runs: 'sh -c {cmd}' }, /long_runs must contain \{unit\}, \{cmd\} and \{log\}/],
    [{ merge_admin: 'yes' }, /merge_admin must be true or false/],
    [{ allow_no_checks: 1 }, /allow_no_checks must be true or false/],
    [{ cpu_pressure_hold: 120 }, /cpu_pressure_hold must be a number from 0 to 100/],
    ['{ not json', /not valid JSON/]
  ];
  for (const [config, want] of cases) {
    const r = setup({ config }).run(['pick']);
    assert.equal(r.code, 3, `${JSON.stringify(config)}: ${r.stderr}`);
    assert.match(r.stderr, want);
  }
});
