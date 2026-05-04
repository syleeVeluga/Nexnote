import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  entities,
  entityAliases,
  folders,
  ingestionDecisions,
  pagePaths,
  pageRevisions,
  pages,
  publishedSnapshots,
  revisionDiffs,
  triples,
} from "@wekiflow/db";
import {
  agentReadToolInputSchemas,
  estimateTokens,
  normalizeKey,
  sliceWithinTokenBudget,
  type AgentReadToolName,
  type FindBacklinksToolInput,
  type FindRelatedEntitiesToolInput,
  type ListFolderToolInput,
  type ListRecentPagesToolInput,
  type ReadPageMetadataToolInput,
  type ReadPageToolInput,
  type ReadRevisionHistoryToolInput,
  type ReadRevisionToolInput,
  type SearchPagesToolInput,
} from "@wekiflow/shared";
import { readPageMarkdownFallbackBudget } from "../budgeter.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolResult,
} from "../types.js";
import { AgentToolError } from "../types.js";

type CandidateMatchSource = "title" | "fts" | "trigram" | "entity";
type MarkdownBlockType =
  | "heading"
  | "code"
  | "list"
  | "table"
  | "blockquote"
  | "paragraph";

interface MarkdownBlock {
  id: string;
  type: MarkdownBlockType;
  content: string;
  charStart: number;
  charEnd: number;
  headingLevel?: number;
  contentCharLength?: number;
  contentTokenEstimate?: number;
  contentTruncated?: boolean;
  droppedChars?: number;
}

const SEARCH_EXCERPT_CHAR_CAP = 1_000;
const DEFAULT_FALLBACK_BLOCK_LIMIT = 200;
const DEFAULT_FALLBACK_BLOCK_CONTENT_TOKENS = 80;

const searchExcerptSql = sql<string>`SUBSTRING(${pageRevisions.contentMd}, 1, ${SEARCH_EXCERPT_CHAR_CAP})`;

function positiveIntEnv(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
  fallback: number,
): number {
  const raw = env?.[key] ?? process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function createPageSummary(row: {
  id: string;
  title: string;
  slug: string;
  path: string | null;
  currentRevisionId: string | null;
  parentFolderId: string | null;
  parentPageId: string | null;
  updatedAt: Date;
  lastAiUpdatedAt: Date | null;
  lastHumanEditedAt: Date | null;
}) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    path: row.path,
    currentRevisionId: row.currentRevisionId,
    parentFolderId: row.parentFolderId,
    parentPageId: row.parentPageId,
    updatedAt: row.updatedAt.toISOString(),
    lastAiUpdatedAt: iso(row.lastAiUpdatedAt),
    lastHumanEditedAt: iso(row.lastHumanEditedAt),
  };
}

function observedPageRevisions(
  rows: Array<{ id: string; currentRevisionId: string | null }>,
) {
  return rows.map((row) => ({
    pageId: row.id,
    revisionId: row.currentRevisionId,
  }));
}

function normalizeQueryWords(text: string, maxWords: number): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of text
    .slice(0, 1_000)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)) {
    if (raw.length <= 2) continue;
    const normalized = normalizeKey(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    words.push(normalized);
    if (words.length >= maxWords) break;
  }
  return words;
}

function buildTsQuery(text: string): string {
  return text
    .slice(0, 300)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 8)
    .join(" & ");
}

function createMarkdownBlockId(index: number, content: string): string {
  const hash = createHash("sha1").update(content).digest("hex").slice(0, 12);
  return `blk_${String(index).padStart(4, "0")}_${hash}`;
}

function blockType(
  content: string,
): Pick<MarkdownBlock, "type" | "headingLevel"> {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trimStart() ?? "";
  const heading = /^(#{1,6})\s+/.exec(firstLine);
  if (heading) {
    return { type: "heading", headingLevel: heading[1].length };
  }
  if (/^(```|~~~)/.test(firstLine)) return { type: "code" };
  if (/^([-*+]\s+|\d+\.\s+|- \[[ xX]\]\s+)/.test(firstLine)) {
    return { type: "list" };
  }
  if (/^\|/.test(firstLine)) return { type: "table" };
  if (/^>/.test(firstLine)) return { type: "blockquote" };
  return { type: "paragraph" };
}

interface MarkdownLine {
  raw: string;
  text: string;
  start: number;
  end: number;
}

function markdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const pattern = /.*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const raw = match[0];
    if (raw === "" && match.index >= markdown.length) break;
    lines.push({
      raw,
      text: raw.replace(/(?:\r\n|\n|\r)$/, ""),
      start: match.index,
      end: match.index + raw.length,
    });
    if (match.index + raw.length >= markdown.length) break;
  }
  return lines;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdownLines(markdown);
  let currentStart: number | null = null;
  let currentEnd = 0;
  let current = "";
  let inFence = false;

  const finish = () => {
    if (currentStart == null || current.trim() === "") {
      currentStart = null;
      currentEnd = 0;
      current = "";
      return;
    }
    const content = current.replace(/(?:\r\n|\n|\r)+$/, "");
    const typeInfo = blockType(content);
    blocks.push({
      id: createMarkdownBlockId(blocks.length, content),
      ...typeInfo,
      content,
      charStart: currentStart,
      charEnd: currentStart + content.length,
    });
    currentStart = null;
    currentEnd = 0;
    current = "";
  };

  for (const line of lines) {
    const trimmed = line.text.trim();
    const fenceLine = /^(```|~~~)/.test(trimmed);

    if (!inFence && trimmed === "") {
      finish();
      continue;
    }

    currentStart ??= line.start;
    current += line.raw;
    currentEnd = line.end;

    if (fenceLine) {
      inFence = !inFence;
    }
  }

  if (currentEnd > 0 || current.trim() !== "") {
    finish();
  }

  return blocks;
}

function summarizeMarkdown(markdown: string) {
  const blocks = parseMarkdownBlocks(markdown);
  const headings = blocks
    .filter((block) => block.type === "heading")
    .map((block) => ({
      id: block.id,
      level: block.headingLevel ?? 1,
      text: block.content.replace(/^#{1,6}\s+/, "").trim(),
    }))
    .slice(0, 40);

  return {
    charLength: markdown.length,
    blockCount: blocks.length,
    headings,
    excerpt: markdown.slice(0, 2_000),
  };
}

function compactBlocksForFallback(
  blocks: MarkdownBlock[],
  env: NodeJS.ProcessEnv | undefined,
): {
  blocks: MarkdownBlock[];
  omittedBlockCount: number;
  contentTruncatedCount: number;
} {
  const limit = positiveIntEnv(
    env,
    "AGENT_READ_PAGE_BLOCK_FALLBACK_LIMIT",
    DEFAULT_FALLBACK_BLOCK_LIMIT,
  );
  const contentTokenBudget = positiveIntEnv(
    env,
    "AGENT_READ_PAGE_BLOCK_FALLBACK_CONTENT_TOKENS",
    DEFAULT_FALLBACK_BLOCK_CONTENT_TOKENS,
  );
  let contentTruncatedCount = 0;

  const compacted = blocks.slice(0, limit).map((block) => {
    const estimatedTokens = estimateTokens(block.content);
    if (estimatedTokens <= contentTokenBudget) {
      return {
        ...block,
        contentCharLength: block.content.length,
        contentTokenEstimate: estimatedTokens,
      };
    }

    const sliced = sliceWithinTokenBudget(block.content, contentTokenBudget, {
      estimatedTokens,
      preserveStructure: true,
    });
    contentTruncatedCount += 1;
    return {
      ...block,
      content: sliced.text,
      contentCharLength: block.content.length,
      contentTokenEstimate: estimatedTokens,
      contentTruncated: true,
      droppedChars: sliced.droppedChars,
    };
  });

  return {
    blocks: compacted,
    omittedBlockCount: Math.max(0, blocks.length - compacted.length),
    contentTruncatedCount,
  };
}

async function searchPages(
  ctx: AgentToolContext,
  input: SearchPagesToolInput,
): Promise<AgentToolResult> {
  const candidates: Array<
    ReturnType<typeof createPageSummary> & {
      excerpt: string;
      matchSources: CandidateMatchSource[];
    }
  > = [];
  const byId = new Map<string, (typeof candidates)[number]>();

  const addMatch = (
    row: {
      id: string;
      title: string;
      slug: string;
      path: string | null;
      currentRevisionId: string | null;
      parentFolderId: string | null;
      parentPageId: string | null;
      updatedAt: Date;
      lastAiUpdatedAt: Date | null;
      lastHumanEditedAt: Date | null;
      excerpt: string | null;
    },
    source: CandidateMatchSource,
  ) => {
    const existing = byId.get(row.id);
    if (existing) {
      if (!existing.matchSources.includes(source)) {
        existing.matchSources.push(source);
      }
      return;
    }
    const candidate = {
      ...createPageSummary(row),
      excerpt: row.excerpt ?? "",
      matchSources: [source],
    };
    byId.set(row.id, candidate);
    candidates.push(candidate);
  };

  const baseSelect = {
    id: pages.id,
    title: pages.title,
    slug: pages.slug,
    path: pagePaths.path,
    currentRevisionId: pages.currentRevisionId,
    parentFolderId: pages.parentFolderId,
    parentPageId: pages.parentPageId,
    updatedAt: pages.updatedAt,
    lastAiUpdatedAt: pages.lastAiUpdatedAt,
    lastHumanEditedAt: pages.lastHumanEditedAt,
    excerpt: searchExcerptSql,
  };

  const titleMatches = await ctx.db
    .select(baseSelect)
    .from(pages)
    .leftJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
    .leftJoin(
      pagePaths,
      and(eq(pagePaths.pageId, pages.id), eq(pagePaths.isCurrent, true)),
    )
    .where(
      and(
        eq(pages.workspaceId, ctx.workspaceId),
        isNull(pages.deletedAt),
        sql`LOWER(${pages.title}) LIKE LOWER(${"%" + input.query + "%"})`,
      ),
    )
    .limit(Math.min(input.limit, 10));

  for (const row of titleMatches) addMatch(row, "title");

  if (candidates.length < input.limit) {
    const tsQuery = buildTsQuery(input.query);
    if (tsQuery) {
      try {
        const ftsMatches = await ctx.db
          .select(baseSelect)
          .from(pages)
          .innerJoin(
            pageRevisions,
            eq(pageRevisions.id, pages.currentRevisionId),
          )
          .leftJoin(
            pagePaths,
            and(eq(pagePaths.pageId, pages.id), eq(pagePaths.isCurrent, true)),
          )
          .where(
            and(
              eq(pages.workspaceId, ctx.workspaceId),
              isNull(pages.deletedAt),
              sql`TO_TSVECTOR('english', ${pageRevisions.contentMd}) @@ TO_TSQUERY('english', ${tsQuery})`,
            ),
          )
          .orderBy(
            sql`TS_RANK(TO_TSVECTOR('english', ${pageRevisions.contentMd}), TO_TSQUERY('english', ${tsQuery})) DESC`,
          )
          .limit(input.limit);

        for (const row of ftsMatches) addMatch(row, "fts");
      } catch {
        // pg parser errors for unusual terms should not abort exploration.
      }
    }
  }

  if (candidates.length < input.limit) {
    try {
      const trigramMatches = await ctx.db
        .select(baseSelect)
        .from(pages)
        .leftJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
        .leftJoin(
          pagePaths,
          and(eq(pagePaths.pageId, pages.id), eq(pagePaths.isCurrent, true)),
        )
        .where(
          and(
            eq(pages.workspaceId, ctx.workspaceId),
            isNull(pages.deletedAt),
            sql`SIMILARITY(${pages.title}, ${input.query.slice(0, 200)}) > 0.1`,
          ),
        )
        .orderBy(
          sql`SIMILARITY(${pages.title}, ${input.query.slice(0, 200)}) DESC`,
        )
        .limit(input.limit);

      for (const row of trigramMatches) addMatch(row, "trigram");
    } catch {
      // pg_trgm may be unavailable in older local DBs; other strategies remain.
    }
  }

  if (candidates.length < input.limit) {
    const words = normalizeQueryWords(input.query, 12);
    if (words.length > 0) {
      const entityMatches = await ctx.db
        .select(baseSelect)
        .from(pages)
        .innerJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
        .innerJoin(triples, eq(triples.sourcePageId, pages.id))
        .innerJoin(entities, eq(entities.id, triples.subjectEntityId))
        .leftJoin(
          pagePaths,
          and(eq(pagePaths.pageId, pages.id), eq(pagePaths.isCurrent, true)),
        )
        .where(
          and(
            eq(pages.workspaceId, ctx.workspaceId),
            isNull(pages.deletedAt),
            inArray(entities.normalizedKey, words),
          ),
        )
        .groupBy(
          pages.id,
          pages.title,
          pages.slug,
          pagePaths.path,
          pages.currentRevisionId,
          pages.parentFolderId,
          pages.parentPageId,
          pages.updatedAt,
          pages.lastAiUpdatedAt,
          pages.lastHumanEditedAt,
          pageRevisions.contentMd,
        )
        .orderBy(sql`COUNT(DISTINCT ${entities.id}) DESC`)
        .limit(input.limit);

      for (const row of entityMatches) addMatch(row, "entity");
    }
  }

  const result = { pages: candidates.slice(0, input.limit) };
  return {
    data: result,
    observedPageIds: result.pages.map((page) => page.id),
    observedPageRevisions: observedPageRevisions(result.pages),
  };
}

async function readPage(
  ctx: AgentToolContext,
  input: ReadPageToolInput,
): Promise<AgentToolResult> {
  const [row] = await ctx.db
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      path: pagePaths.path,
      currentRevisionId: pages.currentRevisionId,
      parentFolderId: pages.parentFolderId,
      parentPageId: pages.parentPageId,
      updatedAt: pages.updatedAt,
      lastAiUpdatedAt: pages.lastAiUpdatedAt,
      lastHumanEditedAt: pages.lastHumanEditedAt,
      contentMd: pageRevisions.contentMd,
      contentJson: pageRevisions.contentJson,
      revisionCreatedAt: pageRevisions.createdAt,
    })
    .from(pages)
    .leftJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
    .leftJoin(
      pagePaths,
      and(eq(pagePaths.pageId, pages.id), eq(pagePaths.isCurrent, true)),
    )
    .where(
      and(
        eq(pages.workspaceId, ctx.workspaceId),
        eq(pages.id, input.pageId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new AgentToolError("not_found", `Page ${input.pageId} not found`);
  }

  const contentMd = row.contentMd ?? "";
  const page = createPageSummary(row);
  const base = {
    page,
    revision: {
      id: row.currentRevisionId,
      createdAt: iso(row.revisionCreatedAt),
    },
  };

  if (input.format === "summary") {
    return {
      data: {
        ...base,
        format: "summary",
        summary: summarizeMarkdown(contentMd),
      },
      observedPageIds: [row.id],
      observedPageRevisions: [
        { pageId: row.id, revisionId: row.currentRevisionId },
      ],
    };
  }

  if (input.format === "blocks") {
    const blocks = parseMarkdownBlocks(contentMd);
    return {
      data: { ...base, format: "blocks", blocks },
      observedPageIds: [row.id],
      observedPageRevisions: [
        { pageId: row.id, revisionId: row.currentRevisionId },
      ],
      observedBlockIds: blocks.map((block) => block.id),
    };
  }

  const fallback = readPageMarkdownFallbackBudget({
    contentMd,
    provider: ctx.model?.provider,
    model: ctx.model?.model,
    env: ctx.env,
  });
  if (fallback.shouldFallback) {
    const allBlocks = parseMarkdownBlocks(contentMd);
    const compacted = compactBlocksForFallback(allBlocks, ctx.env);
    return {
      data: {
        ...base,
        format: "blocks",
        requestedFormat: "markdown",
        fallback: {
          type: "markdown_to_blocks",
          reason:
            "Full markdown exceeded the safe read_page context threshold.",
          estimatedTokens: fallback.estimatedTokens,
          thresholdTokens: fallback.thresholdTokens,
          capacityTokens: fallback.capacityTokens,
          thresholdRatio: fallback.thresholdRatio,
          tokenLimit: fallback.tokenLimit,
          provider: fallback.provider,
          model: fallback.model,
          originalCharLength: contentMd.length,
          totalBlockCount: allBlocks.length,
          returnedBlockCount: compacted.blocks.length,
          omittedBlockCount: compacted.omittedBlockCount,
          contentTruncatedCount: compacted.contentTruncatedCount,
          notice:
            "This is a compact block listing, not full markdown. Use block IDs for narrow edits, or request summary/blocks again if exact context is needed.",
        },
        blocks: compacted.blocks,
      },
      observedPageIds: [row.id],
      observedPageRevisions: [
        { pageId: row.id, revisionId: row.currentRevisionId },
      ],
      observedBlockIds: compacted.blocks.map((block) => block.id),
    };
  }

  return {
    data: {
      ...base,
      format: "markdown",
      contentMd,
      contentJson: row.contentJson,
    },
    observedPageIds: [row.id],
    observedPageRevisions: [
      { pageId: row.id, revisionId: row.currentRevisionId },
    ],
  };
}

async function listFolder(
  ctx: AgentToolContext,
  input: ListFolderToolInput,
): Promise<AgentToolResult> {
  const folderId = input.folderId ?? null;

  if (folderId) {
    const [folder] = await ctx.db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(eq(folders.workspaceId, ctx.workspaceId), eq(folders.id, folderId)),
      )
      .limit(1);
    if (!folder) {
      throw new AgentToolError("not_found", `Folder ${folderId} not found`);
    }
  }

  const folderCondition = folderId
    ? eq(folders.parentFolderId, folderId)
    : isNull(folders.parentFolderId);
  const pageFolderCondition = folderId
    ? eq(pages.parentFolderId, folderId)
    : isNull(pages.parentFolderId);

  const [childFolders, childPages] = await Promise.all([
    ctx.db
      .select({
        id: folders.id,
        name: folders.name,
        slug: folders.slug,
        parentFolderId: folders.parentFolderId,
        sortOrder: folders.sortOrder,
        updatedAt: folders.updatedAt,
      })
      .from(folders)
      .where(and(eq(folders.workspaceId, ctx.workspaceId), folderCondition))
      .orderBy(asc(folders.sortOrder), asc(folders.name))
      .limit(100),
    ctx.db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        path: pagePaths.path,
        currentRevisionId: pages.currentRevisionId,
        parentFolderId: pages.parentFolderId,
        parentPageId: pages.parentPageId,
        updatedAt: pages.updatedAt,
        lastAiUpdatedAt: pages.lastAiUpdatedAt,
        lastHumanEditedAt: pages.lastHumanEditedAt,
        sortOrder: pages.sortOrder,
      })
      .from(pages)
      .leftJoin(
        pagePaths,
        and(eq(pagePaths.pageId, pages.id), eq(pagePaths.isCurrent, true)),
      )
      .where(
        and(
          eq(pages.workspaceId, ctx.workspaceId),
          isNull(pages.deletedAt),
          pageFolderCondition,
          isNull(pages.parentPageId),
        ),
      )
      .orderBy(asc(pages.sortOrder), asc(pages.title))
      .limit(100),
  ]);

  const result = {
    folderId,
    folders: childFolders.map((folder) => ({
      ...folder,
      updatedAt: folder.updatedAt.toISOString(),
    })),
    pages: childPages.map((page) => ({
      ...createPageSummary(page),
      sortOrder: page.sortOrder,
    })),
  };

  return {
    data: result,
    observedPageIds: result.pages.map((page) => page.id),
    observedPageRevisions: observedPageRevisions(result.pages),
    observedFolderIds: [
      ...(folderId ? [folderId] : []),
      ...result.folders.map((folder) => folder.id),
    ],
  };
}

async function findRelatedEntities(
  ctx: AgentToolContext,
  input: FindRelatedEntitiesToolInput,
): Promise<AgentToolResult> {
  const words = normalizeQueryWords(input.text, 40);
  if (words.length === 0) {
    return { data: { entities: [], pages: [] }, observedPageIds: [] };
  }

  const [entityRows, aliasRows] = await Promise.all([
    ctx.db
      .select({
        id: entities.id,
        canonicalName: entities.canonicalName,
        normalizedKey: entities.normalizedKey,
        entityType: entities.entityType,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, ctx.workspaceId),
          inArray(entities.normalizedKey, words),
        ),
      )
      .limit(input.limit),
    ctx.db
      .select({
        id: entities.id,
        canonicalName: entities.canonicalName,
        normalizedKey: entities.normalizedKey,
        entityType: entities.entityType,
        alias: entityAliases.alias,
        normalizedAlias: entityAliases.normalizedAlias,
      })
      .from(entityAliases)
      .innerJoin(entities, eq(entities.id, entityAliases.entityId))
      .where(
        and(
          eq(entities.workspaceId, ctx.workspaceId),
          eq(entityAliases.status, "active"),
          inArray(entityAliases.normalizedAlias, words),
        ),
      )
      .limit(input.limit),
  ]);

  const byId = new Map<
    string,
    {
      id: string;
      canonicalName: string;
      normalizedKey: string;
      entityType: string;
      matchedAliases: string[];
    }
  >();

  for (const row of entityRows) {
    byId.set(row.id, { ...row, matchedAliases: [] });
  }
  for (const row of aliasRows) {
    const existing = byId.get(row.id);
    if (existing) {
      if (!existing.matchedAliases.includes(row.alias)) {
        existing.matchedAliases.push(row.alias);
      }
    } else {
      byId.set(row.id, {
        id: row.id,
        canonicalName: row.canonicalName,
        normalizedKey: row.normalizedKey,
        entityType: row.entityType,
        matchedAliases: [row.alias],
      });
    }
  }

  const matchedEntities = [...byId.values()].slice(0, input.limit);
  const entityIds = matchedEntities.map((entity) => entity.id);
  if (entityIds.length === 0) {
    return { data: { entities: [], pages: [] }, observedPageIds: [] };
  }

  const relatedPages = await ctx.db
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      path: pagePaths.path,
      currentRevisionId: pages.currentRevisionId,
      parentFolderId: pages.parentFolderId,
      parentPageId: pages.parentPageId,
      updatedAt: pages.updatedAt,
      lastAiUpdatedAt: pages.lastAiUpdatedAt,
      lastHumanEditedAt: pages.lastHumanEditedAt,
      matchedTripleCount: sql<number>`COUNT(DISTINCT ${triples.id})::int`,
    })
    .from(triples)
    .innerJoin(pages, eq(pages.id, triples.sourcePageId))
    .leftJoin(
      pagePaths,
      and(eq(pagePaths.pageId, pages.id), eq(pagePaths.isCurrent, true)),
    )
    .where(
      and(
        eq(triples.workspaceId, ctx.workspaceId),
        eq(triples.status, "active"),
        isNull(pages.deletedAt),
        or(
          inArray(triples.subjectEntityId, entityIds),
          inArray(triples.objectEntityId, entityIds),
        ),
      ),
    )
    .groupBy(
      pages.id,
      pages.title,
      pages.slug,
      pagePaths.path,
      pages.currentRevisionId,
      pages.parentFolderId,
      pages.parentPageId,
      pages.updatedAt,
      pages.lastAiUpdatedAt,
      pages.lastHumanEditedAt,
    )
    .orderBy(desc(sql`COUNT(DISTINCT ${triples.id})`))
    .limit(input.limit);

  const result = {
    entities: matchedEntities,
    pages: relatedPages.map((page) => ({
      ...createPageSummary(page),
      matchedTripleCount: page.matchedTripleCount,
    })),
  };

  return {
    data: result,
    observedPageIds: result.pages.map((page) => page.id),
    observedPageRevisions: observedPageRevisions(result.pages),
  };
}

async function listRecentPages(
  ctx: AgentToolContext,
  input: ListRecentPagesToolInput,
): Promise<AgentToolResult> {
  const lastTouched = sql<Date>`GREATEST(
    COALESCE(${pages.lastAiUpdatedAt}, 'epoch'::timestamptz),
    COALESCE(${pages.lastHumanEditedAt}, 'epoch'::timestamptz),
    ${pages.updatedAt}
  )`;

  const rows = await ctx.db
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      path: pagePaths.path,
      currentRevisionId: pages.currentRevisionId,
      parentFolderId: pages.parentFolderId,
      parentPageId: pages.parentPageId,
      updatedAt: pages.updatedAt,
      lastAiUpdatedAt: pages.lastAiUpdatedAt,
      lastHumanEditedAt: pages.lastHumanEditedAt,
      lastTouchedAt: lastTouched,
    })
    .from(pages)
    .leftJoin(
      pagePaths,
      and(eq(pagePaths.pageId, pages.id), eq(pagePaths.isCurrent, true)),
    )
    .where(and(eq(pages.workspaceId, ctx.workspaceId), isNull(pages.deletedAt)))
    .orderBy(desc(lastTouched))
    .limit(input.limit);

  const result = {
    pages: rows.map((row) => ({
      ...createPageSummary(row),
      lastTouchedAt: row.lastTouchedAt.toISOString(),
    })),
  };

  return {
    data: result,
    observedPageIds: result.pages.map((page) => page.id),
    observedPageRevisions: observedPageRevisions(result.pages),
  };
}

async function buildParentPath(
  ctx: AgentToolContext,
  page: { parentPageId: string | null; parentFolderId: string | null },
): Promise<string> {
  const segments: string[] = [];
  let currentParentPageId = page.parentPageId;
  let currentFolderId = page.parentFolderId;
  const visitedPages = new Set<string>();

  while (currentParentPageId && !visitedPages.has(currentParentPageId)) {
    visitedPages.add(currentParentPageId);
    const [parentPage] = await ctx.db
      .select({
        id: pages.id,
        title: pages.title,
        parentPageId: pages.parentPageId,
        parentFolderId: pages.parentFolderId,
      })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, ctx.workspaceId),
          eq(pages.id, currentParentPageId),
          isNull(pages.deletedAt),
        ),
      )
      .limit(1);
    if (!parentPage) break;
    segments.unshift(parentPage.title);
    currentParentPageId = parentPage.parentPageId;
    if (!currentFolderId) currentFolderId = parentPage.parentFolderId;
  }

  const visitedFolders = new Set<string>();
  while (currentFolderId && !visitedFolders.has(currentFolderId)) {
    visitedFolders.add(currentFolderId);
    const [folder] = await ctx.db
      .select({
        id: folders.id,
        name: folders.name,
        parentFolderId: folders.parentFolderId,
      })
      .from(folders)
      .where(
        and(
          eq(folders.workspaceId, ctx.workspaceId),
          eq(folders.id, currentFolderId),
        ),
      )
      .limit(1);
    if (!folder) break;
    segments.unshift(folder.name);
    currentFolderId = folder.parentFolderId;
  }

  return segments.join(" / ");
}

async function readPageMetadata(
  ctx: AgentToolContext,
  input: ReadPageMetadataToolInput,
): Promise<AgentToolResult> {
  const [row] = await ctx.db
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      parentPageId: pages.parentPageId,
      parentFolderId: pages.parentFolderId,
      currentRevisionId: pages.currentRevisionId,
      lastAiUpdatedAt: pages.lastAiUpdatedAt,
      lastHumanEditedAt: pages.lastHumanEditedAt,
      latestPublishedSnapshotId: pages.latestPublishedSnapshotId,
      contentMd: pageRevisions.contentMd,
    })
    .from(pages)
    .leftJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
    .where(
      and(
        eq(pages.workspaceId, ctx.workspaceId),
        eq(pages.id, input.pageId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new AgentToolError("not_found", `Page ${input.pageId} not found`);
  }

  const [{ value: childCount } = { value: 0 }] = await ctx.db
    .select({ value: count() })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, ctx.workspaceId),
        eq(pages.parentPageId, row.id),
        isNull(pages.deletedAt),
      ),
    );

  const [livePublished] = await ctx.db
    .select({ id: publishedSnapshots.id })
    .from(publishedSnapshots)
    .where(
      and(
        eq(publishedSnapshots.workspaceId, ctx.workspaceId),
        eq(publishedSnapshots.pageId, row.id),
        eq(publishedSnapshots.isLive, true),
      ),
    )
    .limit(1);

  const [{ value: openSuggestions } = { value: 0 }] = await ctx.db
    .select({ value: count() })
    .from(ingestionDecisions)
    .where(
      and(
        eq(ingestionDecisions.targetPageId, row.id),
        eq(ingestionDecisions.status, "suggested"),
      ),
    );

  const parentPath = await buildParentPath(ctx, {
    parentPageId: row.parentPageId,
    parentFolderId: row.parentFolderId,
  });

  const fmResult = parseFrontmatter(row.contentMd ?? "");

  return {
    data: {
      pageId: row.id,
      title: row.title,
      slug: row.slug,
      parentPageId: row.parentPageId,
      parentFolderId: row.parentFolderId,
      parentPath,
      currentRevisionId: row.currentRevisionId,
      lastAiUpdatedAt: iso(row.lastAiUpdatedAt),
      lastHumanEditedAt: iso(row.lastHumanEditedAt),
      frontmatter: fmResult.data,
      ...(fmResult.parseError ? { frontmatterParseError: fmResult.parseError } : {}),
      childCount: Number(childCount ?? 0),
      isPublished: Boolean(livePublished),
      hasOpenSuggestions: Number(openSuggestions ?? 0) > 0,
    },
    observedPageIds: [row.id],
    observedPageRevisions: [
      { pageId: row.id, revisionId: row.currentRevisionId },
    ],
  };
}

const SHORT_TITLE_THRESHOLD = 3;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type BacklinkMatchType =
  | "wikilink_title"
  | "wikilink_slug"
  | "markdown_link";

function classifyBacklink(
  contentMd: string,
  title: string,
  slug: string,
  options: { allowTitleWikilink: boolean },
): { matchType: BacklinkMatchType; index: number } | null {
  const tests: Array<{ matchType: BacklinkMatchType; pattern: RegExp }> = [];
  if (options.allowTitleWikilink) {
    tests.push({
      matchType: "wikilink_title",
      pattern: new RegExp(
        `\\[\\[${escapeRegex(title)}(?:\\|[^\\]]*)?\\]\\]`,
        "i",
      ),
    });
  }
  tests.push({
    matchType: "wikilink_slug",
    pattern: new RegExp(
      `\\[\\[${escapeRegex(slug)}(?:\\|[^\\]]*)?\\]\\]`,
      "i",
    ),
  });
  tests.push({
    matchType: "markdown_link",
    pattern: new RegExp(
      `\\]\\((?:[^)\\s]*\\/)?${escapeRegex(slug)}(?:[#?][^)]*)?\\)`,
      "i",
    ),
  });

  for (const test of tests) {
    const match = test.pattern.exec(contentMd);
    if (match) {
      return { matchType: test.matchType, index: match.index };
    }
  }
  return null;
}

function buildSnippet(contentMd: string, index: number): string {
  const start = Math.max(0, index - 50);
  const end = Math.min(contentMd.length, index + 50);
  const slice = contentMd.slice(start, end).replace(/\s+/g, " ").trim();
  return slice;
}

async function findBacklinks(
  ctx: AgentToolContext,
  input: FindBacklinksToolInput,
): Promise<AgentToolResult> {
  const [target] = await ctx.db
    .select({ id: pages.id, title: pages.title, slug: pages.slug })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, ctx.workspaceId),
        eq(pages.id, input.pageId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);

  if (!target) {
    throw new AgentToolError("not_found", `Page ${input.pageId} not found`);
  }

  const allowTitleWikilink = target.title.length >= SHORT_TITLE_THRESHOLD;
  const titleLike = `%[[${escapeLikePattern(target.title)}%`;
  const slugLike = `%[[${escapeLikePattern(target.slug)}%`;
  const slugRegex = `\\]\\((?:[^)\\s]*/)?${escapeRegex(target.slug)}(?:[#?][^)]*)?\\)`;

  const orClauses = [
    sql`${pageRevisions.contentMd} ILIKE ${slugLike}`,
    sql`${pageRevisions.contentMd} ~ ${slugRegex}`,
  ];
  if (allowTitleWikilink) {
    orClauses.unshift(
      sql`${pageRevisions.contentMd} ILIKE ${titleLike}`,
    );
  }

  const probeLimit = input.limit + 1;
  const rows = await ctx.db
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      currentRevisionId: pages.currentRevisionId,
      contentMd: pageRevisions.contentMd,
      lastAiUpdatedAt: pages.lastAiUpdatedAt,
    })
    .from(pages)
    .innerJoin(pageRevisions, eq(pageRevisions.id, pages.currentRevisionId))
    .where(
      and(
        eq(pages.workspaceId, ctx.workspaceId),
        isNull(pages.deletedAt),
        ne(pages.id, target.id),
        or(...orClauses)!,
      ),
    )
    .orderBy(desc(pages.lastAiUpdatedAt))
    .limit(probeLimit);

  const limited = rows.length > input.limit;
  const taken = limited ? rows.slice(0, input.limit) : rows;
  const backlinks = taken
    .map((row) => {
      const classified = classifyBacklink(
        row.contentMd ?? "",
        target.title,
        target.slug,
        { allowTitleWikilink },
      );
      if (!classified) return null;
      return {
        pageId: row.id,
        title: row.title,
        slug: row.slug,
        snippet: buildSnippet(row.contentMd ?? "", classified.index),
        matchType: classified.matchType,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  const observedRevisions = taken
    .filter((row): row is typeof row & { currentRevisionId: string } =>
      Boolean(row.currentRevisionId),
    )
    .map((row) => ({
      pageId: row.id,
      revisionId: row.currentRevisionId,
    }));

  return {
    data: {
      backlinks,
      total: backlinks.length,
      limited,
      shortTitleSkipped: !allowTitleWikilink,
      confidenceHint:
        "ILIKE-based backlink scan — verify before destructive operations.",
    },
    observedPageIds: taken.map((row) => row.id),
    observedPageRevisions: observedRevisions,
  };
}

async function readRevisionHistory(
  ctx: AgentToolContext,
  input: ReadRevisionHistoryToolInput,
): Promise<AgentToolResult> {
  const [page] = await ctx.db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, ctx.workspaceId),
        eq(pages.id, input.pageId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);
  if (!page) {
    throw new AgentToolError("not_found", `Page ${input.pageId} not found`);
  }

  const probeLimit = input.limit + 1;
  const rows = await ctx.db
    .select({
      id: pageRevisions.id,
      pageId: pageRevisions.pageId,
      baseRevisionId: pageRevisions.baseRevisionId,
      actorUserId: pageRevisions.actorUserId,
      actorType: pageRevisions.actorType,
      source: pageRevisions.source,
      revisionNote: pageRevisions.revisionNote,
      createdAt: pageRevisions.createdAt,
      changedBlocks: revisionDiffs.changedBlocks,
      sourceIngestionId: pageRevisions.sourceIngestionId,
      sourceDecisionId: pageRevisions.sourceDecisionId,
    })
    .from(pageRevisions)
    .leftJoin(revisionDiffs, eq(pageRevisions.id, revisionDiffs.revisionId))
    .where(eq(pageRevisions.pageId, input.pageId))
    .orderBy(desc(pageRevisions.createdAt))
    .limit(probeLimit);

  const limited = rows.length > input.limit;
  const taken = limited ? rows.slice(0, input.limit) : rows;
  const revisions = taken.map((row) => ({
    id: row.id,
    pageId: row.pageId,
    baseRevisionId: row.baseRevisionId,
    actorUserId: row.actorUserId,
    actorType: row.actorType,
    source: row.source,
    revisionNote: row.revisionNote,
    createdAt: row.createdAt.toISOString(),
    changedBlocks: row.changedBlocks ?? null,
    sourceIngestionId: row.sourceIngestionId ?? null,
    sourceDecisionId: row.sourceDecisionId ?? null,
  }));

  return {
    data: {
      revisions,
      total: revisions.length,
      limited,
    },
    observedPageIds: [input.pageId],
    observedRevisionIds: revisions.map((revision) => revision.id),
  };
}

async function isRevisionInCurrentPageChain(
  ctx: AgentToolContext,
  pageId: string,
  revisionId: string,
  currentRevisionId: string | null,
): Promise<boolean> {
  const visited = new Set<string>();
  let cursor = currentRevisionId;

  for (let depth = 0; cursor && depth < 100; depth += 1) {
    if (cursor === revisionId) return true;
    if (visited.has(cursor)) return false;
    visited.add(cursor);

    const [revision] = await ctx.db
      .select({
        id: pageRevisions.id,
        baseRevisionId: pageRevisions.baseRevisionId,
      })
      .from(pageRevisions)
      .where(and(eq(pageRevisions.id, cursor), eq(pageRevisions.pageId, pageId)))
      .limit(1);

    if (!revision) return false;
    cursor = revision.baseRevisionId;
  }

  return false;
}

async function readRevision(
  ctx: AgentToolContext,
  input: ReadRevisionToolInput,
): Promise<AgentToolResult> {
  const [row] = await ctx.db
    .select({
      id: pageRevisions.id,
      pageId: pageRevisions.pageId,
      baseRevisionId: pageRevisions.baseRevisionId,
      actorUserId: pageRevisions.actorUserId,
      actorType: pageRevisions.actorType,
      source: pageRevisions.source,
      revisionNote: pageRevisions.revisionNote,
      createdAt: pageRevisions.createdAt,
      contentMd: pageRevisions.contentMd,
      contentJson: pageRevisions.contentJson,
      diffMd: revisionDiffs.diffMd,
      diffOpsJson: revisionDiffs.diffOpsJson,
      pageWorkspaceId: pages.workspaceId,
      pageDeletedAt: pages.deletedAt,
      pageCurrentRevisionId: pages.currentRevisionId,
    })
    .from(pageRevisions)
    .innerJoin(pages, eq(pages.id, pageRevisions.pageId))
    .leftJoin(revisionDiffs, eq(revisionDiffs.revisionId, pageRevisions.id))
    .where(eq(pageRevisions.id, input.revisionId))
    .limit(1);

  if (!row || row.pageWorkspaceId !== ctx.workspaceId || row.pageDeletedAt) {
    throw new AgentToolError(
      "not_found",
      `Revision ${input.revisionId} not found`,
    );
  }

  const allowedFromRevisionChain = ctx.state.seenRevisionIds.has(
    input.revisionId,
  );
  const allowedFromPageChain =
    ctx.state.seenPageIds.has(row.pageId) &&
    (await isRevisionInCurrentPageChain(
      ctx,
      row.pageId,
      input.revisionId,
      row.pageCurrentRevisionId,
    ));
  if (!allowedFromRevisionChain && !allowedFromPageChain) {
    throw new AgentToolError(
      "invalid_target_page",
      "Revision must come from revision history this run already observed, or from the observed page's current revision chain.",
      undefined,
      {
        hint:
          "Call read_revision_history for the page first, or read_page/read_page_metadata to register the page.",
      },
    );
  }

  return {
    data: {
      id: row.id,
      pageId: row.pageId,
      baseRevisionId: row.baseRevisionId,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      source: row.source,
      revisionNote: row.revisionNote,
      createdAt: row.createdAt.toISOString(),
      contentMd: input.includeContent ? row.contentMd : null,
      contentJson: input.includeContent ? row.contentJson : null,
      lineDiff: row.diffMd ?? null,
      blockOpsDiff: row.diffOpsJson ?? null,
    },
    observedPageIds: [row.pageId],
    observedRevisionIds: [row.id],
    observedPageRevisions: [{ pageId: row.pageId, revisionId: row.id }],
  };
}

export function createReadOnlyTools(): Record<
  AgentReadToolName,
  AgentToolDefinition
> {
  return {
    search_pages: {
      name: "search_pages",
      description:
        "Search pages in the current workspace by title, full-text content, trigram title similarity, and entity overlap.",
      schema: agentReadToolInputSchemas.search_pages,
      execute: searchPages,
    },
    read_page: {
      name: "read_page",
      description:
        "Read a current workspace page as full markdown, deterministic summary, or markdown blocks with stable block IDs.",
      schema: agentReadToolInputSchemas.read_page,
      execute: readPage,
    },
    list_folder: {
      name: "list_folder",
      description:
        "List child folders and top-level pages under a folder in the current workspace. Omit folderId for root.",
      schema: agentReadToolInputSchemas.list_folder,
      execute: listFolder,
    },
    find_related_entities: {
      name: "find_related_entities",
      description:
        "Find known entities matching text and pages connected through active triples in the current workspace.",
      schema: agentReadToolInputSchemas.find_related_entities,
      execute: findRelatedEntities,
    },
    list_recent_pages: {
      name: "list_recent_pages",
      description:
        "List recently touched pages in the current workspace using AI, human, and page update timestamps.",
      schema: agentReadToolInputSchemas.list_recent_pages,
      execute: listRecentPages,
    },
    read_page_metadata: {
      name: "read_page_metadata",
      description:
        "Return lightweight metadata for a page (title, parent path, frontmatter, timestamps, child count, publish status, open suggestions). Saves tokens vs full read_page when you only need triage.",
      schema: agentReadToolInputSchemas.read_page_metadata,
      execute: readPageMetadata,
    },
    find_backlinks: {
      name: "find_backlinks",
      description:
        "ILIKE-scan the workspace for pages whose latest revision references the target page by wikilink or markdown link slug. Use before delete_page or merge_pages to evaluate dependencies.",
      schema: agentReadToolInputSchemas.find_backlinks,
      execute: findBacklinks,
    },
    read_revision_history: {
      name: "read_revision_history",
      description:
        "List recent revisions for a page (newest first) so the agent can review past human/AI edits before self-correcting.",
      schema: agentReadToolInputSchemas.read_revision_history,
      execute: readRevisionHistory,
    },
    read_revision: {
      name: "read_revision",
      description:
        "Read a single revision (content + diff) so the agent can verify a rollback target. Requires the revision or its page to have been observed earlier in this run.",
      schema: agentReadToolInputSchemas.read_revision,
      execute: readRevision,
    },
  };
}
