import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ERROR_CODES, uuidSchema } from "@nexnote/shared";
import { entities, pages, tripleMentions, triples } from "@nexnote/db";
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

const entityParamsSchema = workspaceParamsSchema.extend({
  entityId: uuidSchema,
});

const entityProvenanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
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
      const { limit } = queryResult.data;

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
          SELECT triple_id, page_id, span_start, span_end, excerpt, predicate, page_rn
          FROM (
            SELECT
              triple_id, page_id, span_start, span_end, excerpt, predicate,
              ROW_NUMBER() OVER (
                PARTITION BY page_id
                ORDER BY span_start, triple_id
              ) AS page_rn
            FROM (
              SELECT
                ${tripleMentions.tripleId} AS triple_id,
                ${tripleMentions.pageId} AS page_id,
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
            spanStart: sql<number>`evidence.span_start`,
            spanEnd: sql<number>`evidence.span_end`,
            excerpt: sql<string>`evidence.excerpt`,
            predicate: sql<string>`evidence.predicate`,
          })
          .from(rankedEvidence)
          .where(sql`evidence.page_rn <= 3`)
          .orderBy(sql`evidence.page_id`, sql`evidence.page_rn`);
      }

      const evidenceByPage = groupEvidenceByPage(evidenceRows);

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
