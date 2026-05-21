import { AsyncLocalStorage } from 'node:async_hooks';

import type { XplaneLogger } from './types.js';

const noopLogger: XplaneLogger = {
  debug() {},
  info() {},
  warn() {},
};

const loggerStorage = new AsyncLocalStorage<XplaneLogger>();

/**
 * Get the current logger from async context.
 * Returns a no-op logger if none has been set (silent by default).
 */
export function getLogger(): XplaneLogger {
  return loggerStorage.getStore() ?? noopLogger;
}

/**
 * Run a function with a logger available in async context.
 * All code within `fn` (and any nested async calls) can access
 * the logger via `getLogger()`.
 */
export function withLogger<T>(logger: XplaneLogger, fn: () => T): T {
  return loggerStorage.run(logger, fn);
}
