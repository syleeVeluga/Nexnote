import { and, eq, inArray, isNull } from "drizzle-orm";
import { folders, pages } from "@wekiflow/db";
import type { AgentDb } from "../agent/types.js";

export interface ScheduledAgentInput {
  pageIds: string[];
  targetFolderId?: string | null;
  includeDescendants: boolean;
  instruction?: string | null;
  perRunPageLimit: number;
}

export interface ScheduledAgentAdaptedInput {
  seedPageIds: string[];
  normalizedText: string;
  truncated: boolean;
  targetFolderId?: string | null;
  targetFolderInferred?: boolean;
}

async function loadActivePages(
  db: AgentDb,
  workspaceId: string,
  ids: string[],
): Promise<
  Array<{
    id: string;
    title: string;
    slug: string;
    parentFolderId: string | null;
    parentPageId: string | null;
    currentRevisionId: string | null;
  }>
> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      parentFolderId: pages.parentFolderId,
      parentPageId: pages.parentPageId,
      currentRevisionId: pages.currentRevisionId,
    })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        inArray(pages.id, ids),
        isNull(pages.deletedAt),
      ),
    );
}

function orderPagesByIds<T extends { id: string }>(
  rows: T[],
  ids: string[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

export async function collectScheduledPageIds(
  db: AgentDb,
  workspaceId: string,
  rootPageIds: string[],
  options: { includeDescendants: boolean; limit: number },
): Promise<{ pageIds: string[]; truncated: boolean }> {
  const seen = new Set<string>();
  let frontier = [...new Set(rootPageIds)];
  let truncated = false;

  while (frontier.length > 0) {
    const pageRows = await loadActivePages(db, workspaceId, frontier);
    const accepted: string[] = [];
    for (const page of orderPagesByIds(pageRows, frontier)) {
      if (seen.has(page.id)) continue;
      if (seen.size >= options.limit) {
        truncated = true;
        continue;
      }
      seen.add(page.id);
      accepted.push(page.id);
    }

    if (!options.includeDescendants || seen.size >= options.limit) {
      truncated ||= options.includeDescendants && accepted.length > 0;
      break;
    }
    if (accepted.length === 0) break;

    const children = await db
      .select({ id: pages.id })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          inArray(pages.parentPageId, accepted),
          isNull(pages.deletedAt),
        ),
      );
    frontier = children.map((child) => child.id).filter((id) => !seen.has(id));
  }

  return { pageIds: [...seen], truncated };
}

export async function buildScheduledAgentInput(
  db: AgentDb,
  workspaceId: string,
  input: ScheduledAgentInput,
): Promise<ScheduledAgentAdaptedInput> {
  const { pageIds, truncated } = await collectScheduledPageIds(
    db,
    workspaceId,
    input.pageIds,
    {
      includeDescendants: input.includeDescendants,
      limit: input.perRunPageLimit,
    },
  );
  const pageRows = await loadActivePages(db, workspaceId, pageIds);
  const byId = new Map(pageRows.map((page) => [page.id, page]));
  const orderedPages = pageIds.flatMap((id) => {
    const page = byId.get(id);
    return page ? [page] : [];
  });
  const commonParentFolderIds = [
    ...new Set(
      orderedPages
        .map((page) => page.parentFolderId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const allSelectedPagesLoaded =
    orderedPages.length > 0 && orderedPages.length === pageIds.length;
  const allSelectedPagesShareOneFolder =
    allSelectedPagesLoaded &&
    orderedPages.every((page) => typeof page.parentFolderId === "string") &&
    commonParentFolderIds.length === 1;
  const inferredTargetFolderId =
    input.targetFolderId || !allSelectedPagesShareOneFolder
      ? null
      : (commonParentFolderIds[0] ?? null);
  const effectiveTargetFolderId =
    input.targetFolderId ?? inferredTargetFolderId ?? null;
  const [targetFolder] = effectiveTargetFolderId
    ? await db
        .select({
          id: folders.id,
          name: folders.name,
          slug: folders.slug,
          parentFolderId: folders.parentFolderId,
        })
        .from(folders)
        .where(
          and(
            eq(folders.workspaceId, workspaceId),
            eq(folders.id, effectiveTargetFolderId),
          ),
        )
        .limit(1)
    : [];
  const instruction = input.instruction?.trim();
  const lines = [
    "# User-directed wiki edit request",
    "",
    "The user selected these existing pages as source material, edit targets, or both.",
    "Follow the user instruction as the primary task; do not reinterpret it as cleanup-only.",
    "The agent may write new Markdown pages, edit existing pages, append notes, consolidate selected material, move/rename pages, or merge duplicates when the instruction asks for it.",
    "Preserve selected pages unless the user explicitly asks to delete, archive, or destructively merge them.",
    "If the instruction says to copy, transcribe, move contents, 옮겨 적기, 그대로 두고 내용만 옮기기, or 모두 옮기기 into a new page, treat that as an explicit create_page request that preserves the selected pages' markdown content and order. Do not ask whether to summarize versus copy.",
    "Call read_page before editing whenever exact current markdown or block IDs are needed.",
    targetFolder
      ? inferredTargetFolderId
        ? `All selected pages share target folder "${targetFolder.name}" (${targetFolder.id}) slug=${targetFolder.slug}; create any new pages requested by the user in this same folder.`
        : `Create any new pages requested by the user inside target folder "${targetFolder.name}" (${targetFolder.id}) slug=${targetFolder.slug}.`
      : "No target folder was provided for new pages; only use create_page when the destination is unambiguous.",
    "",
    "## Selected source/target pages",
    ...orderedPages.map(
      (page) =>
        `- ${page.title} (${page.id}) slug=${page.slug} currentRevisionId=${page.currentRevisionId ?? "null"}`,
    ),
  ];
  if (truncated) {
    lines.push("", `Scope was truncated to ${input.perRunPageLimit} pages.`);
  }
  if (instruction) {
    lines.push("", "## User instruction", instruction);
  }
  return {
    seedPageIds: pageIds,
    normalizedText: lines.join("\n"),
    truncated,
    targetFolderId: effectiveTargetFolderId,
    targetFolderInferred: Boolean(inferredTargetFolderId),
  };
}
