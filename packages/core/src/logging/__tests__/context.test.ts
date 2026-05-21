import { describe, expect, it, vi } from 'vitest';

import { getLogger, withLogger } from '../context.js';
import type { XplaneLogger } from '../types.js';

describe('logging context', () => {
  describe('getLogger', () => {
    it('returns a no-op logger when no logger is set', () => {
      const logger = getLogger();
      // Should not throw
      logger.debug('test');
      logger.info('test');
      logger.warn('test');
      expect(logger).toBeDefined();
    });
  });

  describe('withLogger', () => {
    it('provides the logger within the callback', () => {
      const mockLogger: XplaneLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      };

      withLogger(mockLogger, () => {
        const logger = getLogger();
        logger.debug('hello', { key: 'value' });
        logger.info('world');
        logger.warn('oops');
      });

      expect(mockLogger.debug).toHaveBeenCalledWith('hello', { key: 'value' });
      expect(mockLogger.info).toHaveBeenCalledWith('world');
      expect(mockLogger.warn).toHaveBeenCalledWith('oops');
    });

    it('returns the result of the callback', () => {
      const mockLogger: XplaneLogger = { debug() {}, info() {}, warn() {} };
      const result = withLogger(mockLogger, () => 42);
      expect(result).toBe(42);
    });

    it('restores no-op logger after callback completes', () => {
      const mockLogger: XplaneLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      };

      withLogger(mockLogger, () => {});

      // Outside of withLogger, should be back to no-op
      const logger = getLogger();
      logger.debug('should not call mock');
      expect(mockLogger.debug).not.toHaveBeenCalledWith('should not call mock');
    });

    it('supports nested withLogger calls', () => {
      const outerLogger: XplaneLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
      const innerLogger: XplaneLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

      withLogger(outerLogger, () => {
        getLogger().debug('outer');

        withLogger(innerLogger, () => {
          getLogger().debug('inner');
        });

        getLogger().debug('outer again');
      });

      expect(outerLogger.debug).toHaveBeenCalledWith('outer');
      expect(outerLogger.debug).toHaveBeenCalledWith('outer again');
      expect(innerLogger.debug).toHaveBeenCalledWith('inner');
    });
  });
});
