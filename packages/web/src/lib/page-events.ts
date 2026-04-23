const EVENT_NAME = "wekiflow:pages-updated";

export interface PagesUpdatedDetail {
  workspaceId: string;
}

export function dispatchPagesUpdated(detail: PagesUpdatedDetail): void {
  window.dispatchEvent(
    new CustomEvent<PagesUpdatedDetail>(EVENT_NAME, { detail }),
  );
}

export function subscribePagesUpdated(
  handler: (detail: PagesUpdatedDetail) => void,
): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<PagesUpdatedDetail>).detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
