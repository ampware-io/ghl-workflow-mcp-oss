/**
 * Stderr-only logger for MCP server.
 * All output goes to stderr to keep stdout clean for JSON-RPC transport.
 */

let verbose = false;

/**
 * Enable or disable verbose (debug) logging.
 * @param {boolean} v
 */
export function setVerbose(v) {
  verbose = !!v;
}

/**
 * Check if verbose mode is active.
 * @returns {boolean}
 */
export function isVerbose() {
  return verbose;
}

/**
 * Logger that writes exclusively to stderr.
 * Never uses console.log (stdout) to avoid corrupting MCP stdio transport.
 */
export const logger = {
  debug(...args) {
    if (verbose) {
      console.error('[DEBUG]', ...args);
    }
  },

  info(...args) {
    console.error('[INFO]', ...args);
  },

  warn(...args) {
    console.error('[WARN]', ...args);
  },

  error(...args) {
    console.error('[ERROR]', ...args);
  },
};
