import type { AudioChunkFrame, UploadTransport } from "@voiceover/audio";
import type { ServerMessage } from "@voiceover/types";

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
  private transcriptCallback: ((message: ServerMessage) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      this.connected = true;
    });
    this.ws.addEventListener("close", () => {
      this.connected = false;
    });
    this.ws.addEventListener("message", (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return; // ignore malformed server messages
      }
      if (msg.type === "ack") {
        this.ackCallback?.(msg.sequenceNumber);
      } else if (
        msg.type === "transcript.partial" ||
        msg.type === "transcript.final" ||
        msg.type === "language.detected"
      ) {
        this.transcriptCallback?.(msg);
      }
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onTranscriptMessage(callback: (message: ServerMessage) => void): void {
    this.transcriptCallback = callback;
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
