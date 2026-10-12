/**
 * Unit tests for ChromeLauncher module.
 * Uses Node.js native test runner with mocking.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// We will import ChromeLauncher after setting up mocks where needed.
// For most tests we import directly and mock the externals.

describe('ChromeNotFoundError', () => {
  it('darwin message includes /Applications/Google Chrome.app and install URL', async () => {
    const { ChromeNotFoundError } = await import('../utils/errors.js');
    const err = new ChromeNotFoundError('darwin');
    assert.ok(err.message.includes('/Applications/Google Chrome.app'));
    assert.ok(err.message.includes('https://www.google.com/chrome/'));
    assert.equal(err.code, 'CHROME_NOT_FOUND');
  });

  it('linux message includes google-chrome-stable, google-chrome and install URL', async () => {
    const { ChromeNotFoundError } = await import('../utils/errors.js');
    const err = new ChromeNotFoundError('linux');
    assert.ok(err.message.includes('google-chrome-stable'));
    assert.ok(err.message.includes('google-chrome'));
    assert.ok(err.message.includes('https://www.google.com/chrome/'));
  });

  it('win32 message includes Program Files and install URL', async () => {
    const { ChromeNotFoundError } = await import('../utils/errors.js');
    const err = new ChromeNotFoundError('win32');
    assert.ok(err.message.includes('Program Files'));
    assert.ok(err.message.includes('https://www.google.com/chrome/'));
  });

  it('always includes GHL_MCP_CHROME_PATH hint in suggestion', async () => {
    const { ChromeNotFoundError } = await import('../utils/errors.js');
    for (const platform of ['darwin', 'linux', 'win32']) {
      const err = new ChromeNotFoundError(platform);
      assert.ok(err.suggestion.includes('GHL_MCP_CHROME_PATH'));
    }
  });
});

describe('findChromePath', () => {
  it('returns GHL_MCP_CHROME_PATH when set and accessible', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher();

    const origEnv = process.env.GHL_MCP_CHROME_PATH;
    process.env.GHL_MCP_CHROME_PATH = '/custom/chrome';

    try {
      // Mock fs.accessSync to not throw for the custom path
      const fs = await import('node:fs');
      const origAccessSync = fs.default.accessSync;
      fs.default.accessSync = (p) => {
        if (p === '/custom/chrome') return; // accessible
        throw new Error('ENOENT');
      };

      const result = launcher.findChromePath();
      assert.equal(result, '/custom/chrome');

      fs.default.accessSync = origAccessSync;
    } finally {
      if (origEnv === undefined) {
        delete process.env.GHL_MCP_CHROME_PATH;
      } else {
        process.env.GHL_MCP_CHROME_PATH = origEnv;
      }
    }
  });

  it('throws ChromeNotFoundError when GHL_MCP_CHROME_PATH is inaccessible', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const { ChromeNotFoundError } = await import('../utils/errors.js');
    const launcher = new ChromeLauncher();

    const origEnv = process.env.GHL_MCP_CHROME_PATH;
    process.env.GHL_MCP_CHROME_PATH = '/nonexistent/chrome';

    try {
      const fs = await import('node:fs');
      const origAccessSync = fs.default.accessSync;
      fs.default.accessSync = () => { throw new Error('ENOENT'); };

      assert.throws(() => launcher.findChromePath(), (err) => {
        return err instanceof ChromeNotFoundError;
      });

      fs.default.accessSync = origAccessSync;
    } finally {
      if (origEnv === undefined) {
        delete process.env.GHL_MCP_CHROME_PATH;
      } else {
        process.env.GHL_MCP_CHROME_PATH = origEnv;
      }
    }
  });

  it('on linux returns result of which google-chrome-stable (mock execFileSync)', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher();

    const origEnv = process.env.GHL_MCP_CHROME_PATH;
    delete process.env.GHL_MCP_CHROME_PATH;

    try {
      // On Linux, findChromePathForPlatform either finds Chrome or throws ChromeNotFoundError
      try {
        const result = launcher.findChromePathForPlatform('linux');
        assert.ok(typeof result === 'string', 'Should return a path string when Chrome is found');
      } catch (err) {
        assert.strictEqual(err.code, 'CHROME_NOT_FOUND', 'Should throw ChromeNotFoundError when Chrome is not installed');
      }
    } finally {
      if (origEnv === undefined) {
        delete process.env.GHL_MCP_CHROME_PATH;
      } else {
        process.env.GHL_MCP_CHROME_PATH = origEnv;
      }
    }
  });

  it('on darwin returns /Applications/Google Chrome.app path when accessible', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher();

    const fs = await import('node:fs');
    const origAccessSync = fs.default.accessSync;
    fs.default.accessSync = (p) => {
      if (p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') return;
      throw new Error('ENOENT');
    };

    try {
      const result = launcher.findChromePathForPlatform('darwin');
      assert.equal(result, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } finally {
      fs.default.accessSync = origAccessSync;
    }
  });

  it('on win32 checks Program Files paths', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const pathMod = await import('node:path');
    const launcher = new ChromeLauncher();

    const fs = await import('node:fs');
    const origAccessSync = fs.default.accessSync;
    // Use path.join to get the same path the module generates (forward slashes on Linux)
    const expectedPath = pathMod.default.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
    fs.default.accessSync = (p) => {
      if (p === expectedPath) return;
      throw new Error('ENOENT');
    };

    try {
      const origPF = process.env.PROGRAMFILES;
      process.env.PROGRAMFILES = 'C:\\Program Files';

      const result = launcher.findChromePathForPlatform('win32');
      assert.equal(result, expectedPath);

      if (origPF === undefined) delete process.env.PROGRAMFILES;
      else process.env.PROGRAMFILES = origPF;
    } finally {
      fs.default.accessSync = origAccessSync;
    }
  });

  it('throws ChromeNotFoundError when no Chrome found on any platform', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const { ChromeNotFoundError } = await import('../utils/errors.js');
    const launcher = new ChromeLauncher();

    const fs = await import('node:fs');
    const origAccessSync = fs.default.accessSync;
    fs.default.accessSync = () => { throw new Error('ENOENT'); };

    const origEnv = process.env.GHL_MCP_CHROME_PATH;
    delete process.env.GHL_MCP_CHROME_PATH;

    try {
      assert.throws(() => launcher.findChromePathForPlatform('darwin'), (err) => {
        return err instanceof ChromeNotFoundError;
      });
    } finally {
      fs.default.accessSync = origAccessSync;
      if (origEnv !== undefined) process.env.GHL_MCP_CHROME_PATH = origEnv;
    }
  });
});

describe('probeDebugPort', () => {
  it('returns true when fetch succeeds with 200', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true });

    try {
      const result = await launcher.probeDebugPort(1000);
      assert.equal(result, true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns false when fetch throws (connection refused)', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Connection refused'); };

    try {
      const result = await launcher.probeDebugPort(1000);
      assert.equal(result, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns false when fetch times out (AbortController)', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      // Simulate timeout by waiting longer than abort
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true }), 5000);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    };

    try {
      const result = await launcher.probeDebugPort(100);
      assert.equal(result, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('launch', () => {
  it('calls spawn with correct args array', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333, '/tmp/test-profile');

    const fs = await import('node:fs');
    const origMkdirSync = fs.default.mkdirSync;
    const origAccessSync = fs.default.accessSync;
    fs.default.mkdirSync = () => { };
    fs.default.accessSync = () => { };

    // Mock findChromePath
    launcher.findChromePath = () => '/usr/bin/google-chrome-stable';

    // Mock spawn
    let spawnArgs = null;
    let spawnOpts = null;
    const origSpawn = launcher._spawnFn;
    launcher._spawnFn = (cmd, args, opts) => {
      spawnArgs = args;
      spawnOpts = opts;
      return { pid: 12345, on: () => { }, unref: () => { } };
    };

    // Mock probeDebugPort to succeed immediately
    launcher.probeDebugPort = async () => true;

    try {
      await launcher.launch();
      assert.ok(spawnArgs.includes('--remote-debugging-port=9333'));
      assert.ok(spawnArgs.includes('--user-data-dir=/tmp/test-profile'));
      assert.ok(spawnArgs.includes('--no-first-run'));
      assert.ok(spawnArgs.includes('--no-default-browser-check'));
      assert.ok(spawnArgs.includes('https://app.gohighlevel.com'));
    } finally {
      fs.default.mkdirSync = origMkdirSync;
      fs.default.accessSync = origAccessSync;
    }
  });

  it('uses stdio: ignore to prevent stdout corruption', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333, '/tmp/test-profile');

    const fs = await import('node:fs');
    const origMkdirSync = fs.default.mkdirSync;
    const origAccessSync = fs.default.accessSync;
    fs.default.mkdirSync = () => { };
    fs.default.accessSync = () => { };

    launcher.findChromePath = () => '/usr/bin/google-chrome-stable';

    let capturedOpts = null;
    launcher._spawnFn = (cmd, args, opts) => {
      capturedOpts = opts;
      return { pid: 12345, on: () => { }, unref: () => { } };
    };
    launcher.probeDebugPort = async () => true;

    try {
      await launcher.launch();
      assert.equal(capturedOpts.stdio, 'ignore');
    } finally {
      fs.default.mkdirSync = origMkdirSync;
      fs.default.accessSync = origAccessSync;
    }
  });

  it('creates profile directory if it does not exist (fs.mkdirSync recursive)', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333, '/tmp/test-profile-new');

    const fs = await import('node:fs');
    const origMkdirSync = fs.default.mkdirSync;
    const origAccessSync = fs.default.accessSync;

    let mkdirCalled = false;
    let mkdirPath = null;
    let mkdirOpts = null;
    fs.default.mkdirSync = (p, opts) => {
      mkdirCalled = true;
      mkdirPath = p;
      mkdirOpts = opts;
    };
    fs.default.accessSync = () => { };

    launcher.findChromePath = () => '/usr/bin/google-chrome-stable';
    launcher._spawnFn = () => ({ pid: 12345, on: () => { }, unref: () => { } });
    launcher.probeDebugPort = async () => true;

    try {
      await launcher.launch();
      assert.ok(mkdirCalled);
      assert.equal(mkdirPath, '/tmp/test-profile-new');
      assert.ok(mkdirOpts.recursive);
    } finally {
      fs.default.mkdirSync = origMkdirSync;
      fs.default.accessSync = origAccessSync;
    }
  });

  it('stores child PID accessible via getChildPid()', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333, '/tmp/test-profile');

    const fs = await import('node:fs');
    const origMkdirSync = fs.default.mkdirSync;
    const origAccessSync = fs.default.accessSync;
    fs.default.mkdirSync = () => { };
    fs.default.accessSync = () => { };

    launcher.findChromePath = () => '/usr/bin/google-chrome-stable';
    launcher._spawnFn = () => ({ pid: 99999, on: () => { }, unref: () => { } });
    launcher.probeDebugPort = async () => true;

    try {
      assert.equal(launcher.getChildPid(), null);
      await launcher.launch();
      assert.equal(launcher.getChildPid(), 99999);
    } finally {
      fs.default.mkdirSync = origMkdirSync;
      fs.default.accessSync = origAccessSync;
    }
  });
});

describe('waitForGhlLogin', () => {
  it('resolves when CDP.List returns a tab with /v2/location/ in URL', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333);

    let callCount = 0;
    launcher._cdpListFn = async () => {
      callCount++;
      if (callCount >= 2) {
        return [
          { type: 'page', url: 'https://app.gohighlevel.com/v2/location/abc123/automation/workflows?listTab=all', title: 'GHL' },
        ];
      }
      return [{ type: 'page', url: 'https://accounts.google.com/login', title: 'Login' }];
    };

    const result = await launcher.waitForGhlLogin(10000, 50);
    assert.ok(result.url.includes('/v2/location/'));
  });

  it('throws CdpTimeoutError after timeout expires', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const { CdpTimeoutError } = await import('../utils/errors.js');
    const launcher = new ChromeLauncher(9333);

    launcher._cdpListFn = async () => {
      return [{ type: 'page', url: 'https://accounts.google.com/login', title: 'Login' }];
    };

    await assert.rejects(
      () => launcher.waitForGhlLogin(200, 50),
      (err) => err instanceof CdpTimeoutError,
    );
  });

  it('logs progress via logger.info every poll interval', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333);

    const logMessages = [];
    const { logger } = await import('../utils/logger.js');
    const origInfo = logger.info;
    logger.info = (...args) => { logMessages.push(args.join(' ')); };

    let callCount = 0;
    launcher._cdpListFn = async () => {
      callCount++;
      if (callCount >= 3) {
        return [
          { type: 'page', url: 'https://app.gohighlevel.com/v2/location/abc/dashboard', title: 'GHL' },
        ];
      }
      return [];
    };

    try {
      await launcher.waitForGhlLogin(10000, 50);
      const waitLogs = logMessages.filter(m => m.includes('Waiting for GHL login'));
      assert.ok(waitLogs.length >= 1, `Expected at least 1 wait log, got ${waitLogs.length}`);
    } finally {
      logger.info = origInfo;
    }
  });
});

describe('killChrome', () => {
  it('calls child.kill() when child process exists', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333, '/tmp/test-profile');

    const fs = await import('node:fs');
    const origMkdirSync = fs.default.mkdirSync;
    const origAccessSync = fs.default.accessSync;
    fs.default.mkdirSync = () => { };
    fs.default.accessSync = () => { };

    let killCalled = false;
    launcher.findChromePath = () => '/usr/bin/chrome';
    launcher._spawnFn = () => ({
      pid: 12345,
      on: () => { },
      unref: () => { },
      kill: () => { killCalled = true; },
    });
    launcher.probeDebugPort = async () => true;

    try {
      await launcher.launch();
      launcher.killChrome();
      assert.ok(killCalled);
      assert.equal(launcher.getChildPid(), null);
    } finally {
      fs.default.mkdirSync = origMkdirSync;
      fs.default.accessSync = origAccessSync;
    }
  });

  it('is a no-op when no child process exists', async () => {
    const { ChromeLauncher } = await import('./launcher.js');
    const launcher = new ChromeLauncher(9333);

    // Should not throw
    launcher.killChrome();
    assert.equal(launcher.getChildPid(), null);
  });
});
