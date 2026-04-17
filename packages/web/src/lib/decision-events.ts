import type { DecisionCounts } from "./api-client";

const EVENT_NAME = "nexnote:decision-counts-updated";

export interface DecisionCountsUpdatedDetail {
  workspaceId: string;
  counts: DecisionCounts;
}

export function dispatchDecisionCountsUpdated(
  detail: DecisionCountsUpdatedDetail,
): void {
  window.dispatchEvent(
    new CustomEvent<DecisionCountsUpdatedDetail>(EVENT_NAME, { detail }),
  );
}

export function subscribeDecisionCountsUpdated(
  handler: (detail: DecisionCountsUpdatedDetail) => void,
): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<DecisionCountsUpdatedDetail>).detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
