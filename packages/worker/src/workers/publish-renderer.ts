import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import type { Root, Element } from "hast";
import { createRedisConnection } from "../connection.js";
import { QUEUE_NAMES } from "../queues.js";
import { getDb } from "@nexnote/db/client";
import { publishedSnapshots, pages } from "@nexnote/db";
import { slugify } from "@nexnote/shared";
import type {
  PublishRendererJobData,
  PublishRendererJobResult,
} from "@nexnote/shared";

// ---------------------------------------------------------------------------
// TOC extraction — collect headings from the hast tree and inject anchor ids
// ---------------------------------------------------------------------------

interface TocEntry {
  id: string;
  text: string;
  level: number;
}

function collectText(node: Element | Root): string {
  let text = "";
  for (const child of node.children) {
    if (child.type === "text") {
      text += child.value;
    } else if (child.type === "element") {
      text += collectText(child);
    }
  }
  return text;
}

function extractToc(tree: Root): TocEntry[] {
  const entries: TocEntry[] = [];
  const slugCounts = new Map<string, number>();

  function walk(node: Root | Element) {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const match = /^h([1-6])$/.exec(child.tagName);
      if (match) {
        const level = Number(match[1]);
        const text = collectText(child);
        let id = slugify(text);

        // Deduplicate ids for repeated headings
        const count = slugCounts.get(id) ?? 0;
        if (count > 0) id = `${id}-${count}`;
        slugCounts.set(id, count + 1);

        child.properties ??= {};
        child.properties["id"] = id;

        entries.push({ id, text, level });
      }
      walk(child);
    }
  }
  walk(tree);
  return entries;
}

// ---------------------------------------------------------------------------
// Markdown → HTML pipeline (created once, reused across all jobs)
// ---------------------------------------------------------------------------

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.["code"] ?? []), "className"],
    span: [...(defaultSchema.attributes?.["span"] ?? []), "className"],
    h1: ["id"],
    h2: ["id"],
    h3: ["id"],
    h4: ["id"],
    h5: ["id"],
    h6: ["id"],
  },
} as typeof defaultSchema;

const mdParser = unified().use(remarkParse).freeze();

const hastPipeline = unified()
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSanitize, sanitizeSchema)
  .use(rehypeHighlight, { detect: true, ignoreMissing: true })
  .use(rehypeStringify)
  .freeze();

async function renderMarkdown(md: string): Promise<{ html: string; toc: TocEntry[] }> {
  const mdAst = mdParser.parse(md);
  const hast = (await hastPipeline.run(mdAst)) as Root;
  const toc = extractToc(hast);
  const html = hastPipeline.stringify(hast) as string;
  return { html, toc };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export function createPublishRendererWorker(): Worker {
  const db = getDb();

  const worker = new Worker<PublishRendererJobData, PublishRendererJobResult>(
    QUEUE_NAMES.PUBLISH,
    async (job: Job<PublishRendererJobData>) => {
      const { snapshotId, pageId } = job.data;

      console.log(
        `[publish-renderer] Rendering snapshot ${snapshotId} for page ${pageId}`,
      );

      const [snapshot] = await db
        .select({ snapshotMd: publishedSnapshots.snapshotMd })
        .from(publishedSnapshots)
        .where(eq(publishedSnapshots.id, snapshotId))
        .limit(1);

      if (!snapshot) {
        throw new Error(`Published snapshot ${snapshotId} not found`);
      }

      await job.updateProgress(20);

      const { html, toc } = await renderMarkdown(snapshot.snapshotMd);

      await job.updateProgress(70);

      await db
        .update(publishedSnapshots)
        .set({ snapshotHtml: html, tocJson: toc })
        .where(eq(publishedSnapshots.id, snapshotId));

      await db
        .update(pages)
        .set({
          latestPublishedSnapshotId: snapshotId,
          status: "published",
          updatedAt: sql`now()`,
        })
        .where(eq(pages.id, pageId));

      await job.updateProgress(100);

      console.log(
        `[publish-renderer] Snapshot ${snapshotId} rendered (${html.length} bytes, ${toc.length} TOC entries)`,
      );

      return {
        snapshotId,
        htmlSize: html.length,
        tocEntries: toc.length,
      };
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
    },
  );

  worker.on("completed", (job, result) => {
    console.log(
      `[publish-renderer] Job ${job.id} completed: snapshot ${result.snapshotId} (${result.htmlSize} bytes)`,
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[publish-renderer] Job ${job?.id ?? "unknown"} failed:`,
      err.message,
    );
  });

  return worker;
}
