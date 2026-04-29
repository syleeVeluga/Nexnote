import type { IngestionDecision } from "@wekiflow/db";

export interface DecisionListRow extends IngestionDecision {
  ingestionSourceName: string;
  ingestionTitleHint: string | null;
  ingestionReceivedAt: Date;
  targetPageTitle: string | null;
  targetPageSlug: string | null;
}

export function mapDecisionListItem(row: DecisionListRow) {
  const rationale = row.rationaleJson as {
    reason?: string;
    conflict?: {
      type: string;
      humanEditedAt: string;
      humanUserId: string | null;
    };
  } | null;
  return {
    id: row.id,
    ingestionId: row.ingestionId,
    targetPageId: row.targetPageId,
    proposedRevisionId: row.proposedRevisionId,
    modelRunId: row.modelRunId,
    action: row.action,
    status: row.status,
    proposedPageTitle: row.proposedPageTitle,
    confidence: row.confidence,
    reason: rationale?.reason ?? null,
    hasConflict: Boolean(rationale?.conflict),
    createdAt: row.createdAt.toISOString(),
    ingestion: {
      id: row.ingestionId,
      sourceName: row.ingestionSourceName,
      titleHint: row.ingestionTitleHint,
      receivedAt: row.ingestionReceivedAt.toISOString(),
    },
    targetPage:
      row.targetPageId && row.targetPageTitle
        ? {
            id: row.targetPageId,
            title: row.targetPageTitle,
            slug: row.targetPageSlug,
          }
        : null,
  };
}
