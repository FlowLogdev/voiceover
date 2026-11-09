import type { AudioChunkFrame, UploadTransport } from "@voiceover/audio";

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid blowing the call stack on `String.fromCharCode(...bytes)`
  // for longer chunks (observed starting around tens of thousands of bytes).
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

export class WebSocketTransport implements UploadTransport {
  private ws: WebSocket;
  private connected = false;
  private ackCallback: ((sequenceNumber: number) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      this.connected = true;
    });
    this.ws.addEventListener("close", () => {
      this.connected = false;
    });
    this.ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type: string; sequenceNumber?: number };
        if (msg.type === "ack" && typeof msg.sequenceNumber === "number") {
          this.ackCallback?.(msg.sequenceNumber);
        }
      } catch {
        // ignore malformed server messages
      }
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(frame: AudioChunkFrame): Promise<void> {
    if (!this.connected) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(
      JSON.stringify({
        type: "chunk",
        sequenceNumber: frame.sequenceNumber,
        startMs: frame.startMs,
        endMs: frame.endMs,
        sourceTrack: frame.sourceTrack,
        sampleRate: frame.sampleRate,
        checksum: frame.checksum,
        bytesBase64: bytesToBase64(frame.bytes),
      }),
    );
  }

  onAck(callback: (sequenceNumber: number) => void): void {
    this.ackCallback = callback;
  }

  close(): void {
    this.ws.close();
  }
}
