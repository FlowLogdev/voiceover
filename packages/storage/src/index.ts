import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = "InvalidStorageKeyError";
  }
}

/** Inclusive byte range, as in an HTTP `Range: bytes=start-end` header. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Object storage for recorded audio, keyed by relative keys like
 * `recordings/<trackId>/chunks/00000001.pcm`. Keys never encode where the
 * store lives, so the API (writing chunks) and the worker (assembling
 * playback files) can share one store whatever their working directories.
 *
 * Today's only implementation is local disk, a placeholder for the
 * S3-compatible storage in ARCHITECTURE.md section 4 (encryption at rest,
 * short-lived signed URLs). An S3 adapter implements this same interface.
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Writes an object from parts without holding it all in memory. Readers never see a partial object. Returns bytes written. */
  putStream(key: string, parts: AsyncIterable<Uint8Array>): Promise<number>;
  get(key: string): Promise<Uint8Array>;
  /** Byte size, or null if there is no such object. */
  size(key: string): Promise<number | null>;
  read(key: string, range?: ByteRange): Readable;
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Rejects absolute paths, `..`/`.` segments, backslashes and anything outside a conservative charset. */
export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.split("/").some((part) => part === "." || part === "..")) {
    throw new InvalidStorageKeyError(key);
  }
}

export class LocalDiskObjectStore implements ObjectStore {
  readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const path = join(this.root, ...key.split("/"));
    // Belt and braces on top of the key pattern.
    if (isAbsolute(key) || !path.startsWith(this.root + sep)) throw new InvalidStorageKeyError(key);
    return path;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename so a reader never sees a half-written object.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async putStream(key: string, parts: AsyncIterable<Uint8Array>): Promise<number> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(tmp, "w");
    let written = 0;
    try {
      for await (const part of parts) {
        await handle.write(part);
        written += part.length;
      }
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(tmp, { force: true });
      throw error;
    }
    await rename(tmp, path);
    return written;
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)));
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.pathFor(key))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  read(key: string, range?: ByteRange): Readable {
    return createReadStream(this.pathFor(key), range ? { start: range.start, end: range.end } : undefined);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

/** Deterministic object keys, so every writer and reader agrees on where things live. */
export const storageKeys = {
  chunk: (recordingTrackId: string, sequenceNumber: number) =>
    `recordings/${recordingTrackId}/chunks/${String(sequenceNumber).padStart(8, "0")}.pcm`,
  playback: (recordingTrackId: string) => `recordings/${recordingTrackId}/playback.wav`,
};
