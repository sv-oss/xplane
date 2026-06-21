import { describe, expect, it, vi } from 'vitest';

import { withLogger } from '../../logging/index.js';
import {
  conditionReady,
  DEFAULT_CHECKS,
  exists,
  statusReady,
  syncedNotFalse,
} from '../defaults.js';
import { evaluateReadiness } from '../evaluate.js';
import type { ReadyCheck } from '../types.js';

describe('evaluateReadiness', () => {
  describe('when observed is undefined (resource does not exist)', () => {
    it('returns false', () => {
      expect(evaluateReadiness(DEFAULT_CHECKS, undefined)).toBe(false);
    });
  });

  describe('built-in: conditionReady', () => {
    it('returns true when Ready condition has status True', () => {
      const observed = {
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      expect(conditionReady(observed)).toBe(true);
    });

    it('returns false when Ready condition has status False', () => {
      const observed = {
        status: { conditions: [{ type: 'Ready', status: 'False' }] },
      };
      expect(conditionReady(observed)).toBe(false);
    });

    it('returns undefined when no Ready condition exists', () => {
      const observed = {
        status: { conditions: [{ type: 'Available', status: 'True' }] },
      };
      expect(conditionReady(observed)).toBeUndefined();
    });

    it('returns undefined when no conditions array exists', () => {
      const observed = { status: {} };
      expect(conditionReady(observed)).toBeUndefined();
    });
  });

  describe('built-in: syncedNotFalse', () => {
    it('returns false when Synced condition is False', () => {
      const observed = {
        status: { conditions: [{ type: 'Synced', status: 'False' }] },
      };
      expect(syncedNotFalse(observed)).toBe(false);
    });

    it('returns undefined when Synced condition is True', () => {
      const observed = {
        status: { conditions: [{ type: 'Synced', status: 'True' }] },
      };
      expect(syncedNotFalse(observed)).toBeUndefined();
    });

    it('returns undefined when no Synced condition exists', () => {
      const observed = {
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      expect(syncedNotFalse(observed)).toBeUndefined();
    });

    it('returns undefined when no conditions array exists', () => {
      expect(syncedNotFalse({ status: {} })).toBeUndefined();
    });
  });

  describe('built-in: statusReady', () => {
    it('returns true when status.ready is true', () => {
      expect(statusReady({ status: { ready: true } })).toBe(true);
    });

    it('returns false when status.ready is false', () => {
      expect(statusReady({ status: { ready: false } })).toBe(false);
    });

    it('returns undefined when status has no ready field', () => {
      expect(statusReady({ status: { phase: 'Running' } })).toBeUndefined();
    });

    it('returns undefined when no status exists', () => {
      expect(statusReady({ spec: {} })).toBeUndefined();
    });
  });

  describe('built-in: exists', () => {
    it('always returns true', () => {
      expect(exists({})).toBe(true);
    });
  });

  describe('default chain', () => {
    it('resource with Ready condition True → ready', () => {
      const observed = {
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      expect(evaluateReadiness(DEFAULT_CHECKS, observed)).toBe(true);
    });

    it('resource with Ready condition False → not ready', () => {
      const observed = {
        status: { conditions: [{ type: 'Ready', status: 'False' }] },
      };
      expect(evaluateReadiness(DEFAULT_CHECKS, observed)).toBe(false);
    });

    it('resource with status.ready true and no conditions → ready', () => {
      const observed = { status: { ready: true } };
      expect(evaluateReadiness(DEFAULT_CHECKS, observed)).toBe(true);
    });

    it('resource with status.ready false and no conditions → not ready', () => {
      const observed = { status: { ready: false } };
      expect(evaluateReadiness(DEFAULT_CHECKS, observed)).toBe(false);
    });

    it('resource that exists with no conditions and no status.ready → ready (existence fallback)', () => {
      const observed = { metadata: { name: 'my-sc' }, spec: {} };
      expect(evaluateReadiness(DEFAULT_CHECKS, observed)).toBe(true);
    });

    it('Ready=True but Synced=False → not ready (Synced vetoes)', () => {
      const observed = {
        status: {
          conditions: [
            { type: 'Ready', status: 'True' },
            { type: 'Synced', status: 'False' },
          ],
        },
      };
      expect(evaluateReadiness(DEFAULT_CHECKS, observed)).toBe(false);
    });

    it('Synced=False without Ready condition → not ready', () => {
      const observed = {
        status: { conditions: [{ type: 'Synced', status: 'False' }] },
      };
      expect(evaluateReadiness(DEFAULT_CHECKS, observed)).toBe(false);
    });
  });

  describe('custom checks', () => {
    it('custom check at priority 1 overrides defaults', () => {
      const customCheck: ReadyCheck = {
        fn: () => false,
        priority: 1,
        name: 'alwaysFalse',
      };
      const observed = {
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      expect(evaluateReadiness([customCheck, ...DEFAULT_CHECKS], observed)).toBe(false);
    });

    it('custom check returning undefined cascades to defaults', () => {
      const customCheck: ReadyCheck = {
        fn: () => undefined,
        priority: 1,
        name: 'uncertain',
      };
      const observed = {
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      expect(evaluateReadiness([customCheck, ...DEFAULT_CHECKS], observed)).toBe(true);
    });

    it('custom check returning true short-circuits (skips defaults)', () => {
      const customCheck: ReadyCheck = {
        fn: () => true,
        priority: 1,
        name: 'alwaysReady',
      };
      // Even though Ready condition is False, custom check at higher priority wins
      const observed = {
        status: { conditions: [{ type: 'Ready', status: 'False' }] },
      };
      expect(evaluateReadiness([customCheck, ...DEFAULT_CHECKS], observed)).toBe(true);
    });
  });

  describe('same priority AND logic', () => {
    it('all checks at same priority must agree for ready', () => {
      const checks: ReadyCheck[] = [
        { fn: () => true, priority: 1, name: 'checkA' },
        { fn: () => true, priority: 1, name: 'checkB' },
      ];
      expect(evaluateReadiness(checks, {})).toBe(true);
    });

    it('one false in a group blocks readiness', () => {
      const checks: ReadyCheck[] = [
        { fn: () => true, priority: 1, name: 'checkA' },
        { fn: () => false, priority: 1, name: 'checkB' },
      ];
      expect(evaluateReadiness(checks, {})).toBe(false);
    });

    it('all undefined in a group cascades to next', () => {
      const checks: ReadyCheck[] = [
        { fn: () => undefined, priority: 1, name: 'checkA' },
        { fn: () => undefined, priority: 1, name: 'checkB' },
        { fn: () => true, priority: 2, name: 'fallback' },
      ];
      expect(evaluateReadiness(checks, {})).toBe(true);
    });

    it('true + undefined in a group → ready (at least one true, no false)', () => {
      const checks: ReadyCheck[] = [
        { fn: () => true, priority: 1, name: 'checkA' },
        { fn: () => undefined, priority: 1, name: 'checkB' },
      ];
      expect(evaluateReadiness(checks, {})).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('no checks at all → not ready (final fallback)', () => {
      expect(evaluateReadiness([], {})).toBe(false);
    });

    it('all checks return undefined with no exists fallback → not ready', () => {
      const checks: ReadyCheck[] = [
        { fn: () => undefined, priority: 1, name: 'a' },
        { fn: () => undefined, priority: 2, name: 'b' },
      ];
      expect(evaluateReadiness(checks, {})).toBe(false);
    });

    it('handles checks without a name (uses anonymous)', () => {
      const checks: ReadyCheck[] = [{ fn: () => true, priority: 1 }];
      expect(evaluateReadiness(checks, {})).toBe(true);
    });
  });

  describe('realistic scenarios', () => {
    it('Deployment readiness: replicas match + Available condition', () => {
      const checks: ReadyCheck[] = [
        {
          fn: (obs) => {
            const spec = obs.spec as Record<string, unknown> | undefined;
            const status = obs.status as Record<string, unknown> | undefined;
            return status?.availableReplicas === spec?.replicas;
          },
          priority: 1,
          name: 'replicasMatch',
        },
        {
          fn: (obs) => {
            const status = obs.status as Record<string, unknown> | undefined;
            const conditions = status?.conditions as Array<Record<string, unknown>> | undefined;
            return conditions?.some((c) => c.type === 'Available' && c.status === 'True');
          },
          priority: 1,
          name: 'availableCondition',
        },
        ...DEFAULT_CHECKS,
      ];

      // All good
      const ready = {
        spec: { replicas: 3 },
        status: {
          availableReplicas: 3,
          conditions: [{ type: 'Available', status: 'True' }],
        },
      };
      expect(evaluateReadiness(checks, ready)).toBe(true);

      // Replicas mismatch
      const notReady = {
        spec: { replicas: 3 },
        status: {
          availableReplicas: 1,
          conditions: [{ type: 'Available', status: 'True' }],
        },
      };
      expect(evaluateReadiness(checks, notReady)).toBe(false);
    });

    it('Job readiness: Complete condition', () => {
      const checks: ReadyCheck[] = [
        {
          fn: (obs) => {
            const status = obs.status as Record<string, unknown> | undefined;
            const conditions = status?.conditions as Array<Record<string, unknown>> | undefined;
            if (!conditions) return undefined;
            if (conditions.some((c) => c.type === 'Failed' && c.status === 'True')) return false;
            if (conditions.some((c) => c.type === 'Complete' && c.status === 'True')) return true;
            return undefined;
          },
          priority: 1,
          name: 'jobComplete',
        },
        ...DEFAULT_CHECKS,
      ];

      const complete = {
        status: { conditions: [{ type: 'Complete', status: 'True' }] },
      };
      expect(evaluateReadiness(checks, complete)).toBe(true);

      const failed = {
        status: { conditions: [{ type: 'Failed', status: 'True' }] },
      };
      expect(evaluateReadiness(checks, failed)).toBe(false);

      const running = { status: { conditions: [] } };
      // Falls through to defaults → exists fallback
      expect(evaluateReadiness(checks, running)).toBe(true);
    });
  });

  describe('logging integration', () => {
    it('emits debug logs when a logger is provided', () => {
      const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

      withLogger(mockLogger, () => {
        evaluateReadiness(DEFAULT_CHECKS, {
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        });
      });

      expect(mockLogger.debug).toHaveBeenCalled();
      const calls = mockLogger.debug.mock.calls.map((c) => c[0]);
      expect(calls.some((msg: string) => msg.includes('readiness:'))).toBe(true);
    });

    it('logs when resource is not observed', () => {
      const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

      withLogger(mockLogger, () => {
        evaluateReadiness(DEFAULT_CHECKS, undefined);
      });

      expect(mockLogger.debug).toHaveBeenCalledWith('readiness: resource not observed, not ready');
    });

    it('logs when no group has definitive answer', () => {
      const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

      withLogger(mockLogger, () => {
        evaluateReadiness([], {});
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'readiness: no group had definitive answer, not ready',
      );
    });
  });
});
