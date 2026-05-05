import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { entities, triples } from "@wekiflow/db";
import type { GraphEdge, GraphNode } from "@wekiflow/shared";
import { loadPredicateDisplayLabels } from "./predicate-display-labels.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle query builder doesn't expose a clean shared db/tx interface.
type AnyDb = any;

export type SupportedLocale = "ko" | "en";

interface EntityRow {
  id: string;
  canonicalName: string;
  entityType: string;
}

interface PageCountRow {
  entityId: string;
  pageCount: number;
}

interface EdgeRow {
  id: string;
  subjectEntityId: string;
  objectEntityId: string | null;
  predicate: string;
  confidence: number;
  sourcePageId: string;
}

export async function buildEntityGraph(
  db: AnyDb,
  args: {
    workspaceId: string;
    seedPageIds: string[];
    depth: 1 | 2;
    limit: number;
    minConfidence: number;
    locale: SupportedLocale | undefined;
    restrictToSeedScope: boolean;
  },
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }> {
  const seedPageIds = [...new Set(args.seedPageIds)].filter(Boolean);
  if (seedPageIds.length === 0) {
    return { nodes: [], edges: [], truncated: false };
  }

  // Center entities seed the BFS; without them we have no graph to show.
  const baseConditions = [
    inArray(triples.sourcePageId, seedPageIds),
    eq(triples.workspaceId, args.workspaceId),
    eq(triples.status, "active"),
    ...(args.minConfidence > 0
      ? [gte(triples.confidence, args.minConfidence)]
      : []),
  ];

  const centerTriplesRows = await db
    .select({
      subjectEntityId: triples.subjectEntityId,
      objectEntityId: triples.objectEntityId,
    })
    .from(triples)
    .where(and(...baseConditions));

  const centerEntityIds = new Set<string>();
  for (const row of centerTriplesRows) {
    centerEntityIds.add(row.subjectEntityId);
    if (row.objectEntityId) {
      centerEntityIds.add(row.objectEntityId);
    }
  }

  if (centerEntityIds.size === 0) {
    return { nodes: [], edges: [], truncated: false };
  }

  // BFS expansion discovers neighbors so depth > 1 reveals context. In folder
  // closed mode, every expansion edge must come from one of the seed pages.
  const allEntityIds = new Set(centerEntityIds);
  let frontier = new Set(centerEntityIds);
  const maxBfsNodes = args.limit * 3;

  for (let hop = 1; hop <= args.depth; hop++) {
    if (frontier.size === 0 || allEntityIds.size >= maxBfsNodes) break;

    const frontierArr = [...frontier];
    const CHUNK_SIZE = 1000;
    const neighborRows: Array<{
      subjectEntityId: string;
      objectEntityId: string | null;
    }> = [];

    for (let i = 0; i < frontierArr.length; i += CHUNK_SIZE) {
      const chunk = frontierArr.slice(i, i + CHUNK_SIZE);
      const rows = await db
        .select({
          subjectEntityId: triples.subjectEntityId,
          objectEntityId: triples.objectEntityId,
        })
        .from(triples)
        .where(
          and(
            eq(triples.workspaceId, args.workspaceId),
            eq(triples.status, "active"),
            isNotNull(triples.objectEntityId),
            ...(args.minConfidence > 0
              ? [gte(triples.confidence, args.minConfidence)]
              : []),
            ...(args.restrictToSeedScope
              ? [inArray(triples.sourcePageId, seedPageIds)]
              : []),
            sql`(${inArray(triples.subjectEntityId, chunk)} OR ${inArray(triples.objectEntityId, chunk)})`,
          ),
        );
      neighborRows.push(...rows);
    }

    const nextFrontier = new Set<string>();
    for (const row of neighborRows) {
      if (!allEntityIds.has(row.subjectEntityId)) {
        nextFrontier.add(row.subjectEntityId);
      }
      if (row.objectEntityId && !allEntityIds.has(row.objectEntityId)) {
        nextFrontier.add(row.objectEntityId);
      }
    }

    for (const id of nextFrontier) {
      allEntityIds.add(id);
    }
    frontier = nextFrontier;
  }

  let truncated = false;
  let finalEntityIds: string[];

  if (allEntityIds.size <= args.limit) {
    finalEntityIds = [...allEntityIds];
  } else {
    const nonCenterIds = [...allEntityIds].filter(
      (id) => !centerEntityIds.has(id),
    );

    const connectionCounts = new Map<string, number>();
    if (nonCenterIds.length > 0) {
      const seedScopeSql = args.restrictToSeedScope
        ? sql`AND ${inArray(triples.sourcePageId, seedPageIds)}`
        : sql``;
      const countRows = await db
        .select({
          entityId: sql<string>`e.entity_id`,
          cnt: sql<number>`count(*)`,
        })
        .from(
          sql`(
            SELECT ${triples.subjectEntityId} AS entity_id FROM ${triples}
            WHERE ${triples.workspaceId} = ${args.workspaceId}
              AND ${triples.status} = 'active'
              AND ${inArray(triples.subjectEntityId, nonCenterIds)}
              AND ${isNotNull(triples.objectEntityId)}
              ${seedScopeSql}
              ${args.minConfidence > 0 ? sql`AND ${triples.confidence} >= ${args.minConfidence}` : sql``}
            UNION ALL
            SELECT ${triples.objectEntityId} AS entity_id FROM ${triples}
            WHERE ${triples.workspaceId} = ${args.workspaceId}
              AND ${triples.status} = 'active'
              AND ${inArray(triples.objectEntityId, nonCenterIds)}
              ${seedScopeSql}
              ${args.minConfidence > 0 ? sql`AND ${triples.confidence} >= ${args.minConfidence}` : sql``}
          ) AS e`,
        )
        .groupBy(sql`e.entity_id`);

      for (const r of countRows) {
        connectionCounts.set(r.entityId, Number(r.cnt));
      }
    }

    nonCenterIds.sort(
      (a, b) =>
        (connectionCounts.get(b) ?? 0) - (connectionCounts.get(a) ?? 0),
    );

    const centerArr = [...centerEntityIds].slice(0, args.limit);
    const remaining = args.limit - centerArr.length;
    finalEntityIds = [
      ...centerArr,
      ...nonCenterIds.slice(0, Math.max(0, remaining)),
    ];
    truncated = true;
  }

  const seedScopeCondition = args.restrictToSeedScope
    ? [inArray(triples.sourcePageId, seedPageIds)]
    : [];
  const seedScopeSql = args.restrictToSeedScope
    ? sql`AND ${inArray(triples.sourcePageId, seedPageIds)}`
    : sql``;

  const [entityRows, pageCountRows, edgeRows] = await Promise.all([
    db
      .select({
        id: entities.id,
        canonicalName: entities.canonicalName,
        entityType: entities.entityType,
      })
      .from(entities)
      .where(inArray(entities.id, finalEntityIds)),

    db
      .select({
        entityId: sql<string>`entity_id`,
        pageCount: sql<number>`count(DISTINCT source_page_id)`,
      })
      .from(
        sql`(
          SELECT ${triples.subjectEntityId} AS entity_id, ${triples.sourcePageId} AS source_page_id
          FROM ${triples}
          WHERE ${triples.workspaceId} = ${args.workspaceId}
            AND ${triples.status} = 'active'
            AND ${inArray(triples.subjectEntityId, finalEntityIds)}
            ${seedScopeSql}
          UNION
          SELECT ${triples.objectEntityId} AS entity_id, ${triples.sourcePageId} AS source_page_id
          FROM ${triples}
          WHERE ${triples.workspaceId} = ${args.workspaceId}
            AND ${triples.status} = 'active'
            AND ${isNotNull(triples.objectEntityId)}
            AND ${inArray(triples.objectEntityId, finalEntityIds)}
            ${seedScopeSql}
        ) AS pc`,
      )
      .groupBy(sql`entity_id`),

    db
      .select({
        id: triples.id,
        subjectEntityId: triples.subjectEntityId,
        objectEntityId: triples.objectEntityId,
        predicate: triples.predicate,
        confidence: triples.confidence,
        sourcePageId: triples.sourcePageId,
      })
      .from(triples)
      .where(
        and(
          eq(triples.workspaceId, args.workspaceId),
          eq(triples.status, "active"),
          isNotNull(triples.objectEntityId),
          inArray(triples.subjectEntityId, finalEntityIds),
          inArray(triples.objectEntityId, finalEntityIds),
          ...seedScopeCondition,
          ...(args.minConfidence > 0
            ? [gte(triples.confidence, args.minConfidence)]
            : []),
        ),
      ),
  ]);

  const typedEdgeRows = edgeRows as EdgeRow[];
  const predicateLabelMap = await loadPredicateDisplayLabels(
    db,
    typedEdgeRows.map((row: EdgeRow) => row.predicate),
    args.locale,
  );

  const pageCountMap = new Map<string, number>();
  for (const r of pageCountRows as PageCountRow[]) {
    pageCountMap.set(r.entityId, Number(r.pageCount));
  }

  const edges = typedEdgeRows
    .filter((e: EdgeRow) => e.objectEntityId !== null)
    .map((e: EdgeRow) => ({
      id: e.id,
      source: e.subjectEntityId,
      target: e.objectEntityId!,
      predicate: e.predicate,
      displayPredicate: predicateLabelMap.get(e.predicate) ?? null,
      confidence: e.confidence,
      sourcePageId: e.sourcePageId,
    }));

  const nodes = (entityRows as EntityRow[]).map((e: EntityRow) => ({
    id: e.id,
    label: e.canonicalName,
    type: e.entityType,
    isCenter: centerEntityIds.has(e.id),
    pageCount: pageCountMap.get(e.id) ?? 0,
  }));

  return { nodes, edges, truncated };
}
