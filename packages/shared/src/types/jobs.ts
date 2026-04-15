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
