import type { Timers } from "./types.js";

interface PendingTimer {
  id: number;
  at: number;
  callback: () => void;
}

/**
 * Manual clock for deterministic tests. `advance()` fires due timers in time
 * order and lets the async work they start (repository writes, chained
 * promises) settle before moving on, so assertions see a consistent state.
 */
export class FakeTimers implements Timers {
  private current: number;
  private nextId = 1;
  private pending: PendingTimer[] = [];
  /** Every delay ever requested — lets tests assert no single timer exceeded the 32-bit limit. */
  readonly requestedDelays: number[] = [];

  constructor(startMs = Date.UTC(2026, 10, 10, 12, 0, 0)) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    this.requestedDelays.push(ms);
    const timer = { id: this.nextId++, at: this.current + Math.max(0, ms), callback };
    this.pending.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((t) => t.id !== handle);
  }

  pendingCount(): number {
    return this.pending.length;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await flushAsync();
    for (;;) {
      this.pending.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.pending[0];
      if (!next || next.at > target) break;
      this.pending.shift();
      this.current = next.at;
      next.callback();
      await flushAsync();
    }
    this.current = target;
    await flushAsync();
  }
}

export async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
