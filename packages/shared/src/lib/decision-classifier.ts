import { CONFIDENCE } from "../constants/index.js";
import type { DecisionStatus, IngestionAction } from "../constants/index.js";

/**
 * Single source of truth for mapping a route-classifier result to a decision
 * status. Shared between the worker (which sets the initial status) and the
 * web UI (which previews what band an incoming decision will land in).
 *
 * Priority: the model's own `noop` / `needs_review` actions always win over
 * confidence thresholds — if the model says it can't decide, trust it even
 * when the confidence number is high.
 */
export function classifyDecisionStatus(
  action: IngestionAction,
  confidence: number,
): DecisionStatus {
  if (action === "noop") return "noop";
  if (action === "needs_review") return "needs_review";
  if (confidence >= CONFIDENCE.AUTO_APPLY) return "auto_applied";
  if (confidence >= CONFIDENCE.SUGGESTION_MIN) return "suggested";
  return "needs_review";
}
