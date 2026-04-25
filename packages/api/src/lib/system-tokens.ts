import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { apiTokens } from "@wekiflow/db";
import type { Database } from "@wekiflow/db";

/**
 * Provisions a hidden per-user system token so browser-initiated ingestion
 * rows can satisfy the `api_token_id` NOT NULL FK. The hash is random bytes
 * that are never exposed — the row exists purely for referential integrity
 * and as a rate-limit keying surface. Scoped by `name` so different system
 * paths (imports, synthesis, …) don't share a token.
 *
 * The (workspace_id, created_by_user_id, name) tuple has no DB unique
 * constraint, so a naive SELECT-then-INSERT would race when two requests
 * land concurrently for the same user — both see no token, both insert,
 * leaving an orphan duplicate. We serialize on a per-tuple xact advisory
 * lock so concurrent calls take their turn instead.
 */
export async function getOrCreateNamedSystemToken(
  db: Database,
  workspaceId: string,
  userId: string,
  name: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const lockKey = sha256ToBigInt(`${workspaceId}|${userId}|${name}`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);

    const [existing] = await tx
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.workspaceId, workspaceId),
          eq(apiTokens.createdByUserId, userId),
          eq(apiTokens.name, name),
          sql`${apiTokens.revokedAt} IS NULL`,
        ),
      )
      .limit(1);
    if (existing) return existing.id;

    const tokenHash = randomBytes(32).toString("hex");
    const [created] = await tx
      .insert(apiTokens)
      .values({
        workspaceId,
        createdByUserId: userId,
        name,
        tokenHash,
      })
      .returning({ id: apiTokens.id });
    return created.id;
  });
}

// Postgres `pg_advisory_xact_lock(bigint)` takes a signed 64-bit key. Hash
// the tuple to a stable bigint that fits in that range.
function sha256ToBigInt(key: string): bigint {
  const digest = createHash("sha256").update(key).digest();
  // Take the high 8 bytes and mask to int64 range (signed).
  const unsigned = digest.readBigUInt64BE(0);
  const SIGNED_MAX = (1n << 63n) - 1n;
  return unsigned > SIGNED_MAX ? unsigned - (1n << 64n) : unsigned;
}
