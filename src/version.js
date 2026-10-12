/**
 * Package version, read from package.json at load time.
 *
 * Kept in its own module so src/index.js (--version flag) and src/server.js
 * (MCP server info) can share it without an import cycle.
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const CURRENT_VERSION = pkg.version;
