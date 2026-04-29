import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "wf";
const TOKEN_SECRET_BYTES = 32;
const TOKEN_PATTERN =
  /^wf_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{32,})$/i;

export interface ParsedApiToken {
  tokenId: string;
  secret: string;
}

export function createApiTokenValue(tokenId: string): {
  token: string;
  secret: string;
} {
  const secret = randomBytes(TOKEN_SECRET_BYTES).toString("base64url");
  return {
    token: `${TOKEN_PREFIX}_${tokenId}_${secret}`,
    secret,
  };
}

export function hashApiTokenSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function parseApiTokenValue(token: string): ParsedApiToken | null {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) return null;
  return { tokenId: match[1], secret: match[2] };
}

export function verifyApiTokenSecret(
  providedSecret: string,
  storedHash: string,
): boolean {
  const providedHash = hashApiTokenSecret(providedSecret);
  const provided = Buffer.from(providedHash, "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (provided.length !== stored.length) return false;
  return timingSafeEqual(provided, stored);
}
