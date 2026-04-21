import type { IngestionAction } from "../constants/index.js";

/** Data passed to the route-classifier job */
export interface RouteClassifierJobData {
  ingestionId: string;
  workspaceId: string;
}

/** Result returned from the route-classifier job */
export interface RouteClassifierJobResult {
  ingestionId: string;
  decisionId: string;
  action: IngestionAction;
  confidence: number;
}

/** Data passed to the patch-generator job */
export interface PatchGeneratorJobData {
  ingestionId: string;
  decisionId: string;
  workspaceId: string;
  targetPageId: string;
  action: "update" | "append";
  /**
   * Snapshot of `pages.current_revision_id` taken at enqueue time (the
   * classifier's view of the page). If the page has advanced past this by
   * the time the patch-generator runs, the job must downgrade the decision
   * to `suggested` with reason `conflict_with_human_edit` instead of
   * auto-applying. `null` means the page had no content yet.
   */
  baseRevisionId: string | null;
}

/** Result returned from the patch-generator job */
export interface PatchGeneratorJobResult {
  ingestionId: string;
  revisionId: string;
  pageId: string;
}

/** Data passed to the publish-renderer job */
export interface PublishRendererJobData {
  snapshotId: string;
  pageId: string;
  revisionId: string;
  workspaceId: string;
}

/** Result returned from the publish-renderer job */
export interface PublishRendererJobResult {
  snapshotId: string;
  htmlSize: number;
  tocEntries: number;
}

/** Data passed to the triple-extractor job */
export interface TripleExtractorJobData {
  pageId: string;
  revisionId: string;
  workspaceId: string;
}

/** Result returned from the triple-extractor job */
export interface TripleExtractorJobResult {
  pageId: string;
  triplesCreated: number;
}

/** Data passed to the search-index-updater job */
export interface SearchIndexUpdaterJobData {
  pageId: string;
  revisionId: string;
  workspaceId: string;
}

/** Result returned from the search-index-updater job */
export interface SearchIndexUpdaterJobResult {
  pageId: string;
  indexed: boolean;
}

/** Data passed to the content-reformatter job */
export interface ContentReformatterJobData {
  pageId: string;
  workspaceId: string;
  requestedByUserId: string;
  instructions?: string | null;
}

/** Result returned from the content-reformatter job */
export interface ContentReformatterJobResult {
  status: "queued" | "skipped" | "already_pending";
  decisionId?: string;
  reason?: string;
}
