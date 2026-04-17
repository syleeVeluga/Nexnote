/**
 * Extract displayable text from an ingestion's raw payload,
 * preferring normalizedText if already computed.
 */
const PAYLOAD_TEXT_KEYS = ["content", "text", "markdown", "body"] as const;

export function extractIngestionText(ingestion: {
  normalizedText: string | null;
  rawPayload: unknown;
}): string {
  if (ingestion.normalizedText) return ingestion.normalizedText;

  const raw = ingestion.rawPayload;
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    for (const key of PAYLOAD_TEXT_KEYS) {
      if (key in obj) return String(obj[key]).trim();
    }
  }
  if (typeof raw === "string") {
    return raw.trim();
  }
  return JSON.stringify(raw);
}
