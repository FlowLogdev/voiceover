import { describe, expect, it } from "vitest";
import { ChunkBuffer } from "./chunk-buffer.js";
import { buildChunkFrame } from "./pcm.js";
import { ResumableUploader, type UploadTransport } from "./resumable-upload.js";

function frame(sequenceNumber: number) {
  return buildChunkFrame({
    sequenceNumber,
    startMs: sequenceNumber * 100,
    endMs: (sequenceNumber + 1) * 100,
    sourceTrack: "remote_tab",
    sampleRate: 16000,
    samples: new Float32Array(1600),
  });
}

class FakeTransport implements UploadTransport {
  connected = true;
  sent: number[] = [];
  failNextSend = false;
  private ackCallback: ((sequenceNumber: number) => void) | null = null;

  isConnected() {
    return this.connected;
  }

  async send(f: ReturnType<typeof frame>) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("simulated send failure");
    }
    this.sent.push(f.sequenceNumber);
  }

  onAck(cb: (sequenceNumber: number) => void) {
    this.ackCallback = cb;
  }

  ack(sequenceNumber: number) {
    this.ackCallback?.(sequenceNumber);
  }
}

describe("ResumableUploader", () => {
  it("sends enqueued chunks and clears them once acknowledged", async () => {
    const buffer = await ChunkBuffer.open(`upload-${Date.now()}-${Math.random()}`);
    const transport = new FakeTransport();
    const uploader = new ResumableUploader({ transport, buffer });

    await uploader.enqueue(frame(0));
    expect(transport.sent).toEqual([0]);

    transport.ack(0);
    // markAcknowledged is async/fire-and-forget inside the ack handler
    await new Promise((r) => setTimeout(r, 0));
    expect(await buffer.getUnacknowledged()).toEqual([]);
  });

  it("does not send while disconnected, then replays on flush once reconnected", async () => {
    const buffer = await ChunkBuffer.open(`upload-${Date.now()}-${Math.random()}`);
    const transport = new FakeTransport();
    transport.connected = false;
    const uploader = new ResumableUploader({ transport, buffer });

    await uploader.enqueue(frame(0));
    expect(transport.sent).toEqual([]);

    transport.connected = true;
    await uploader.flush();
    expect(transport.sent).toEqual([0]);
  });

  it("stops flushing at the first failure, preserving order for the retry", async () => {
    const buffer = await ChunkBuffer.open(`upload-${Date.now()}-${Math.random()}`);
    const transport = new FakeTransport();
    const uploader = new ResumableUploader({ transport, buffer, baseRetryDelayMs: 1 });

    transport.connected = false;
    await uploader.enqueue(frame(0));
    await uploader.enqueue(frame(1));

    transport.connected = true;
    transport.failNextSend = true;
    await uploader.flush();
    expect(transport.sent).toEqual([]); // first send failed, loop broke before any success

    await uploader.flush();
    expect(transport.sent).toEqual([0, 1]);
  });

  it("increases retry delay after a failure and resets after success", async () => {
    const buffer = await ChunkBuffer.open(`upload-${Date.now()}-${Math.random()}`);
    const transport = new FakeTransport();
    const uploader = new ResumableUploader({ transport, buffer, baseRetryDelayMs: 100 });

    await uploader.enqueue(frame(0));
    transport.failNextSend = true;
    await uploader.flush();
    expect(uploader.nextRetryDelayMs()).toBeGreaterThan(100);

    await uploader.flush();
    expect(uploader.nextRetryDelayMs()).toBe(100);
  });
});
