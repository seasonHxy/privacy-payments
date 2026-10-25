import { createHash, createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { check } from "./domain.js";
export type Nep413Payload = {
  message: string;
  nonce: Buffer;
  recipient: string;
  callbackUrl?: string;
};
function stringBytes(s: string) {
  const bytes = Buffer.from(s, "utf8");
  check(bytes.length <= 16384, "MESSAGE_TOO_LARGE", 400);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
}
export function encodeNep413(p: Nep413Payload): Buffer {
  check(p.nonce.length === 32, "INVALID_NONCE", 400);
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  return Buffer.concat([
    tag,
    stringBytes(p.message),
    p.nonce,
    stringBytes(p.recipient),
    p.callbackUrl === undefined
      ? Buffer.from([0])
      : Buffer.concat([Buffer.from([1]), stringBytes(p.callbackUrl)]),
  ]);
}
export function nep413Digest(p: Nep413Payload) {
  return createHash("sha256").update(encodeNep413(p)).digest();
}
export function nearPublicKey(publicKey: string): Buffer {
  check(
    publicKey.length <= 52 && publicKey.startsWith("ed25519:"),
    "UNSUPPORTED_SIGNING_KEY",
    400,
  );
  const bytes = Buffer.from(bs58.decode(publicKey.slice(8)));
  check(
    bytes.length === 32 && bs58.encode(bytes) === publicKey.slice(8),
    "INVALID_PUBLIC_KEY",
    400,
  );
  return bytes;
}
export function verifyNep413(
  p: Nep413Payload,
  publicKey: string,
  signature: string,
): boolean {
  try {
    const raw = nearPublicKey(publicKey);
    const sig = Buffer.from(signature, "base64");
    if (sig.length !== 64 || sig.toString("base64") !== signature) return false;
    const key = createPublicKey({
      format: "der",
      type: "spki",
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    });
    return verify(null, nep413Digest(p), key, sig);
  } catch {
    return false;
  }
}
