/**
 * Structured error types for the GHL Workflow MCP server.
 * Each error provides an actionable suggestion to help users resolve issues.
 */

/**
 * Base error class for all GHL MCP errors.
 */
export class GhlMcpError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {string} [suggestion]
   */
  constructor(message, code, suggestion) {
    super(message);
    this.name = 'GhlMcpError';
    this.code = code;
    this.suggestion = suggestion || '';
  }
}

/**
 * Thrown when Chrome is not reachable on the CDP debug port.
 * Provides OS-specific instructions for launching Chrome with remote debugging.
 */
export class ChromeNotRunningError extends GhlMcpError {
  /**
   * @param {number} port
   */
  constructor(port) {
    const platform = process.platform;
    let launchCmd;

    if (platform === 'win32') {
      launchCmd = `Start Chrome with: chrome.exe --remote-debugging-port=${port}`;
    } else if (platform === 'darwin') {
      launchCmd = `Start Chrome with: open -a "Google Chrome" --args --remote-debugging-port=${port}`;
    } else {
      launchCmd = `Start Chrome with: google-chrome --remote-debugging-port=${port}`;
    }

    const suggestion = [
      launchCmd,
      'Then open GoHighLevel and log in.',
      'Retry the connection.',
    ].join('\n');

    super(`Cannot connect to Chrome on port ${port}.`, 'CHROME_NOT_RUNNING', suggestion);
    this.name = 'ChromeNotRunningError';
  }
}

/**
 * Thrown when no GoHighLevel tab is found in Chrome.
 */
export class NoGhlTabError extends GhlMcpError {
  constructor() {
    super(
      'No GoHighLevel tab found in Chrome.',
      'NO_GHL_TAB',
      'Open GoHighLevel in Chrome (app.gohighlevel.com) and log in, then retry.',
    );
    this.name = 'NoGhlTabError';
  }
}

/**
 * Thrown when a CDP operation exceeds the timeout threshold.
 */
export class CdpTimeoutError extends GhlMcpError {
  /**
   * @param {string} operationName
   * @param {number} timeoutMs
   */
  constructor(operationName, timeoutMs) {
    super(
      `CDP operation "${operationName}" timed out after ${timeoutMs}ms`,
      'CDP_TIMEOUT',
    );
    this.name = 'CdpTimeoutError';
  }
}

/**
 * Thrown when the user's GHL session has fully expired.
 */
export class SessionExpiredError extends GhlMcpError {
  constructor() {
    super(
      'Your GHL session has expired. Please log in again in Chrome and retry.',
      'SESSION_EXPIRED',
    );
    this.name = 'SessionExpiredError';
  }
}

/**
 * Thrown when Chrome binary cannot be found on the system.
 * Provides OS-specific install guidance and env var hint.
 */
export class ChromeNotFoundError extends GhlMcpError {
  /**
   * @param {string} platformOrMessage - process.platform value or custom error message
   */
  constructor(platformOrMessage) {
    const installUrl = 'https://www.google.com/chrome/';
    const hint = 'Set GHL_MCP_CHROME_PATH environment variable to your Chrome executable path.';
    // If it looks like a platform string, generate platform-specific message
    if (['darwin', 'win32', 'linux'].includes(platformOrMessage)) {
      let platformMsg;
      if (platformOrMessage === 'darwin') {
        platformMsg = 'Chrome not found in /Applications/Google Chrome.app';
      } else if (platformOrMessage === 'win32') {
        platformMsg = 'Chrome not found in Program Files directories';
      } else {
        platformMsg = 'Chrome not found. Tried: google-chrome-stable, google-chrome';
      }
      super(`${platformMsg}. Install Chrome from ${installUrl}`, 'CHROME_NOT_FOUND', hint);
    } else {
      // Custom message (e.g., from GHL_MCP_CHROME_PATH validation)
      super(platformOrMessage, 'CHROME_NOT_FOUND', hint);
    }
    this.name = 'ChromeNotFoundError';
  }
}

/**
 * Thrown when the GHL API returns an error response.
 * Provides structured error info including HTTP status and GHL message.
 */
export class GhlApiError extends GhlMcpError {
  /**
   * @param {number} status - HTTP status code
   * @param {string} ghlMessage - Error message from GHL API
   * @param {string} [suggestion] - Actionable suggestion for the user
   */
  constructor(status, ghlMessage, suggestion) {
    super(`GHL API error ${status}: ${ghlMessage}`, 'GHL_API_ERROR', suggestion || '');
    this.name = 'GhlApiError';
    this.status = status;
    this.ghlMessage = ghlMessage;
  }

  /**
   * Structured JSON representation.
   * @returns {{ status: number, message: string, suggestion: string }}
   */
  toJSON() {
    return {
      status: this.status,
      message: this.ghlMessage,
      suggestion: this.suggestion,
    };
  }
}
