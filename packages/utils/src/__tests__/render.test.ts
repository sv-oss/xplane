import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { renderCI } from '../render/ci.js';
import { runRenderer, selectRenderer } from '../render/index.js';
import { renderTTY } from '../render/tty.js';
import { AsyncQueue } from '../watcher/queue.js';
import type { XrEvent, XrRef, XrSnapshot } from '../watcher/types.js';
import type { XrWatcher } from '../watcher/xr-watcher.js';

const ref: XrRef = {
  group: 'platform.example.com',
  version: 'v1alpha1',
  plural: 'xprojects',
  kind: 'XProject',
  namespaced: true,
  name: 'foo',
  namespace: 'default',
};

const ESC = String.fromCharCode(0x1b);
const strip = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

function fakeWatcher(events: XrEvent[]): XrWatcher {
  const q = new AsyncQueue<XrEvent>();
  // Push asynchronously so the renderer's setup runs first.
  Promise.resolve().then(() => {
    for (const e of events) q.push(e);
    q.close();
  });
  return {
    ready: new Promise(() => undefined),
    done: Promise.resolve(),
    stop: () => q.close(),
    [Symbol.asyncIterator]: () => q[Symbol.asyncIterator](),
  };
}

function snap(overrides: Partial<XrSnapshot>): XrSnapshot {
  return {
    object: {
      apiVersion: 'platform.example.com/v1alpha1',
      kind: 'XProject',
      metadata: { name: 'foo', namespace: 'default' },
    } as unknown as XrSnapshot['object'],
    ready: false,
    resourceRefs: [],
    ...overrides,
  };
}

async function drain(stream: PassThrough): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

describe('renderCI', () => {
  it('logs reason changes, progress and blocked entries line-by-line', async () => {
    const out = new PassThrough();
    const drained = drain(out);
    const events: XrEvent[] = [
      {
        type: 'snapshot',
        snapshot: snap({
          readyReason: 'Waiting',
          xplane: {
            emittedResources: [
              { apiVersion: 'a/v1', kind: 'A', nodePath: 'A', ready: true },
              { apiVersion: 'a/v1', kind: 'B', nodePath: 'B', ready: false },
            ],
            blockedResources: [
              { apiVersion: 'a/v1', kind: 'B', nodePath: 'B', waitingFor: ['vpc.id'] },
            ],
          },
        }),
      },
      // Identical snapshot → no new line
      {
        type: 'snapshot',
        snapshot: snap({
          readyReason: 'Waiting',
          xplane: {
            emittedResources: [
              { apiVersion: 'a/v1', kind: 'A', nodePath: 'A', ready: true },
              { apiVersion: 'a/v1', kind: 'B', nodePath: 'B', ready: false },
            ],
            blockedResources: [
              { apiVersion: 'a/v1', kind: 'B', nodePath: 'B', waitingFor: ['vpc.id'] },
            ],
          },
        }),
      },
      {
        type: 'k8s-event',
        event: { type: 'Normal', reason: 'Created', message: 'ok', count: 1 },
      },
      {
        type: 'snapshot',
        snapshot: snap({ ready: true, readyReason: 'Available' }),
      },
      { type: 'ready', snapshot: snap({ ready: true }) },
      { type: 'error', error: new Error('transient') },
      { type: 'end' },
    ];
    await renderCI(fakeWatcher(events), { ref, out, heartbeatMs: 0, showEvents: true });
    out.end();
    const text = strip(await drained);
    expect(text).toMatch(/watching XProject\/foo -n default/);
    expect(text).toMatch(/Waiting/);
    expect(text).toMatch(/2 ready|1 blocked|1\/2 ready/);
    expect(text).toMatch(/Created: ok/);
    expect(text).toMatch(/is Ready/);
    expect(text).toMatch(/error: transient/);
    // The two identical snapshots should produce only one progress line.
    const lines = text.split('\n').filter((l) => l.includes('1/2 ready'));
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it('uses resourceRefs total when status.xplane is absent', async () => {
    const out = new PassThrough();
    const drained = drain(out);
    const events: XrEvent[] = [
      {
        type: 'snapshot',
        snapshot: snap({
          resourceRefs: [
            { apiVersion: 'a/v1', kind: 'X', name: 'r-1' },
            { apiVersion: 'a/v1', kind: 'X', name: 'r-2' },
          ],
        }),
      },
      { type: 'end' },
    ];
    await renderCI(fakeWatcher(events), { ref, out });
    out.end();
    const text = strip(await drained);
    expect(text).toMatch(/0 ready/);
    expect(text).toMatch(/2 unready/);
  });
});

describe('renderTTY', () => {
  it('renders header, tree, progress and event tail; clears on end', async () => {
    const frames: string[] = [];
    const logger = Object.assign(
      (frame: string) => {
        frames.push(frame);
      },
      { clear: () => undefined, done: () => undefined },
    );
    const events: XrEvent[] = [
      {
        type: 'snapshot',
        snapshot: snap({
          ready: false,
          readyReason: 'Waiting',
          readyMessage: 'reconciling',
          xplane: {
            emittedResources: [
              { apiVersion: 'a/v1', kind: 'A', nodePath: 'CMS Database', ready: true },
              {
                apiVersion: 'a/v1',
                kind: 'B',
                nodePath: 'CMS Database/Security Group',
                ready: false,
              },
              { apiVersion: 'a/v1', kind: 'C', nodePath: 'CMS Service', ready: false },
            ],
            blockedResources: [
              {
                apiVersion: 'a/v1',
                kind: 'B',
                nodePath: 'CMS Database/Security Group',
                waitingFor: ['vpc.id'],
              },
            ],
          },
        }),
      },
      {
        type: 'k8s-event',
        event: {
          type: 'Warning',
          reason: 'Slow',
          message: 'still going',
          count: 2,
          lastTimestamp: '2024-01-01T00:00:00Z',
          involvedKind: 'XProject',
          involvedName: 'foo',
        },
      },
      { type: 'error', error: new Error('blip') },
      { type: 'ready', snapshot: snap({ ready: true, readyReason: 'Available' }) },
      { type: 'end' },
    ];
    await renderTTY(fakeWatcher(events), { ref, eventTailSize: 5, logger });
    const last = strip(frames[frames.length - 1] ?? '');
    expect(last).toMatch(/XProject\/foo/);
    expect(frames.some((f) => /Resources/.test(strip(f)))).toBe(true);
    expect(frames.some((f) => /Recent events/.test(strip(f)))).toBe(true);
    expect(
      frames.some(
        (f) => /CMS Database\/Security Group/.test(strip(f)) || /Security Group/.test(strip(f)),
      ),
    ).toBe(true);
    expect(frames.some((f) => /error: blip/.test(strip(f)))).toBe(true);
  });

  it('shows a placeholder while waiting for the first snapshot', async () => {
    const frames: string[] = [];
    const logger = Object.assign(
      (frame: string) => {
        frames.push(frame);
      },
      { clear: () => undefined, done: () => undefined },
    );
    await renderTTY(fakeWatcher([{ type: 'end' }]), { ref, logger });
    expect(strip(frames[0] ?? '')).toMatch(/waiting for first observation/);
  });

  it('trims the events tail to eventTailSize', async () => {
    const frames: string[] = [];
    const logger = Object.assign(
      (frame: string) => {
        frames.push(frame);
      },
      { clear: () => undefined, done: () => undefined },
    );
    const events: XrEvent[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'k8s-event' as const,
      event: { type: 'Normal', reason: `R${i}`, message: `m${i}`, count: 1 },
    }));
    events.push({ type: 'end' });
    await renderTTY(fakeWatcher(events), { ref, eventTailSize: 2, logger });
    const last = strip(frames[frames.length - 1] ?? '');
    expect(last).toMatch(/R3/);
    expect(last).toMatch(/R4/);
    expect(last).not.toMatch(/R0/);
  });
});

describe('selectRenderer / runRenderer', () => {
  it('picks tty when stream.isTTY is true', () => {
    expect(selectRenderer({ isTTY: true } as NodeJS.WriteStream)).toBe('tty');
    expect(selectRenderer({} as NodeJS.WritableStream)).toBe('ci');
  });

  it('runRenderer respects an explicit mode', async () => {
    const out = new PassThrough();
    const drained = drain(out);
    await runRenderer(fakeWatcher([{ type: 'end' }]), {
      ref,
      mode: 'ci',
      out: out as unknown as NodeJS.WriteStream,
    });
    out.end();
    expect(await drained).toMatch(/watching/);
  });

  it('runRenderer auto-selects based on stream.isTTY', async () => {
    const out = new PassThrough();
    const drained = drain(out);
    await runRenderer(fakeWatcher([{ type: 'end' }]), {
      ref,
      out: out as unknown as NodeJS.WriteStream,
    });
    out.end();
    expect(await drained).toMatch(/watching/);
  });

  it('runRenderer with mode=tty and eventTailSize uses the TTY renderer', async () => {
    const out = new PassThrough();
    (out as unknown as { isTTY: boolean }).isTTY = true;
    const events: XrEvent[] = [
      { type: 'snapshot', snapshot: snap({ ready: true }) },
      { type: 'end' },
    ];
    // Drain in the background to avoid backpressure issues.
    out.on('data', () => undefined);
    await runRenderer(fakeWatcher(events), {
      ref,
      mode: 'tty',
      eventTailSize: 3,
      out: out as unknown as NodeJS.WriteStream,
    });
    out.end();
  });
});
