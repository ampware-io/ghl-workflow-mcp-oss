import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_VERSION } from './version.js';

describe('CURRENT_VERSION', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof CURRENT_VERSION, 'string');
    assert.ok(CURRENT_VERSION.length > 0, 'CURRENT_VERSION must not be empty');
  });

  it('matches a semver-like or dev-fallback shape', () => {
    // Accepts: 0.0.0-dev, 0.2.0, 1.0.0-beta.1, 2026.04.19
    assert.match(CURRENT_VERSION, /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/);
  });
});
