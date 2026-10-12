/**
 * Chrome Lifecycle Manager for the GHL Workflow MCP server.
 *
 * Handles cross-platform Chrome binary discovery, CDP debug port probing,
 * Chrome process spawning with persistent profile, and GHL login wait polling.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import CDP from 'chrome-remote-interface';
import { logger } from '../utils/logger.js';
import { ChromeNotFoundError, CdpTimeoutError } from '../utils/errors.js';

/**
 * Manages Chrome lifecycle: find, probe, launch, wait for login, kill.
 */
export class ChromeLauncher {
  /** @type {number} */
  _port;

  /** @type {string} */
  _profileDir;

  /** @type {import('node:child_process').ChildProcess | null} */
  _child = null;

  /**
   * Spawn function - exposed as instance property for testability.
   * @type {typeof spawn}
   */
  _spawnFn = spawn;

  /**
   * CDP.List function - exposed as instance property for testability.
   * @type {Function}
   */
  _cdpListFn = (opts) => CDP.List({ host: '127.0.0.1', ...opts });

  /**
   * @param {number} [port=49222] - Chrome remote debugging port
   * @param {string|null} [profileDir=null] - Chrome user data directory (defaults to ~/.ghl-wkfl-mcp/chrome-profile)
   */
  constructor(port = 49222, profileDir = null) {
    this._port = port;
    this._profileDir = profileDir || path.join(os.homedir(), '.ghl-wkfl-mcp', 'chrome-profile');
  }

  /**
   * Find Chrome binary path, checking GHL_MCP_CHROME_PATH env var first,
   * then platform-specific default locations.
   *
   * @returns {string} Path to Chrome executable
   * @throws {ChromeNotFoundError} When Chrome cannot be found
   */
  findChromePath() {
    // Check env var override first
    const envPath = process.env.GHL_MCP_CHROME_PATH;
    if (envPath) {
      try {
        fs.accessSync(envPath, fs.constants.X_OK);
        return envPath;
      } catch {
        throw new ChromeNotFoundError(
          `GHL_MCP_CHROME_PATH is set to "${envPath}" but the file is not executable or does not exist.`
        );
      }
    }

    return this.findChromePathForPlatform(process.platform);
  }

  /**
   * Find Chrome binary for a specific platform. Separated for testability.
   *
   * @param {string} platform - 'darwin', 'win32', or 'linux'
   * @returns {string} Path to Chrome executable
   * @throws {ChromeNotFoundError} When Chrome cannot be found
   */
  findChromePathForPlatform(platform) {
    const candidates = this._getCandidates(platform);

    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Try next candidate
      }
    }

    // On linux, also try `which` commands
    if (platform === 'linux') {
      for (const bin of ['google-chrome-stable', 'google-chrome']) {
        try {
          const result = execFileSync('which', [bin], { stdio: 'pipe' }).toString().trim();
          if (result) {
            fs.accessSync(result, fs.constants.X_OK);
            return result;
          }
        } catch {
          // Try next
        }
      }
    }

    throw new ChromeNotFoundError(platform);
  }

  /**
   * Get platform-specific Chrome binary candidates.
   *
   * @param {string} platform
   * @returns {string[]}
   */
  _getCandidates(platform) {
    if (platform === 'darwin') {
      return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    }

    if (platform === 'win32') {
      const candidates = [];
      const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
      const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env.LOCALAPPDATA || '';

      candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      if (localAppData) {
        candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      }
      return candidates;
    }

    // linux - path candidates (which-based search handled separately)
    return [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
  }

  /**
   * Probe whether Chrome's debug port is listening.
   *
   * @param {number} [timeoutMs=3000] - Probe timeout in milliseconds
   * @returns {Promise<boolean>} true if port responds, false otherwise
   */
  async probeDebugPort(timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`http://127.0.0.1:${this._port}/json/version`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Launch Chrome with remote debugging enabled and a persistent profile.
   *
   * @throws {ChromeNotFoundError} When Chrome binary cannot be found
   * @throws {Error} When Chrome fails to start or CDP never becomes available
   */
  async launch() {
    fs.mkdirSync(this._profileDir, { recursive: true });

    // Self-heal: clear any orphan Chrome holding our profile lock from a prior crash
    // or unclean exit. Without this, Chrome detects the lock, hands the URL to the
    // orphan process (which has no --remote-debugging-port), and exits silently —
    // leaving probeDebugPort to spin for 120s.
    await this._ensureCleanProfile();

    const chromePath = this.findChromePath();

    const args = [
      `--remote-debugging-port=${this._port}`,
      `--user-data-dir=${this._profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://app.gohighlevel.com',
    ];

    // Spawn Chrome - stdio MUST be 'ignore' to prevent MCP stdout corruption
    const child = this._spawnFn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
    });

    this._child = child;

    child.on('exit', (code) => {
      logger.warn(`Chrome process exited with code ${code}`);
      this._child = null;
    });

    logger.info(`Launched Chrome (PID: ${child.pid}) on port ${this._port}`);

    // Wait for CDP to become available. Budget: maxAttempts * (probe + sleep) = 40 * 3s = 120s.
    // Slower Windows boxes and cold-start anti-malware scans can make Chrome's first paint
    // take well over 30s; 120s gives comfortable headroom before we give up.
    // If the spawned process exits before the port binds, fail fast with a clear error
    // instead of polling silently for 120s.
    const maxAttempts = 40;
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.probeDebugPort(2000)) {
        return;
      }
      if (this._child === null) {
        throw new Error(
          `Chrome exited before binding debug port ${this._port}. ` +
          `Likely causes: another Chrome process is holding the profile lock at ${this._profileDir} ` +
          `(self-heal couldn't kill it — try closing all Chrome windows manually), ` +
          `or Chrome was blocked from starting by antivirus / security software.`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new CdpTimeoutError(`CDP debug port ${this._port} after launch`, maxAttempts * 3000);
  }

  /**
   * Detect and clear any orphan Chrome process / stale lock files holding our
   * dedicated profile directory. Without this, Chrome on Windows will detect the
   * existing lock, hand off the URL to the orphan process (which lacks the
   * --remote-debugging-port flag), and exit silently — making it appear that
   * "Chrome launched fine, but the port never opens."
   *
   * Strategy:
   *   1. Try to remove Singleton* lock files. If they unlink cleanly, no live
   *      process holds them — we're done.
   *   2. If unlink fails (EBUSY/EPERM on Windows), a live Chrome owns our
   *      profile. Kill it via platform-specific process search, then retry
   *      the unlink.
   */
  async _ensureCleanProfile() {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    let needsKill = false;

    for (const name of lockFiles) {
      const p = path.join(this._profileDir, name);
      if (!fs.existsSync(p)) continue;
      try {
        fs.unlinkSync(p);
        logger.info(`Removed stale lock file: ${name}`);
      } catch {
        needsKill = true;
      }
    }

    if (!needsKill) return;

    logger.info('Profile is locked by an orphan Chrome process — killing it');
    this._killOrphanChromeProcesses();

    // Brief pause so the OS releases file handles before we retry the unlink
    await new Promise((r) => setTimeout(r, 500));

    for (const name of lockFiles) {
      const p = path.join(this._profileDir, name);
      if (!fs.existsSync(p)) continue;
      try {
        fs.unlinkSync(p);
      } catch (err) {
        logger.warn(`Could not remove ${name} after orphan kill: ${err.message}`);
      }
    }
  }

  /**
   * Kill any chrome / chromium process whose command line includes our
   * --user-data-dir. Scoped to our profile dir, so it never touches the user's
   * normal Chrome session.
   *
   * Uses platform-native process listing because Node has no cross-platform API
   * for "list processes with command line."
   */
  _killOrphanChromeProcesses() {
    const profileDir = this._profileDir;
    try {
      if (process.platform === 'win32') {
        // PowerShell exposes Win32_Process.CommandLine via CIM. Filter to chrome.exe
        // processes whose command line contains our profile dir, then Stop-Process -Force.
        const psPath = profileDir.replace(/'/g, "''");
        const cmd =
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*--user-data-dir=${psPath}*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
          stdio: 'ignore',
          timeout: 10000,
        });
      } else {
        // pgrep -f matches the full command line. Works on macOS and Linux.
        const out = execFileSync('pgrep', ['-f', `--user-data-dir=${profileDir}`], {
          encoding: 'utf8',
          timeout: 5000,
        });
        const pids = out.trim().split('\n').filter(Boolean);
        for (const pidStr of pids) {
          const pid = parseInt(pidStr, 10);
          if (!Number.isNaN(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
          }
        }
      }
    } catch {
      // No matching processes found, or the platform tool isn't available.
      // Either way, fall through — the lock-file unlink retry will surface
      // a clearer error if the lock is truly stuck.
    }
  }

  /**
   * Poll CDP until a GHL tab shows the user is logged in (URL contains /v2/location/).
   *
   * @param {number} [timeoutMs=300000] - Maximum wait time (default 5 minutes)
   * @param {number} [intervalMs=3000] - Poll interval
   * @returns {Promise<object>} The matching CDP target
   * @throws {CdpTimeoutError} When timeout expires without finding a logged-in tab
   */
  async waitForGhlLogin(timeoutMs = 300000, intervalMs = 3000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info(`Waiting for GHL login... (${elapsed}s elapsed)`);

      try {
        const targets = await this._cdpListFn({ port: this._port });
        const ghlTab = targets.find(
          (t) =>
            t.type === 'page' &&
            /(gohighlevel\.com|leadconnectorhq\.com)/.test(t.url) &&
            t.url.includes('/v2/location/'),
        );

        if (ghlTab) {
          logger.info('GHL login detected:', ghlTab.url);
          return ghlTab;
        }
      } catch {
        // CDP not ready yet or connection error - keep polling
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new CdpTimeoutError('GHL login', timeoutMs);
  }

  /**
   * Get the PID of the spawned Chrome child process.
   *
   * @returns {number|null} Child process PID or null if not launched
   */
  getChildPid() {
    return this._child ? this._child.pid : null;
  }

  /**
   * Kill the spawned Chrome child process.
   * No-op if no child process exists.
   */
  killChrome() {
    if (this._child) {
      this._child.kill();
      this._child = null;
    }
  }
}
