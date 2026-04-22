export interface RawEvidenceRow {
  tripleId: string;
  pageId: string;
  subjectEntityId?: string;
  objectEntityId?: string | null;
  objectLiteral?: string | null;
  spanStart: number | string;
  spanEnd: number | string;
  excerpt: string;
  predicate: string;
}

export interface EvidenceExcerpt {
  tripleId: string;
  predicate: string;
  displayPredicate?: string | null;
  excerpt: string;
  spanStart: number;
  spanEnd: number;
}

function buildEvidenceKey(row: RawEvidenceRow) {
  const objectKey = row.objectEntityId ?? `literal:${row.objectLiteral ?? ""}`;
  const hasLogicalIdentity =
    row.subjectEntityId !== undefined ||
    row.objectEntityId !== undefined ||
    row.objectLiteral !== undefined;

  return [
    row.pageId,
    hasLogicalIdentity ? row.subjectEntityId ?? "" : row.tripleId,
    row.predicate,
    hasLogicalIdentity ? objectKey : row.tripleId,
    row.excerpt,
  ].join("|");
}

export function groupEvidenceByPage(
  rows: RawEvidenceRow[],
  predicateLabelMap: Map<string, string> = new Map(),
): Map<string, EvidenceExcerpt[]> {
  const byPage = new Map<string, EvidenceExcerpt[]>();
  const seen = new Map<string, Set<string>>();

  for (const row of rows) {
    const key = buildEvidenceKey(row);
    const pageSeen = seen.get(row.pageId) ?? new Set<string>();

    if (pageSeen.has(key)) {
      continue;
    }

    const items = byPage.get(row.pageId) ?? [];
    items.push({
      tripleId: row.tripleId,
      predicate: row.predicate,
      displayPredicate: predicateLabelMap.get(row.predicate) ?? null,
      excerpt: row.excerpt,
      spanStart: Number(row.spanStart),
      spanEnd: Number(row.spanEnd),
    });

    pageSeen.add(key);
    seen.set(row.pageId, pageSeen);
    byPage.set(row.pageId, items);
  }

  return byPage;
}
