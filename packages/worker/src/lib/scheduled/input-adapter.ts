import { and, eq, inArray, isNull } from "drizzle-orm";
import { pages } from "@wekiflow/db";
import type { AgentDb } from "../agent/types.js";

export interface ScheduledAgentInput {
  pageIds: string[];
  includeDescendants: boolean;
  instruction?: string | null;
  perRunPageLimit: number;
}

export interface ScheduledAgentAdaptedInput {
  seedPageIds: string[];
  normalizedText: string;
  truncated: boolean;
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
    for (const page of pageRows) {
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
  const instruction = input.instruction?.trim();
  const lines = [
    "# Scheduled wiki reorganize request",
    "",
    "The user selected these existing pages as the maintenance scope.",
    "Call read_page before editing whenever exact current markdown or block IDs are needed.",
    "",
    "## Selected pages",
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
  };
}
