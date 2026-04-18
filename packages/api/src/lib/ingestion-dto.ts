export interface IngestionDtoRow {
  id: string;
  workspaceId: string;
  apiTokenId: string;
  sourceName: string;
  externalRef: string | null;
  idempotencyKey: string;
  contentType: string;
  titleHint: string | null;
  status: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export function mapIngestionDto(row: IngestionDtoRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    apiTokenId: row.apiTokenId,
    sourceName: row.sourceName,
    externalRef: row.externalRef,
    idempotencyKey: row.idempotencyKey,
    contentType: row.contentType,
    titleHint: row.titleHint,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}
