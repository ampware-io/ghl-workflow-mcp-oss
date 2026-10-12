/**
 * Entry-point tests for src/index.js.
 *
 * Uses the subprocess-spawn pattern: src/index.js is the process entry, so
 * exit codes and stdout/stderr routing only show up in a real child process.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_VERSION } from './version.js';

const ENTRY = join(process.cwd(), 'src/index.js');

describe('src/index.js entry point', () => {
  it('--version writes CURRENT_VERSION to stdout and exits 0', () => {
    const r = spawnSync('node', [ENTRY, '--version'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.equal(r.stdout, `${CURRENT_VERSION}\n`);
    assert.equal(r.stderr, '');
  });

  it('has no licence bootstrap, update check or setup wizard', () => {
    const source = readFileSync(ENTRY, 'utf8');
    assert.doesNotMatch(source, /license/i);
    assert.doesNotMatch(source, /update-check/);
    assert.doesNotMatch(source, /\.\/setup\//);
  });

  it('no arguments → main() bootstraps without Chrome', { timeout: 10000 }, async () => {
    // Either "server started" (stdio transport connected) or "No debug Chrome
    // detected" (main() got past the Chrome probe) proves main() ran.
    const child = spawn('node', [ENTRY], {
      env: { ...process.env, GHL_MCP_CDP_PORT: '49299' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    child.stderr.on('data', (d) => {
      stderrBuf += String(d);
    });
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGINT');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.ok(
      /GHL Workflow MCP server started/.test(stderrBuf) ||
        /No debug Chrome detected/.test(stderrBuf),
      `expected main() startup output in stderr. Got: ${stderrBuf.slice(0, 500)}`,
    );
  });
});
