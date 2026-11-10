import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidStorageKeyError, LocalDiskObjectStore, assertValidKey, storageKeys } from "./index.js";

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts).toString("utf8");
}

describe("LocalDiskObjectStore", () => {
  let dir: string;
  let store: LocalDiskObjectStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voiceover-storage-"));
    store = new LocalDiskObjectStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips objects by relative key, reports size, and streams byte ranges", async () => {
    const key = storageKeys.playback("track-1");
    expect(await store.size(key)).toBeNull();
    await store.put(key, new TextEncoder().encode("hello world"));
    expect(new TextDecoder().decode(await store.get(key))).toBe("hello world");
    expect(await store.size(key)).toBe(11);
    expect(await readAll(store.read(key, { start: 6, end: 10 }))).toBe("world");
    await store.delete(key);
    expect(await store.size(key)).toBeNull();
  });

  it("is reachable through a second instance rooted at the same directory given a different relative spelling", async () => {
    await store.put("a/b.bin", new Uint8Array([1, 2, 3]));
    const other = new LocalDiskObjectStore(join(dir, "a", ".."));
    expect(await other.get("a/b.bin")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("streams an object from parts, and leaves nothing behind when the source fails", async () => {
    async function* parts() {
      yield new TextEncoder().encode("ab");
      yield new TextEncoder().encode("cd");
    }
    expect(await store.putStream("x/y.bin", parts())).toBe(4);
    expect(new TextDecoder().decode(await store.get("x/y.bin"))).toBe("abcd");

    async function* broken() {
      yield new Uint8Array([1]);
      throw new Error("source failed");
    }
    await expect(store.putStream("x/z.bin", broken())).rejects.toThrow("source failed");
    expect(await store.size("x/z.bin")).toBeNull();
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dir, "x"))).toEqual(["y.bin"]);
  });

  it("rejects keys that could escape the store root", async () => {
    for (const key of ["../x", "a/../../x", "/etc/passwd", "C:\\x", "a\\..\\x", "a//b", "", "./a", "a/./b", "a b"]) {
      expect(() => assertValidKey(key), key).toThrow(InvalidStorageKeyError);
      await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow(InvalidStorageKeyError);
    }
  });

  it("uses zero-padded, sortable chunk keys", () => {
    expect(storageKeys.chunk("t", 42)).toBe("recordings/t/chunks/00000042.pcm");
  });
});
