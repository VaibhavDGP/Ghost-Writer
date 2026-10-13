import { createHash } from "node:crypto";

// Our tokens will be 32 random bytes represented as
// 64 lowercase hexadecimal characters.
export function isSessionToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}$/.test(value)
  );
}

// Produce a fingerprint to store instead of the original token.
export function hashSessionToken(token: string): string {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}

// Read a token from: Authorization: Bearer <token>
export function readBearerToken(
  header: string | undefined,
): string | null {
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(header ?? "");
  const token = match?.[1];

  if (!isSessionToken(token)) {
    return null;
  }

  return token;
}