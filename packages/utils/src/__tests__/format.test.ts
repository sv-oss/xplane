import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import { formatEvent, formatHeader, formatProgress, statusGlyph } from '../render/format.js';
import type { KubernetesEvent, XrSnapshot } from '../watcher/types.js';

chalk.level = 1;

const ref = { kind: 'XProject', name: 'foo', namespace: 'default' };

function snap(opts: Partial<XrSnapshot> & { creation?: string }): XrSnapshot {
  return {
    object: {
      apiVersion: 'v1',
      kind: 'X',
      metadata: { name: 'foo', creationTimestamp: opts.creation },
    } as unknown as XrSnapshot['object'],
    ready: false,
    resourceRefs: [],
    ...opts,
  };
}

const ESC = String.fromCharCode(0x1b);
const strip = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

describe('statusGlyph', () => {
  it('returns expected glyphs for each state', () => {
    expect(strip(statusGlyph('ready'))).toBe('✔');
    expect(strip(statusGlyph('blocked'))).toBe('✖');
    expect(strip(statusGlyph('pending'))).toBe('⏳');
  });
});

describe('formatHeader', () => {
  it('prints kind, name, namespace, ready state and age in seconds', () => {
    const out = strip(formatHeader(snap({ ready: true, creation: new Date().toISOString() }), ref));
    expect(out).toMatch(/XProject\/foo \(default\)/);
    expect(out).toMatch(/Ready/);
    expect(out).toMatch(/age=0?s/);
  });

  it('falls back to readyReason when not ready', () => {
    const out = strip(
      formatHeader(snap({ ready: false, readyReason: 'Waiting' }), { kind: 'X', name: 'a' }),
    );
    expect(out).toMatch(/Waiting/);
    expect(out).not.toMatch(/\(/); // no namespace section
  });

  it('shows "?" age when creationTimestamp is missing', () => {
    expect(strip(formatHeader(snap({}), ref))).toMatch(/age=\?/);
  });

  it('formats age in minutes, hours and days', () => {
    const m = strip(
      formatHeader(snap({ creation: new Date(Date.now() - 5 * 60_000).toISOString() }), ref),
    );
    expect(m).toMatch(/age=5m/);
    const h = strip(
      formatHeader(snap({ creation: new Date(Date.now() - 5 * 3_600_000).toISOString() }), ref),
    );
    expect(h).toMatch(/age=5h/);
    const d = strip(
      formatHeader(snap({ creation: new Date(Date.now() - 3 * 86_400_000).toISOString() }), ref),
    );
    expect(d).toMatch(/age=3d/);
  });
});

describe('formatProgress', () => {
  it('includes blocked count when > 0', () => {
    expect(strip(formatProgress(3, 5, 0))).toBe('3/5 ready');
    expect(strip(formatProgress(3, 5, 2))).toMatch(/3\/5 ready · 2 blocked/);
  });
});

describe('formatEvent', () => {
  it('formats Normal events with reason and message', () => {
    const e: KubernetesEvent = {
      type: 'Normal',
      reason: 'Created',
      message: 'all set',
      count: 1,
      lastTimestamp: '2024-01-01T00:00:00Z',
      involvedKind: 'XProject',
      involvedName: 'foo',
    };
    const out = strip(formatEvent(e));
    expect(out).toMatch(/XProject\/foo Created: all set/);
  });

  it('uses yellow for Warning events', () => {
    const e: KubernetesEvent = { type: 'Warning', reason: 'Err', message: 'no', count: 1 };
    expect(formatEvent(e)).toMatch(new RegExp(`${ESC}\\[33m`));
  });

  it('renders a Date-typed lastTimestamp as HH:MM:SS, not Date.toString()', () => {
    // The K8s client SDK deserialises event timestamps into Date instances at
    // runtime even though our type says `string`. Coerce so output stays a
    // stable `HH:MM:SS` prefix.
    const e = {
      type: 'Normal',
      reason: 'Created',
      message: 'all set',
      count: 1,
      // biome-ignore lint/suspicious/noExplicitAny: simulating SDK runtime drift.
      lastTimestamp: new Date('2024-01-01T12:34:56Z') as any,
    } as KubernetesEvent;
    const out = strip(formatEvent(e));
    expect(out).toMatch(/^12:34:56 Created: all set$/);
  });
});
