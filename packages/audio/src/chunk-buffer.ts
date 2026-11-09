import type { AudioChunkFrame } from "./pcm.js";

export interface StoredChunk extends AudioChunkFrame {
  acknowledged: boolean;
  createdAt: number;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Durable, crash-resistant buffer for audio chunks pending upload. Chunks are
 * written here before (and regardless of) network upload, so a dropped
 * connection or a closed popup never loses audio — the recording resumes
 * uploading from the oldest unacknowledged chunk once connectivity returns.
 */
export class ChunkBuffer {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(
    recordingSessionId: string,
    indexedDBFactory: IDBFactory = globalThis.indexedDB,
  ): Promise<ChunkBuffer> {
    const dbName = `voiceover-chunks-${recordingSessionId}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const openRequest = indexedDBFactory.open(dbName, 1);
      openRequest.onupgradeneeded = () => {
        const db = openRequest.result;
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks", { keyPath: "sequenceNumber" });
        }
      };
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error ?? new Error("Failed to open IndexedDB"));
    });
    return new ChunkBuffer(db);
  }

  async put(frame: AudioChunkFrame): Promise<void> {
    const tx = this.db.transaction("chunks", "readwrite");
    const stored: StoredChunk = { ...frame, acknowledged: false, createdAt: Date.now() };
    await promisifyRequest(tx.objectStore("chunks").put(stored));
  }

  async markAcknowledged(sequenceNumber: number): Promise<void> {
    const tx = this.db.transaction("chunks", "readwrite");
    const store = tx.objectStore("chunks");
    const existing = await promisifyRequest<StoredChunk | undefined>(store.get(sequenceNumber));
    if (existing) {
      await promisifyRequest(store.put({ ...existing, acknowledged: true }));
    }
  }

  async getUnacknowledged(): Promise<StoredChunk[]> {
    const all = await this.getAll();
    return all.filter((c) => !c.acknowledged).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  async getAll(): Promise<StoredChunk[]> {
    const tx = this.db.transaction("chunks", "readonly");
    return promisifyRequest(tx.objectStore("chunks").getAll());
  }

  close(): void {
    this.db.close();
  }
}
