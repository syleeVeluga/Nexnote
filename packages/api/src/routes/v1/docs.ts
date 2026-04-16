import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { eq, and } from "drizzle-orm";
import { publicDocParamsSchema, ERROR_CODES } from "@nexnote/shared";
import { publishedSnapshots, workspaces, pages } from "@nexnote/db";
import { sendValidationError } from "../../lib/reply-helpers.js";

/**
 * Minimal markdown → HTML fallback for when the publish-renderer worker
 * has not yet filled `snapshotHtml`. Converts markdown to escaped HTML
 * paragraphs so the content is at least readable.
 */
function markdownToBasicHtml(md: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return md
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      // Headings
      const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (headingMatch) {
        const level = headingMatch[1].length;
        return `<h${level}>${escape(headingMatch[2])}</h${level}>`;
      }
      // Code blocks
      if (trimmed.startsWith("```")) {
        const lines = trimmed.split("\n");
        const code = lines.slice(1, -1).join("\n");
        return `<pre><code>${escape(code)}</code></pre>`;
      }
      // Default paragraph
      return `<p>${escape(trimmed)}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

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
          code: ERROR_CODES.DOC_NOT_FOUND,
        });
      }

      const doc = rows[0];

      // If the publish-renderer worker hasn't processed the snapshot yet,
      // produce a basic HTML rendering so the content is still readable.
      const html = doc.snapshotHtml || markdownToBasicHtml(doc.snapshotMd);

      return reply.code(200).send({
        id: doc.id,
        pageId: doc.pageId,
        title: doc.title,
        html,
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
          code: ERROR_CODES.WORKSPACE_NOT_FOUND,
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
