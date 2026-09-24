import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env.server";

const PREFIX = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const configured = env("FERRY_SESSION_KEY") || env("TELEGRAM_API_HASH");
  if (!configured) throw new Error("Set FERRY_SESSION_KEY (or TELEGRAM_API_HASH) before storing Telegram sessions.");
  return createHash("sha256").update(configured, "utf8").digest();
}

export function encryptSession(session: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(session, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

export function decryptSession(value: string): string {
  if (!value.startsWith(PREFIX)) return value; // legacy installations are migrated on next save.
  const packed = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (packed.length < IV_BYTES + TAG_BYTES + 1) throw new Error("Stored Telegram session is invalid.");
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
