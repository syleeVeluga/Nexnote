// Not mounted in routes/index.ts. Retained for future internal reuse.
import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  createSynthesisSchema,
  DEFAULT_JOB_OPTIONS,
  IMPORT_SOURCE_NAMES,
  JOB_NAMES,
} from "@wekiflow/shared";
import type { SynthesisGeneratorJobData } from "@wekiflow/shared";
import { auditLogs, ingestions } from "@wekiflow/db";
import {
  EDITOR_PLUS_ROLES,
  forbidden,
  getMemberRole,
  insufficientRole,
  workspaceParamsSchema,
} from "../../lib/workspace-auth.js";
import { sendValidationError } from "../../lib/reply-helpers.js";
import { getOrCreateNamedSystemToken } from "../../lib/system-tokens.js";

const SYNTHESIS_TOKEN_NAME = "Synthesis (system)";

const synthesisRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/",
    { onRequest: [fastify.authenticate], bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error.issues);

      const body = createSynthesisSchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error.issues);

      const { workspaceId } = params.data;
      const userId = request.user.sub;
      const role = await getMemberRole(fastify.db, workspaceId, userId);
      if (!role) return forbidden(reply);
      if (!EDITOR_PLUS_ROLES.includes(role)) return insufficientRole(reply);

      const apiTokenId = await getOrCreateNamedSystemToken(
        fastify.db,
        workspaceId,
        userId,
        SYNTHESIS_TOKEN_NAME,
      );
      const idempotencyKey =
        body.data.idempotencyKey ??
        `synthesis:${userId}:${Date.now()}:${randomBytes(8).toString("hex")}`;

      const synthesisQueue = fastify.queues.synthesis;
      if (!synthesisQueue) {
        return reply.code(503).send({
          error: "Synthesis worker is disabled",
          code: "SYNTHESIS_DISABLED",
        });
      }

      const rawPayload = {
        prompt: body.data.prompt,
        sourceText: body.data.sourceText ?? null,
        targetPageId: body.data.targetPageId ?? null,
        seedPageIds: body.data.seedPageIds ?? [],
        seedEntityIds: body.data.seedEntityIds ?? [],
        requestedByUserId: userId,
      };

      // Persist ingestion + audit in one transaction so a failed audit insert
      // doesn't leave an orphan ingestion. The queue enqueue is intentionally
      // outside the tx — it's the only side effect we don't want to roll the
      // tx back for, and BullMQ writes its own state via Redis.
      const ingestion = await fastify.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(ingestions)
          .values({
            workspaceId,
            apiTokenId,
            sourceName: IMPORT_SOURCE_NAMES.SYNTHESIS_REQUEST,
            externalRef: null,
            idempotencyKey,
            contentType: "application/vnd.wekiflow.synthesis+json",
            titleHint: body.data.titleHint ?? null,
            rawPayload,
            normalizedText: body.data.sourceText ?? body.data.prompt,
            status: "pending",
          })
          .onConflictDoNothing()
          .returning();

        if (!created) return null;

        await tx.insert(auditLogs).values({
          workspaceId,
          userId,
          entityType: "ingestion",
          entityId: created.id,
          action: "synthesis_request",
          afterJson: {
            titleHint: body.data.titleHint ?? null,
            targetPageId: body.data.targetPageId ?? null,
            seedPageCount: body.data.seedPageIds?.length ?? 0,
            sourceTextLength: body.data.sourceText?.length ?? 0,
          },
        });

        return created;
      });

      if (!ingestion) {
        const [existing] = await fastify.db
          .select()
          .from(ingestions)
          .where(
            and(
              eq(ingestions.workspaceId, workspaceId),
              eq(ingestions.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        return reply.code(200).send({ ...existing, replayed: true });
      }

      const jobData: SynthesisGeneratorJobData = {
        ingestionId: ingestion.id,
        workspaceId,
        requestedByUserId: userId,
      };
      await synthesisQueue.add(
        JOB_NAMES.SYNTHESIS_GENERATOR,
        jobData,
        DEFAULT_JOB_OPTIONS,
      );

      return reply.code(202).send({ ...ingestion, replayed: false });
    },
  );
};

export default synthesisRoutes;
