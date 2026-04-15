import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { eq, and } from "drizzle-orm";
import { publicDocParamsSchema } from "@nexnote/shared";
import { publishedSnapshots, workspaces, pages } from "@nexnote/db";
import { sendValidationError } from "../../lib/reply-helpers.js";

// ---------------------------------------------------------------------------
// Public docs — no authentication required
// ---------------------------------------------------------------------------

const docRoutes: FastifyPluginAsync = async (fastify) => {
  // -----------------------------------------------------------------------
  // GET /docs/:workspaceSlug/:pagePath — Read a published document
  // -----------------------------------------------------------------------
  fastify.get(
    "/:workspaceSlug/:pagePath",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = publicDocParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceSlug, pagePath } = paramsResult.data;
      const publicPath = `/docs/${workspaceSlug}/${pagePath}`;

      // Fetch the live snapshot via public path
      const rows = await fastify.db
        .select({
          id: publishedSnapshots.id,
          pageId: publishedSnapshots.pageId,
          title: publishedSnapshots.title,
          snapshotMd: publishedSnapshots.snapshotMd,
          snapshotHtml: publishedSnapshots.snapshotHtml,
          tocJson: publishedSnapshots.tocJson,
          versionNo: publishedSnapshots.versionNo,
          publicPath: publishedSnapshots.publicPath,
          publishedAt: publishedSnapshots.publishedAt,
          workspaceName: workspaces.name,
          workspaceSlug: workspaces.slug,
        })
        .from(publishedSnapshots)
        .innerJoin(
          workspaces,
          eq(publishedSnapshots.workspaceId, workspaces.id),
        )
        .where(
          and(
            eq(publishedSnapshots.publicPath, publicPath),
            eq(publishedSnapshots.isLive, true),
          ),
        )
        .limit(1);

      if (rows.length === 0) {
        return reply.code(404).send({
          error: "Published document not found",
          code: "DOC_NOT_FOUND",
        });
      }

      const doc = rows[0];

      return reply.code(200).send({
        id: doc.id,
        pageId: doc.pageId,
        title: doc.title,
        html: doc.snapshotHtml,
        markdown: doc.snapshotMd,
        toc: doc.tocJson,
        versionNo: doc.versionNo,
        publicPath: doc.publicPath,
        publishedAt: doc.publishedAt.toISOString(),
        workspace: {
          name: doc.workspaceName,
          slug: doc.workspaceSlug,
        },
      });
    },
  );

  // -----------------------------------------------------------------------
  // GET /docs/:workspaceSlug — List published docs for a workspace
  // -----------------------------------------------------------------------
  fastify.get(
    "/:workspaceSlug",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = publicDocParamsSchema
        .pick({ workspaceSlug: true })
        .safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(reply, paramsResult.error.issues);
      }
      const { workspaceSlug } = paramsResult.data;

      const rows = await fastify.db
        .select({
          workspaceName: workspaces.name,
          workspaceSlug: workspaces.slug,
          id: publishedSnapshots.id,
          pageId: publishedSnapshots.pageId,
          title: publishedSnapshots.title,
          publicPath: publishedSnapshots.publicPath,
          versionNo: publishedSnapshots.versionNo,
          publishedAt: publishedSnapshots.publishedAt,
        })
        .from(workspaces)
        .leftJoin(
          publishedSnapshots,
          and(
            eq(publishedSnapshots.workspaceId, workspaces.id),
            eq(publishedSnapshots.isLive, true),
          ),
        )
        .where(eq(workspaces.slug, workspaceSlug));

      if (rows.length === 0) {
        return reply.code(404).send({
          error: "Workspace not found",
          code: "WORKSPACE_NOT_FOUND",
        });
      }

      const workspace = { name: rows[0].workspaceName, slug: rows[0].workspaceSlug };

      // A left join produces one row with nulls when no snapshots exist
      const docs = rows
        .filter((r) => r.id !== null)
        .map((d) => ({
          id: d.id!,
          pageId: d.pageId!,
          title: d.title!,
          publicPath: d.publicPath!,
          versionNo: d.versionNo!,
          publishedAt: d.publishedAt!.toISOString(),
        }));

      return reply.code(200).send({ workspace, docs });
    },
  );
};

export default docRoutes;
