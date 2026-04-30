import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { asc, eq, and, isNull } from "drizzle-orm";
import { publicDocParamsSchema, ERROR_CODES } from "@wekiflow/shared";
import { publishedSnapshots, workspaces, pages } from "@wekiflow/db";
import { sendValidationError } from "../../lib/reply-helpers.js";

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function mapPublicDocListItem(doc: {
  id: string;
  pageId: string;
  title: string;
  publicPath: string;
  versionNo: number;
  publishedAt: Date | string;
}) {
  return {
    id: doc.id,
    pageId: doc.pageId,
    title: doc.title,
    publicPath: doc.publicPath,
    versionNo: doc.versionNo,
    publishedAt: toIso(doc.publishedAt),
  };
}

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
          workspaceId: publishedSnapshots.workspaceId,
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
      const [pageRow] = await fastify.db
        .select({ parentPageId: pages.parentPageId })
        .from(pages)
        .where(and(eq(pages.id, doc.pageId), isNull(pages.deletedAt)))
        .limit(1);

      const parentRows = pageRow?.parentPageId
        ? await fastify.db
            .select({
              id: publishedSnapshots.id,
              pageId: publishedSnapshots.pageId,
              title: publishedSnapshots.title,
              publicPath: publishedSnapshots.publicPath,
              versionNo: publishedSnapshots.versionNo,
              publishedAt: publishedSnapshots.publishedAt,
            })
            .from(publishedSnapshots)
            .where(
              and(
                eq(publishedSnapshots.pageId, pageRow.parentPageId),
                eq(publishedSnapshots.isLive, true),
              ),
            )
            .limit(1)
        : [];
      const childRows = await fastify.db
        .select({
          id: publishedSnapshots.id,
          pageId: publishedSnapshots.pageId,
          title: publishedSnapshots.title,
          publicPath: publishedSnapshots.publicPath,
          versionNo: publishedSnapshots.versionNo,
          publishedAt: publishedSnapshots.publishedAt,
        })
        .from(pages)
        .innerJoin(
          publishedSnapshots,
          and(
            eq(publishedSnapshots.pageId, pages.id),
            eq(publishedSnapshots.isLive, true),
          ),
        )
        .where(
          and(
            eq(pages.workspaceId, doc.workspaceId),
            eq(pages.parentPageId, doc.pageId),
            isNull(pages.deletedAt),
          ),
        )
        .orderBy(asc(pages.sortOrder), asc(pages.title));

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
        publishedAt: toIso(doc.publishedAt),
        parent: parentRows[0] ? mapPublicDocListItem(parentRows[0]) : null,
        children: childRows.map(mapPublicDocListItem),
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

      const workspace = {
        name: rows[0].workspaceName,
        slug: rows[0].workspaceSlug,
      };

      // A left join produces one row with nulls when no snapshots exist
      const docs = rows
        .filter((r) => r.id !== null)
        .map((d) =>
          mapPublicDocListItem({
            id: d.id!,
            pageId: d.pageId!,
            title: d.title!,
            publicPath: d.publicPath!,
            versionNo: d.versionNo!,
            publishedAt: d.publishedAt!,
          }),
        );

      return reply.code(200).send({ workspace, docs });
    },
  );
};

export default docRoutes;
