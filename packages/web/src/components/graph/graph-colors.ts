export const NODE_COLORS = {
  person: "#4f46e5",
  organization: "#059669",
  location: "#dc2626",
  product: "#c2410c",
  document: "#0f766e",
  system: "#2563eb",
  technology: "#7c3aed",
  event: "#0891b2",
  concept: "#d97706",
  other: "#6b7280",
} as const;

export type GraphNodeColorType = keyof typeof NODE_COLORS;

export function normalizeGraphNodeType(
  type: string | null | undefined,
): GraphNodeColorType {
  const normalized = type?.trim().toLowerCase();
  return normalized && normalized in NODE_COLORS
    ? (normalized as GraphNodeColorType)
    : "other";
}

export function getNodeColor(type: string | null | undefined): string {
  return NODE_COLORS[normalizeGraphNodeType(type)];
}
