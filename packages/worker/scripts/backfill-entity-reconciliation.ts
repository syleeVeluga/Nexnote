/**
 * Forward-only reconciliation backfill for existing split entities.
 *
 * Usage:
 *   pnpm --filter @wekiflow/worker exec tsx scripts/backfill-entity-reconciliation.ts --workspace=<id> --dry-run
 *   pnpm --filter @wekiflow/worker exec tsx scripts/backfill-entity-reconciliation.ts --workspace=<id> --apply
 *
 * The script treats active entity_aliases rows as approved deterministic merge
 * evidence. If an alias text also exists as a separate entity in the same
 * workspace, active triples on the separate/source entity are superseded and
 * copied to the alias target entity. Existing rows are never mutated except
 * for status='superseded'.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  entities,
  entityAliases,
  tripleMentions,
  triples,
} from "@wekiflow/db";
import { getDb } from "@wekiflow/db/client";

interface Args {
  workspaceId: string;
  apply: boolean;
}

function parseArgs(): Args {
  const out: Args = { workspaceId: "", apply: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--workspace=")) {
      out.workspaceId = arg.slice("--workspace=".length);
    } else if (arg === "--apply") {
      out.apply = true;
    } else if (arg === "--dry-run") {
      out.apply = false;
    }
  }
  if (!out.workspaceId) {
    throw new Error("Missing --workspace=<id>");
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const db = getDb();

  const candidates = await db
    .select({
      aliasId: entityAliases.id,
      targetEntityId: entityAliases.entityId,
      alias: entityAliases.alias,
      normalizedAlias: entityAliases.normalizedAlias,
      sourceEntityId: entities.id,
    })
    .from(entityAliases)
    .innerJoin(
      entities,
      and(
        eq(entities.workspaceId, args.workspaceId),
        eq(entities.normalizedKey, entityAliases.normalizedAlias),
      ),
    )
    .where(
      and(
        eq(entityAliases.status, "active"),
        sql`${entityAliases.entityId} IN (SELECT id FROM entities WHERE workspace_id = ${args.workspaceId})`,
        sql`${entityAliases.entityId} <> ${entities.id}`,
      ),
    );

  let affectedTriples = 0;
  let copiedMentions = 0;
  const rewires = [];

  for (const candidate of candidates) {
    const rows = await db
      .select({ id: triples.id })
      .from(triples)
      .where(
        and(
          eq(triples.workspaceId, args.workspaceId),
          eq(triples.status, "active"),
          sql`(${triples.subjectEntityId} = ${candidate.sourceEntityId} OR ${triples.objectEntityId} = ${candidate.sourceEntityId})`,
        ),
      );
    if (rows.length === 0) continue;
    affectedTriples += rows.length;
    rewires.push({ ...candidate, tripleCount: rows.length });
  }

  console.log(
    `[entity-reconcile-backfill] ${args.apply ? "APPLY" : "DRY RUN"} workspace=${args.workspaceId}`,
  );
  console.log(
    `[entity-reconcile-backfill] ${rewires.length} source/target pair(s), ${affectedTriples} active triple(s)`,
  );

  if (!args.apply || rewires.length === 0) return;

  for (const rewire of rewires) {
    await db.transaction(async (tx) => {
      const affected = await tx
        .select()
        .from(triples)
        .where(
          and(
            eq(triples.workspaceId, args.workspaceId),
            eq(triples.status, "active"),
            sql`(${triples.subjectEntityId} = ${rewire.sourceEntityId} OR ${triples.objectEntityId} = ${rewire.sourceEntityId})`,
          ),
        );

      if (affected.length === 0) return;

      await tx
        .update(triples)
        .set({ status: "superseded" })
        .where(inArray(triples.id, affected.map((triple) => triple.id)));

      for (const triple of affected) {
        const [newTriple] = await tx
          .insert(triples)
          .values({
            workspaceId: triple.workspaceId,
            subjectEntityId:
              triple.subjectEntityId === rewire.sourceEntityId
                ? rewire.targetEntityId
                : triple.subjectEntityId,
            predicate: triple.predicate,
            objectEntityId:
              triple.objectEntityId === rewire.sourceEntityId
                ? rewire.targetEntityId
                : triple.objectEntityId,
            objectLiteral: triple.objectLiteral,
            confidence: triple.confidence,
            sourcePageId: triple.sourcePageId,
            sourceRevisionId: triple.sourceRevisionId,
            extractionModelRunId: triple.extractionModelRunId,
            status: "active",
          })
          .returning({ id: triples.id });

        const mentions = await tx
          .select()
          .from(tripleMentions)
          .where(eq(tripleMentions.tripleId, triple.id));
        if (mentions.length > 0) {
          await tx.insert(tripleMentions).values(
            mentions.map((mention) => ({
              tripleId: newTriple.id,
              pageId: mention.pageId,
              revisionId: mention.revisionId,
              revisionChunkId: mention.revisionChunkId,
              spanStart: mention.spanStart,
              spanEnd: mention.spanEnd,
              excerpt: mention.excerpt,
            })),
          );
          copiedMentions += mentions.length;
        }
      }

      await tx.insert(auditLogs).values({
        workspaceId: args.workspaceId,
        userId: null,
        entityType: "entity_alias",
        entityId: rewire.aliasId,
        action: "entity_reconciliation.backfill",
        afterJson: {
          sourceEntityId: rewire.sourceEntityId,
          targetEntityId: rewire.targetEntityId,
          alias: rewire.alias,
          normalizedAlias: rewire.normalizedAlias,
          supersededTriples: affected.length,
        },
      });
    });
  }

  console.log(
    `[entity-reconcile-backfill] superseded/copied ${affectedTriples} triple(s), copied ${copiedMentions} mention(s)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
