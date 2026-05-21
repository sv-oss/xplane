/**
 * Minimal logger interface for the @xplane/core library.
 * Compatible with pino, the Crossplane function-sdk Logger, and console.
 */
export interface XplaneLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}
