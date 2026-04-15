/**
 * Extract displayable text from an ingestion's raw payload,
 * preferring normalizedText if already computed.
 */
export function extractIngestionText(ingestion: {
  normalizedText: string | null;
  rawPayload: unknown;
}): string {
  if (ingestion.normalizedText) return ingestion.normalizedText;

  const raw = ingestion.rawPayload;
  if (typeof raw === "object" && raw !== null && "content" in raw) {
    return String((raw as Record<string, unknown>).content).trim();
  }
  if (typeof raw === "string") {
    return raw.trim();
  }
  return JSON.stringify(raw);
}
