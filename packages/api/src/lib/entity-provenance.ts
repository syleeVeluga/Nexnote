export interface RawEvidenceRow {
  tripleId: string;
  pageId: string;
  spanStart: number | string;
  spanEnd: number | string;
  excerpt: string;
  predicate: string;
}

export interface EvidenceExcerpt {
  tripleId: string;
  predicate: string;
  excerpt: string;
  spanStart: number;
  spanEnd: number;
}

export function groupEvidenceByPage(
  rows: RawEvidenceRow[],
): Map<string, EvidenceExcerpt[]> {
  const byPage = new Map<string, EvidenceExcerpt[]>();
  for (const row of rows) {
    const items = byPage.get(row.pageId) ?? [];
    items.push({
      tripleId: row.tripleId,
      predicate: row.predicate,
      excerpt: row.excerpt,
      spanStart: Number(row.spanStart),
      spanEnd: Number(row.spanEnd),
    });
    byPage.set(row.pageId, items);
  }
  return byPage;
}
