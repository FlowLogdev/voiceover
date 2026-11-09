import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(plainPassword: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(plainPassword, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(plainPassword: string, storedHash: string): Promise<boolean> {
  const [algorithm, saltHex, hashHex] = storedHash.split(":");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derivedKey = (await scrypt(plainPassword, salt, expected.length)) as Buffer;
  return derivedKey.length === expected.length && timingSafeEqual(derivedKey, expected);
}
