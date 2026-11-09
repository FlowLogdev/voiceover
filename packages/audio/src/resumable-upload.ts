import type { AudioChunkFrame } from "./pcm.js";
import type { ChunkBuffer } from "./chunk-buffer.js";

export interface UploadTransport {
  isConnected(): boolean;
  send(frame: AudioChunkFrame): Promise<void>;
  onAck(callback: (sequenceNumber: number) => void): void;
}

export interface ResumableUploaderOptions {
  transport: UploadTransport;
  buffer: ChunkBuffer;
  maxRetryDelayMs?: number;
  baseRetryDelayMs?: number;
}

/**
 * Buffers every chunk locally first, then best-effort streams it; on
 * disconnect/error it retries with backoff, and on reconnect replays every
 * unacknowledged chunk in sequence order so the server can detect and skip
 * duplicates by sequence number rather than losing or duplicating audio.
 */
export class ResumableUploader {
  private readonly transport: UploadTransport;
  private readonly buffer: ChunkBuffer;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private retryAttempt = 0;
  private flushing = false;

  constructor(options: ResumableUploaderOptions) {
    this.transport = options.transport;
    this.buffer = options.buffer;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 15_000;
    this.transport.onAck((sequenceNumber) => {
      void this.buffer.markAcknowledged(sequenceNumber);
    });
  }

  async enqueue(frame: AudioChunkFrame): Promise<void> {
    await this.buffer.put(frame);
    await this.flush();
  }

  /** Re-sends every unacknowledged chunk, oldest first. Safe to call repeatedly. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      if (!this.transport.isConnected()) return;
      const pending = await this.buffer.getUnacknowledged();
      for (const chunk of pending) {
        try {
          await this.transport.send(chunk);
          this.retryAttempt = 0;
        } catch {
          this.retryAttempt += 1;
          break; // stop on first failure; caller/transport reconnect will trigger another flush
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  nextRetryDelayMs(): number {
    const delay = this.baseRetryDelayMs * 2 ** this.retryAttempt;
    return Math.min(delay, this.maxRetryDelayMs);
  }
}
