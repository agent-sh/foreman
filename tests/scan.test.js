'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanText, DEFAULTS } = require('../scripts/foreman');

const config = (allowed) => ({ ...DEFAULTS, comment_allowed: allowed });

test('scan: an allowed phrase wrapped across a line break is still allowed', () => {
  const text = "Restart the unit from the user\nmanager's control directory.";
  assert.deepEqual(scanText(text, config(["user manager's control directory"])), []);
});

test('scan: the forbidden word outside the allowed phrase is still found, on its own line', () => {
  const text = 'Fix the drift.\nAsk the manager first.\nthe user\nmanager is fine';
  const hits = scanText(text, config(['user manager']));
  assert.deepEqual(hits.map((h) => [h.line, h.match]), [[2, 'manager']]);
});
