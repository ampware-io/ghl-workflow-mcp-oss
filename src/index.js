#!/usr/bin/env node

/**
 * Entry point for the GHL Workflow MCP server.
 *
 * Parses CLI arguments, sets up global error handlers (stderr only),
 * bootstraps the CDP connection, token manager, API client, and MCP server,
 * then connects via stdio transport.
 *
 * Bootstrap flow: probe for existing debug Chrome -> connect immediately if found,
 * otherwise start server without Chrome and let the launch_chrome tool handle it.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setVerbose, logger } from './utils/logger.js';
import { CdpConnectionManager } from './cdp/connection.js';
import { TokenManager } from './cdp/token.js';
import { GhlApiClient } from './api/client.js';
import { ChromeLauncher } from './chrome/launcher.js';
import { createServer } from './server.js';
import { CURRENT_VERSION } from './version.js';

// --- --version flag: runs before any CDP / Chrome / SDK startup cost ---
if (process.argv.includes('--version')) {
  // The ONE sanctioned stdout write (RESEARCH.md line 423). We exit before
  // StdioServerTransport is constructed, so no MCP client is listening on
  // stdout — this cannot corrupt the JSON-RPC pipe.
  process.stdout.write(`${CURRENT_VERSION}\n`);
  process.exit(0);
}

// --- CLI argument parsing ---
const args = process.argv.slice(2);

// --port <number> | GHL_MCP_CDP_PORT env var | default 49222
// Note: 9222 is the de-facto default for Chrome's debug port and is heavily contested
// on dev machines (puppeteer, playwright, devtools tutorials, every other CDP tool).
// We default to 49222 (in the IANA dynamic/private range) to dodge those collisions.
let cdpPort = 49222;
const portIndex = args.indexOf('--port');
if (portIndex !== -1 && args[portIndex + 1]) {
  const parsed = parseInt(args[portIndex + 1], 10);
  if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
    cdpPort = parsed;
  } else {
    logger.error(`Invalid --port value "${args[portIndex + 1]}", using default ${cdpPort}`);
  }
} else if (process.env.GHL_MCP_CDP_PORT) {
  const parsed = parseInt(process.env.GHL_MCP_CDP_PORT, 10);
  if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
    cdpPort = parsed;
  }
}

// --verbose flag
if (args.includes('--verbose')) {
  setVerbose(true);
}

// --no-kill-chrome-on-exit flag
const noKillOnExit = args.includes('--no-kill-chrome-on-exit');

// --- Global error handlers (stderr only, per INFR-01) ---
// Note: uncaughtException handler is registered inside main() so it can
// clean up launcher/cdp. unhandledRejection stays at module level.
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection:', err);
  process.exit(1);
});

// --- Bootstrap ---
async function main() {
  // 1. Create CDP connection manager and Chrome launcher
  const cdp = new CdpConnectionManager(cdpPort);
  const launcher = new ChromeLauncher(cdpPort);

  // Register uncaughtException handler now that launcher/cdp are available
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err.message);
    // Best-effort cleanup before exit
    try { if (launcher.getChildPid()) launcher.killChrome(); } catch { }
    try { cdp.disconnect(); } catch { }
    process.exit(1);
  });

  // 2. Probe for existing debug Chrome (LIFE-02, D-17)
  const chromeRunning = await launcher.probeDebugPort();

  // 3. Mutable state -- initialized now if Chrome running, or later via launch_chrome tool
  let tokenManager = null;
  let apiClient = null;
  let locationId = null;

  if (chromeRunning) {
    // Chrome already running with debug port -- connect immediately (D-07, D-17)
    logger.info('Found Chrome with debug port, connecting...');
    await cdp.connect();

    // Only navigate to workflows page if the tab isn't already there
    locationId = cdp.getLocationId();
    const tabInfo = cdp.getTabInfo();
    const alreadyOnWorkflows = tabInfo?.url?.includes('/automation/workflows');

    if (locationId && !alreadyOnWorkflows) {
      logger.info('Navigating to workflows page...');
      await cdp.navigate(`https://app.gohighlevel.com/v2/location/${locationId}/automation/workflows?listTab=all`);
      locationId = cdp.getLocationId();
    } else if (alreadyOnWorkflows) {
      logger.info('Tab already on workflows page, skipping navigation');
    }

    tokenManager = new TokenManager(cdp);
    if (locationId) {
      apiClient = new GhlApiClient(tokenManager, locationId);
    }
  } else {
    logger.info('No debug Chrome detected. Use the launch_chrome tool to start Chrome.');
  }

  // 4. Create state object that server tools can read and launch_chrome can mutate
  const state = { tokenManager, apiClient, locationId };

  // 5. Create MCP server -- pass launcher and mutable state
  const server = createServer(cdp, state, launcher);

  // 6. Create stdio transport and connect
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('GHL Workflow MCP server started');

  // 7. Graceful shutdown with PID-based Chrome cleanup (D-15, D-16)
  const shutdown = async () => {
    logger.info('Shutting down...');
    await cdp.disconnect();
    if (!noKillOnExit && launcher.getChildPid()) {
      logger.info(`Killing Chrome (PID: ${launcher.getChildPid()})`);
      launcher.killChrome();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error(err.message);
  if (err.suggestion) {
    logger.error('Suggestion:', err.suggestion);
  }
  process.exit(1);
});
