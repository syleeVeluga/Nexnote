import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ERROR_CODES, normalizeKey, uuidSchema } from "@wekiflow/shared";
import {
  auditLogs,
  entities,
  entityAliases,
  pages,
  tripleMentions,
  triples,
} from "@wekiflow/db";
import {
  forbidden,
  getMemberRole,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import {
  groupEvidenceByPage,
  type RawEvidenceRow,
} from "../../lib/entity-provenance.js";
import { loadPredicateDisplayLabels } from "../../lib/predicate-display-labels.js";

const entityParamsSchema = workspaceParamsSchema.extend({
  entityId: uuidSchema,
});

const aliasParamsSchema = entityParamsSchema.extend({
  aliasId: uuidSchema,
});

const entityProvenanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
  locale: z.enum(["ko", "en"]).optional(),
});

function entityNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: "Entity not found",
    code: ERROR_CODES.NOT_FOUND,
  });
}

const entityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get(
    "/:entityId/aliases",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = entityParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, entityId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const [entityRow] = await fastify.db
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
        )
        .limit(1);
      if (!entityRow) return entityNotFound(reply);

      const rows = await fastify.db
        .select({
          id: entityAliases.id,
          entityId: entityAliases.entityId,
          alias: entityAliases.alias,
          normalizedAlias: entityAliases.normalizedAlias,
          status: entityAliases.status,
          similarityScore: entityAliases.similarityScore,
          matchMethod: entityAliases.matchMethod,
          sourcePageId: entityAliases.sourcePageId,
          sourcePageTitle: pages.title,
          createdByExtractionId: entityAliases.createdByExtractionId,
          createdAt: entityAliases.createdAt,
          rejectedAt: entityAliases.rejectedAt,
          rejectedByUserId: entityAliases.rejectedByUserId,
        })
        .from(entityAliases)
        .leftJoin(pages, eq(pages.id, entityAliases.sourcePageId))
        .where(eq(entityAliases.entityId, entityId))
        .orderBy(desc(entityAliases.createdAt));

      return reply.code(200).send({
        aliases: rows.map((row) => ({
          id: row.id,
          entityId: row.entityId,
          alias: row.alias,
          normalizedAlias: row.normalizedAlias,
          status: row.status,
          similarityScore: row.similarityScore,
          matchMethod: row.matchMethod,
          sourcePageId: row.sourcePageId,
          sourcePageTitle: row.sourcePageTitle,
          createdByExtractionId: row.createdByExtractionId,
          createdAt: row.createdAt.toISOString(),
          rejectedAt: row.rejectedAt?.toISOString() ?? null,
          rejectedByUserId: row.rejectedByUserId,
        })),
      });
    },
  );

  fastify.post(
    "/:entityId/aliases/:aliasId/reject",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = aliasParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, entityId, aliasId } = paramsResult.data;
      const userId = request.user.sub;

      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (role !== "owner" && role !== "admin" && role !== "editor") {
        return forbidden(reply);
      }

      const result = await fastify.db.transaction(async (tx) => {
        const [aliasRow] = await tx
          .select({
            id: entityAliases.id,
            entityId: entityAliases.entityId,
            alias: entityAliases.alias,
            normalizedAlias: entityAliases.normalizedAlias,
            status: entityAliases.status,
            sourcePageId: entityAliases.sourcePageId,
            matchMethod: entityAliases.matchMethod,
            similarityScore: entityAliases.similarityScore,
            targetCanonicalName: entities.canonicalName,
            targetEntityType: entities.entityType,
          })
          .from(entityAliases)
          .innerJoin(entities, eq(entities.id, entityAliases.entityId))
          .where(
            and(
              eq(entityAliases.id, aliasId),
              eq(entityAliases.entityId, entityId),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .limit(1);

        if (!aliasRow) return null;

        if (aliasRow.status === "rejected") {
          return {
            aliasId: aliasRow.id,
            entityId,
            splitEntityId: null,
            rewiredTriples: 0,
            copiedMentions: 0,
          };
        }

        const now = new Date();
        await tx
          .update(entityAliases)
          .set({
            status: "rejected",
            rejectedAt: now,
            rejectedByUserId: userId,
          })
          .where(eq(entityAliases.id, aliasId));

        const splitKey = aliasRow.normalizedAlias || normalizeKey(aliasRow.alias);
        let [splitEntity] = await tx
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.normalizedKey, splitKey),
            ),
          )
          .limit(1);

        if (!splitEntity) {
          [splitEntity] = await tx
            .insert(entities)
            .values({
              workspaceId,
              canonicalName: aliasRow.alias,
              normalizedKey: splitKey,
              entityType: aliasRow.targetEntityType,
              metadataJson: {
                createdBy: "alias_reject",
                rejectedAliasId: aliasRow.id,
                splitFromEntityId: aliasRow.entityId,
              },
            })
            .returning({ id: entities.id });
        }

        let rewiredTriples = 0;
        let copiedMentions = 0;

        if (aliasRow.sourcePageId) {
          const aliasNeedle = normalizeKey(aliasRow.alias);
          const candidateRows = aliasNeedle
            ? await tx
                .select({
                  id: triples.id,
                  workspaceId: triples.workspaceId,
                  subjectEntityId: triples.subjectEntityId,
                  predicate: triples.predicate,
                  objectEntityId: triples.objectEntityId,
                  objectLiteral: triples.objectLiteral,
                  confidence: triples.confidence,
                  sourcePageId: triples.sourcePageId,
                  sourceRevisionId: triples.sourceRevisionId,
                  extractionModelRunId: triples.extractionModelRunId,
                  excerpt: tripleMentions.excerpt,
                })
                .from(triples)
                .innerJoin(
                  tripleMentions,
                  eq(tripleMentions.tripleId, triples.id),
                )
                .where(
                  and(
                    eq(triples.workspaceId, workspaceId),
                    eq(triples.sourcePageId, aliasRow.sourcePageId),
                    eq(triples.status, "active"),
                    sql`(${triples.subjectEntityId} = ${entityId} OR ${triples.objectEntityId} = ${entityId})`,
                  ),
                )
            : [];
          const affectedById = new Map<
            string,
            Omit<(typeof candidateRows)[number], "excerpt">
          >();
          for (const row of candidateRows) {
            if (!row.excerpt || !normalizeKey(row.excerpt).includes(aliasNeedle)) {
              continue;
            }
            const { excerpt: _excerpt, ...triple } = row;
            void _excerpt;
            affectedById.set(row.id, triple);
          }
          const affected = [...affectedById.values()];

          if (affected.length > 0) {
            await tx
              .update(triples)
              .set({ status: "superseded" })
              .where(inArray(triples.id, affected.map((triple) => triple.id)));
          }

          for (const triple of affected) {
            const [newTriple] = await tx
              .insert(triples)
              .values({
                workspaceId: triple.workspaceId,
                subjectEntityId:
                  triple.subjectEntityId === entityId
                    ? splitEntity.id
                    : triple.subjectEntityId,
                predicate: triple.predicate,
                objectEntityId:
                  triple.objectEntityId === entityId
                    ? splitEntity.id
                    : triple.objectEntityId,
                objectLiteral: triple.objectLiteral,
                confidence: triple.confidence,
                sourcePageId: triple.sourcePageId,
                sourceRevisionId: triple.sourceRevisionId,
                extractionModelRunId: triple.extractionModelRunId,
                status: "active",
              })
              .returning({ id: triples.id });
            rewiredTriples += 1;

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
        }

        await tx.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "entity_alias",
          entityId: aliasRow.id,
          action: "entity_alias.reject",
          beforeJson: {
            status: aliasRow.status,
            entityId: aliasRow.entityId,
            alias: aliasRow.alias,
            normalizedAlias: aliasRow.normalizedAlias,
          },
          afterJson: {
            status: "rejected",
            splitEntityId: splitEntity.id,
            rewiredTriples,
            copiedMentions,
          },
        });

        return {
          aliasId: aliasRow.id,
          entityId,
          splitEntityId: splitEntity.id,
          rewiredTriples,
          copiedMentions,
        };
      });

      if (!result) {
        return reply.code(404).send({
          error: "Alias not found",
          code: ERROR_CODES.NOT_FOUND,
        });
      }

      return reply.code(200).send(result);
    },
  );

  fastify.get(
    "/:entityId/provenance",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = entityParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceId, entityId } = paramsResult.data;

      const role = await getMemberRole(
        fastify.db,
        workspaceId,
        request.user.sub,
      );
      if (!role) return forbidden(reply);

      const queryResult = entityProvenanceQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return sendValidationError(reply, queryResult.error.issues);
      }
      const { limit, locale } = queryResult.data;

      const [entityRow] = await fastify.db
        .select({
          id: entities.id,
          canonicalName: entities.canonicalName,
          entityType: entities.entityType,
        })
        .from(entities)
        .where(
          and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
        )
        .limit(1);

      if (!entityRow) {
        return entityNotFound(reply);
      }

      const matchesEntity = sql`(${triples.subjectEntityId} = ${entityId} OR ${triples.objectEntityId} = ${entityId})`;
      const activeTripleCount = sql<number>`count(${triples.id})`;

      const [rankedPages, [totalsRow]] = await Promise.all([
        fastify.db
          .select({
            pageId: pages.id,
            title: pages.title,
            slug: pages.slug,
            updatedAt: pages.updatedAt,
            lastAiUpdatedAt: pages.lastAiUpdatedAt,
            activeTripleCount,
          })
          .from(triples)
          .innerJoin(pages, eq(triples.sourcePageId, pages.id))
          .where(
            and(
              eq(triples.workspaceId, workspaceId),
              eq(triples.status, "active"),
              matchesEntity,
            ),
          )
          .groupBy(
            pages.id,
            pages.title,
            pages.slug,
            pages.updatedAt,
            pages.lastAiUpdatedAt,
          )
          .orderBy(desc(activeTripleCount), desc(pages.updatedAt), pages.id)
          .limit(limit + 1),
        fastify.db
          .select({
            totalSourcePages: sql<number>`count(DISTINCT ${triples.sourcePageId})`,
            totalActiveTriples: count(triples.id),
          })
            .from(triples)
            .where(
              and(
                eq(triples.workspaceId, workspaceId),
                eq(triples.status, "active"),
                matchesEntity,
              ),
            ),
      ]);

      const truncated = rankedPages.length > limit;
      const selectedPages = rankedPages.slice(0, limit);
      const rankedPageIds = selectedPages.map((page) => page.pageId);

      let evidenceRows: RawEvidenceRow[] = [];

      if (rankedPageIds.length > 0) {
        const rankedEvidence = sql`(
          SELECT triple_id, page_id, subject_entity_id, object_entity_id, object_literal, span_start, span_end, excerpt, predicate, page_rn
          FROM (
            SELECT
              triple_id, page_id, subject_entity_id, object_entity_id, object_literal, span_start, span_end, excerpt, predicate,
              ROW_NUMBER() OVER (
                PARTITION BY page_id
                ORDER BY span_start, triple_id
              ) AS page_rn
            FROM (
              SELECT
                ${tripleMentions.tripleId} AS triple_id,
                ${tripleMentions.pageId} AS page_id,
                ${triples.subjectEntityId} AS subject_entity_id,
                ${triples.objectEntityId} AS object_entity_id,
                ${triples.objectLiteral} AS object_literal,
                ${tripleMentions.spanStart} AS span_start,
                ${tripleMentions.spanEnd} AS span_end,
                ${tripleMentions.excerpt} AS excerpt,
                ${triples.predicate} AS predicate,
                ROW_NUMBER() OVER (
                  PARTITION BY ${tripleMentions.pageId}, ${tripleMentions.tripleId}
                  ORDER BY ${tripleMentions.spanStart}
                ) AS triple_rn
              FROM ${tripleMentions}
              INNER JOIN ${triples} ON ${triples.id} = ${tripleMentions.tripleId}
              WHERE ${inArray(tripleMentions.pageId, rankedPageIds)}
                AND ${triples.workspaceId} = ${workspaceId}
                AND ${triples.status} = 'active'
                AND (${triples.subjectEntityId} = ${entityId} OR ${triples.objectEntityId} = ${entityId})
                AND ${tripleMentions.excerpt} IS NOT NULL
            ) per_triple
            WHERE triple_rn = 1
          ) ranked
        ) AS evidence`;

        evidenceRows = await fastify.db
          .select({
            tripleId: sql<string>`evidence.triple_id`,
            pageId: sql<string>`evidence.page_id`,
            subjectEntityId: sql<string>`evidence.subject_entity_id`,
            objectEntityId: sql<string | null>`evidence.object_entity_id`,
            objectLiteral: sql<string | null>`evidence.object_literal`,
            spanStart: sql<number>`evidence.span_start`,
            spanEnd: sql<number>`evidence.span_end`,
            excerpt: sql<string>`evidence.excerpt`,
            predicate: sql<string>`evidence.predicate`,
          })
          .from(rankedEvidence)
          .where(sql`evidence.page_rn <= 3`)
          .orderBy(sql`evidence.page_id`, sql`evidence.page_rn`);
      }

      const predicateLabelMap = await loadPredicateDisplayLabels(
        fastify.db,
        evidenceRows.map((row) => row.predicate),
        locale,
      );

      const evidenceByPage = groupEvidenceByPage(evidenceRows, predicateLabelMap);

      return reply.code(200).send({
        entity: {
          id: entityRow.id,
          canonicalName: entityRow.canonicalName,
          entityType: entityRow.entityType,
          totalSourcePages: Number(totalsRow?.totalSourcePages ?? 0),
          totalActiveTriples: Number(totalsRow?.totalActiveTriples ?? 0),
        },
        sourcePages: selectedPages.map((page) => ({
          pageId: page.pageId,
          title: page.title,
          slug: page.slug,
          activeTripleCount: Number(page.activeTripleCount),
          lastUpdatedAt: page.updatedAt.toISOString(),
          lastAiUpdatedAt: page.lastAiUpdatedAt
            ? page.lastAiUpdatedAt.toISOString()
            : null,
          evidenceExcerpts: evidenceByPage.get(page.pageId) ?? [],
        })),
        truncated,
      });
    },
  );
};

export default entityRoutes;
