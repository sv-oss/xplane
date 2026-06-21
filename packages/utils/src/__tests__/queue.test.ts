import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../watcher/queue.js';

describe('AsyncQueue', () => {
  it('delivers buffered values in order', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  it('resolves pending waiters when a value arrives', async () => {
    const q = new AsyncQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.push('hello');
    await expect(pending).resolves.toEqual({ value: 'hello', done: false });
  });

  it('resolves pending waiters with done when closed', async () => {
    const q = new AsyncQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.close();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });

  it('ignores push after close and is idempotent on close', async () => {
    const q = new AsyncQueue<number>();
    q.close();
    q.close();
    q.push(99);
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([]);
  });

  it('return() closes the queue', async () => {
    const q = new AsyncQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const r = it.return ? await it.return() : { value: undefined, done: true };
    expect(r).toEqual({ value: undefined, done: true });
    expect((await it.next()).done).toBe(true);
  });
});
